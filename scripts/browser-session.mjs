import { chromium } from "playwright-core";
import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const failure = code => Object.assign(new Error(code), { code });

export function stopLoginWhenPagesClose(context, stop) {
  const watched = new WeakSet();
  const watchPage = tab => {
    if (watched.has(tab)) return;
    watched.add(tab);
    tab.once("close", () => {
      if (!context.pages().some(p => !p.isClosed())) stop();
    });
  };
  for (const tab of context.pages()) watchPage(tab);
  context.on("page", watchPage);
}

// 仅显式的人工登录入口可以开窗。播放器读取仍正常运行，但不会发出声音。
export function browserLaunchOptions({ login = false, cdp = false } = {}) {
  return {
    channel: "chrome", headless: !login, viewport: { width: 1440, height: 1000 },
    // 显式启用自动化标识，保证Chrome允许读取实际启动参数，不依赖Playwright版本默认值。
    args: ["--enable-automation", "--mute-audio", ...(cdp ? [
      "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"
    ] : [])]
  };
}

export function localEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw failure("invalid_browser_endpoint"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw failure("nonlocal_browser_endpoint");
  }
  return url.origin;
}

export async function browserEndpoint(directory, env = process.env) {
  // 每日子步骤必须绑定本轮端点；连接文件后来被替换也不能改用另一个浏览器。
  if (env.COLLECTION_BROWSER_ENDPOINT) return localEndpoint(env.COLLECTION_BROWSER_ENDPOINT);
  const connection = JSON.parse(await readFile(resolve(directory, "connection.json"), "utf8"));
  return localEndpoint(connection.endpoint);
}

export async function assertBackgroundBrowser(browser) {
  let session, args;
  try {
    session = await browser.newBrowserCDPSession();
    ({ arguments: args } = await session.send("Browser.getBrowserCommandLine"));
  } catch { throw failure("browser_background_unverified"); }
  finally { await session?.detach().catch(() => {}); }
  if (!Array.isArray(args)) throw failure("browser_background_unverified");
  // 不信任connection.json里的模式，也不根据可伪装的User-Agent判定。
  if (!args.some(a => /^--headless(?:=(?:new|old|chrome))?$/.test(a))) {
    throw failure("visible_browser_in_use");
  }
  if (!args.includes("--mute-audio")) throw failure("browser_audio_not_muted");
}

export async function connectBrowser(endpoint, {
  background = true, timeout = 15_000,
  connectCDP = (url, options) => chromium.connectOverCDP(url, options)
} = {}) {
  const url = localEndpoint(endpoint);
  let browser;
  try { browser = await connectCDP(url, { timeout }); }
  catch { throw failure("browser_unavailable"); }
  try {
    if (background) await assertBackgroundBrowser(browser);
    return browser;
  } catch (error) {
    // connectOverCDP的close仅断开本客户端；绝不对已有浏览器发送Browser.close。
    await browser.close().catch(() => {});
    throw error;
  }
}

export async function reuseBackgroundBrowser(directory, options = {}) {
  let endpoint;
  try { endpoint = await browserEndpoint(directory, {}); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try {
    const browser = await connectBrowser(endpoint, { ...options, background: true });
    return { browser, endpoint };
  } catch (error) {
    // 只有已退出的浏览器可以冷启动；可见或模式不明的活实例必须暂停。
    if (error.code === "browser_unavailable") return null;
    throw error;
  }
}

export async function removeOwnConnection(directory, runId) {
  const path = resolve(directory, "connection.json");
  try {
    const current = JSON.parse(await readFile(path, "utf8"));
    if (current.runId === runId) await unlink(path);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

export async function closeBrowserChild(child, timeout = 10_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(done => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, timeout);
    child.once("exit", () => { clearTimeout(timer); done(); });
    // 先注册exit监听，避免正常退出太快却仍等待10秒。
    if (child.connected) child.send({ action: "close" }, error => { if (error) child.kill("SIGTERM"); });
    else child.kill("SIGTERM");
  });
}
