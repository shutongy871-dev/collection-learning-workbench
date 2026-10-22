import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { setupDaily } from "../../scripts/setup-daily.mjs";
import { acquireLock, readJson, putJson } from "../../scripts/daily.mjs";
import { connectBrowser, browserEndpoint, closeBrowserChild, reuseBackgroundBrowser, browserLaunchOptions } from "../../scripts/browser-session.mjs";
import { recordAccountLogin } from "../../scripts/account-status.mjs";
import { openSelfPage } from "../../scripts/local-scan.mjs";
import { runtimeEnvironment } from "../../scripts/runtime-config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
export async function readCurrentAccount(dataDir, { background = false } = {}) {
  const browserDir = join(dataDir, "local-browser");
  let browser, context, localLock, page, capture, ownContext = false;
  try {
    if (background) {
      await mkdir(browserDir, { recursive: true });
      localLock = await acquireLock(join(browserDir, "execution.lock"));
      if (!localLock) throw new Error("browser_busy");
      const session = await reuseBackgroundBrowser(browserDir, { timeout: 3000 });
      browser = session?.browser;
      context = browser?.contexts()[0];
      if (!browser) {
        context = await chromium.launchPersistentContext(join(browserDir, "profile"), browserLaunchOptions());
        ownContext = true;
      }
    } else {
      const endpoint = await browserEndpoint(browserDir, {});
      browser = await connectBrowser(endpoint, { background: false });
      context = browser.contexts()[0];
    }
    if (!context) throw new Error("browser_context_missing");
    page = await context.newPage();
    const result = await openSelfPage(page, { folders: false });
    capture = result.capture;
    return result.account;
  } finally {
    capture?.stop();
    if (ownContext) await context?.close().catch(() => {});
    else { await page?.close().catch(() => {}); await browser?.close().catch(() => {}); }
    await localLock?.release();
  }
}

export function accountManager({ dataDir, store, readAccount = options => readCurrentAccount(dataDir, options),
  loginHasPages = async () => {
    const endpoint = await browserEndpoint(join(dataDir, "local-browser"), {});
    const browser = await connectBrowser(endpoint, { background: false });
    try { return browser.contexts().some(c => c.pages().some(p => !p.isClosed())); }
    finally { await browser.close(); }
  },
  launchLogin = () => spawn(process.execPath, [resolve(root, "scripts/local-browser.mjs"), "--login"], {
    cwd: root, env: { ...runtimeEnvironment(), COLLECTION_BROWSER_DIR: resolve(dataDir, "local-browser") },
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  }) }) {
  let child, operation = false, automaticCheck, loginError, discovering = false, discoveryAttempted = false;
  const file = join(dataDir, "account-status.json");
  async function status() {
    const verified = await readJson(file, null);
    const config = await readJson(join(dataDir, "daily", "config.json"), null);
    if (child && child.exitCode === null && child.signalCode === null)
      return loginError ? { status: "login_error", error: loginError } : { status: "login_pending" };
    if (discovering) return { status: "checking" };
    if (!verified || verified.accountId !== config?.accountId) return { status: "unverified" };
    const pinned = (await store.read()).sources.find(s => s.platform === "douyin")?.accountId;
    if (pinned && String(pinned) !== String(verified.accountId)) return { status: "unverified" };
    return { status: verified.status, nickname: verified.nickname, checkedAt: verified.checkedAt };
  }
  async function login() {
    if (operation) throw new Error("account_check_busy");
    if (child && child.exitCode === null && child.signalCode === null) {
      if (loginError) return check();
      return { status: "login_pending" };
    }
    operation = true;
    let lock;
    try {
      await mkdir(join(dataDir, "daily"), { recursive: true });
      lock = await acquireLock(join(dataDir, "daily", "execution.lock"));
      if (!lock) throw new Error("collection_busy");
      const endpoint = await readJson(join(dataDir, "local-browser", "connection.json"), null);
      if (endpoint) {
        let browser;
        try { browser = await connectBrowser(endpoint.endpoint, { background: false, timeout: 2000 }); }
        catch (e) { if (e.code !== "browser_unavailable") throw e; }
        if (browser) { await browser.close(); throw new Error("browser_busy"); }
      }
      await putJson(file, { status: "unverified" });
      loginError = undefined;
      const launched = launchLogin();
      child = launched;
      child.once("error", () => { if (child === launched) child = undefined; });
      // The owned login browser signals a trusted live response. Re-read the
      // current identity before binding; never trust account fields from IPC.
      child.on("message", message => {
        if (message?.event !== "login_ready" || child !== launched || operation || automaticCheck) return;
        automaticCheck = check().catch(() => {}).finally(() => { automaticCheck = undefined; });
      });
      return { status: "login_pending" };
    } finally { await lock?.release(); operation = false; }
  }
  async function check({ background = false } = {}) {
    if (operation) throw new Error("account_check_busy");
    operation = true;
    try {
      const initial = await store.read();
      const pinned = initial.sources.find(s => s.platform === "douyin")?.accountId;
      const expected = background ? (await readJson(join(dataDir, "daily", "config.json"), null))?.accountId : null;
      const config = await setupDaily(join(dataDir, "daily"), async () => {
        const account = await readAccount({ background });
        if (pinned && String(pinned) !== String(account.id)) throw new Error("account_changed");
        if (expected && String(expected) !== String(account.id)) throw new Error("account_changed");
        return account;
      });
      const verified = await recordAccountLogin(dataDir,
        { id: config.accountId, nickname: config.accountName }, config.accountId);
      loginError = undefined;
      await closeBrowserChild(child);
      child = undefined;
      return { status: verified.status, nickname: verified.nickname, checkedAt: verified.checkedAt };
    } catch (e) {
      loginError = /account_changed/.test(e.message) ? "account_changed" :
        /platform_forbidden/.test(e.message) ? "platform_forbidden" : "login_read_failed";
      // A failed current read must never display a previously verified account as logged in.
      if (!/browser_busy|another_run_in_progress|visible_browser_in_use/.test(e.code || e.message))
        await putJson(file, { status: "unverified", checkedAt: new Date().toISOString() });
      throw e;
    } finally { operation = false; }
  }
  async function discover() {
    if (discoveryAttempted || operation || child) return status();
    const config = await readJson(join(dataDir, "daily", "config.json"), null);
    if (!config?.accountId) return status();
    discoveryAttempted = true;
    discovering = true;
    try { await check({ background: true }); }
    catch { /* No popup or repeated platform calls; user can log in if needed. */ }
    finally { discovering = false; }
    return status();
  }
  async function prepareForSync() {
    if (automaticCheck) await automaticCheck;
    if (operation) throw new Error("account_check_busy");
    if (loginError === "platform_forbidden") throw new Error("platform_forbidden");
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // Only stop the login child owned by this server. Never close daily Chrome.
    operation = true;
    let hasPages;
    try {
      try { hasPages = await loginHasPages(); }
      catch (e) {
        if (!["ENOENT", "browser_unavailable"].includes(e.code)) throw e;
        hasPages = false;
      }
      if (!hasPages) { await closeBrowserChild(child); child = undefined; }
    } finally { operation = false; }
    if (hasPages) await check(); // Live identity proof before ending an active login session.
  }
  return { status, login, check, discover, prepareForSync, close: async () => {
    if (automaticCheck) await automaticCheck;
    await closeBrowserChild(child);
  } };
}
