import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setupDaily } from "../../scripts/setup-daily.mjs";
import { acquireLock, readJson, putJson } from "../../scripts/daily.mjs";
import { connectBrowser, browserEndpoint, closeBrowserChild } from "../../scripts/browser-session.mjs";
import { openSelfPage } from "../../scripts/local-scan.mjs";
import { runtimeEnvironment } from "../../scripts/runtime-config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
export async function readCurrentAccount(dataDir) {
  const endpoint = await browserEndpoint(join(dataDir, "local-browser"), {});
  const browser = await connectBrowser(endpoint, { background: false });
  let page, capture;
  try {
    page = await browser.contexts()[0].newPage();
    const result = await openSelfPage(page, { folders: false });
    capture = result.capture;
    return result.account;
  } finally { capture?.stop(); await page?.close(); await browser.close(); }
}

export function accountManager({ dataDir, store, readAccount = () => readCurrentAccount(dataDir),
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
  let child, operation = false;
  const file = join(dataDir, "account-status.json");
  async function status() {
    const verified = await readJson(file, null);
    const config = await readJson(join(dataDir, "daily", "config.json"), null);
    if (child && child.exitCode === null && child.signalCode === null) return { status: "login_pending" };
    if (!verified || verified.accountId !== config?.accountId) return { status: "unverified" };
    return { status: verified.status, nickname: verified.nickname, checkedAt: verified.checkedAt };
  }
  async function login() {
    if (operation) throw new Error("account_check_busy");
    if (child && child.exitCode === null && child.signalCode === null) return { status: "login_pending" };
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
      const launched = launchLogin();
      child = launched;
      child.once("error", () => { if (child === launched) child = undefined; });
      return { status: "login_pending" };
    } finally { await lock?.release(); operation = false; }
  }
  async function check() {
    if (operation) throw new Error("account_check_busy");
    operation = true;
    try {
      const initial = await store.read();
      const pinned = initial.sources.find(s => s.platform === "douyin")?.accountId;
      const config = await setupDaily(join(dataDir, "daily"), async () => {
        const account = await readAccount();
        if (pinned && String(pinned) !== String(account.id)) throw new Error("account_changed");
        return account;
      });
      const verified = { status: "verified", accountId: config.accountId, nickname: config.accountName,
        checkedAt: config.at };
      await putJson(file, verified);
      await closeBrowserChild(child);
      child = undefined;
      return { status: verified.status, nickname: verified.nickname, checkedAt: verified.checkedAt };
    } catch (e) {
      // A failed current read must never display a previously verified account as logged in.
      await putJson(file, { status: "unverified", checkedAt: new Date().toISOString() });
      throw e;
    } finally { operation = false; }
  }
  async function prepareForSync() {
    if (operation) throw new Error("account_check_busy");
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
  return { status, login, check, prepareForSync, close: () => closeBrowserChild(child) };
}
