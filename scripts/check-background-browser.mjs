// 实际Chrome、隔离profile、本地页面与模拟平台响应；全程无可见窗口，无真实平台请求。
import assert from "node:assert/strict";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { runtimeEnvironment } from "./runtime-config.mjs";
import { connectBrowser, closeBrowserChild } from "./browser-session.mjs";
import { connect } from "./local-scan.mjs";
import { captureContent } from "./capture-content.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, ".data/background-verification/runs", new Date().toISOString().replace(/[:.]/g, "-"));
const directory = join(output, "local-browser");
await mkdir(directory, { recursive: true, mode: 0o700 });
const report = { startedAt: new Date().toISOString(), status: "running", checks: [],
  visibleWindowsLaunched: 0, platformRequests: 0, platformWrites: 0 };
const pass = name => { report.checks.push(name); console.log(`通过：${name}`); };
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end('<!doctype html><button onclick="document.body.dataset.filed=\'true\'">归类（测试）</button>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}`;
let child, log, browser;
const originalEndpoint = process.env.COLLECTION_BROWSER_ENDPOINT;
async function start() {
  log = await open(join(output, `browser-${report.checks.length}.log`), "a", 0o600);
  child = spawn(process.execPath, ["scripts/local-browser.mjs", "--headless", "--defer-navigation"], {
    cwd: root, env: { ...runtimeEnvironment(), COLLECTION_BROWSER_DIR: directory },
    stdio: ["ignore", "pipe", log.fd, "ipc"]
  });
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(Error("browser_ready_timeout")), 45000);
    let text = "";
    const reject = error => { clearTimeout(timer); fail(error); };
    child.once("error", reject);
    child.once("exit", code => reject(Error(`browser_start_failed:${code}`)));
    child.stdout.on("data", data => {
      void log.write(data).catch(() => {});
      text = (text + data).slice(-4000);
      if (text.includes("[local-browser] ready")) { clearTimeout(timer); done(); }
    });
  });
  const connection = JSON.parse(await readFile(join(directory, "connection.json"), "utf8"));
  assert.equal(connection.mode, "background");
  browser = await connectBrowser(connection.endpoint);
  process.env.COLLECTION_BROWSER_ENDPOINT = connection.endpoint;
}
async function stop() {
  await browser?.close();
  browser = null;
  await closeBrowserChild(child);
  assert.equal(child.exitCode, 0, "必须正常IPC退出，不能靠SIGKILL");
  assert.equal(child.signalCode, null);
  child = null;
  await log?.close();
  log = null;
  await assert.rejects(readFile(join(directory, "connection.json")), { code: "ENOENT" });
}
try {
  await start();
  pass("冷启动实际Chrome，CDP核实headless与mute-audio");
  const { browser: client, page } = await connect();
  await page.goto(url);
  await page.getByRole("button").click();
  assert.equal(await page.getAttribute("body", "data-filed"), "true");
  await page.evaluate(() => localStorage.setItem("persistence-check", "retained"));
  await page.context().addCookies([{ name: "login-test", value: "retained", url, expires: Date.now() / 1000 + 3600 }]);
  await client.close();
  // CDP disconnect不能关闭底层窗口/进程；重复连接并读取原页验证这一语义。
  assert.equal(browser.contexts()[0].pages()[0].url(), `${url}/`);
  pass("扫描连接绑定本轮端点、无窗口UI点击、CDP断开保留实例");

  // 真实采集入口复用headless；所有平台请求由本地fixture满足。
  const context = browser.contexts()[0];
  const pageCount = context.pages().length;
  let accountReads = 0, fixtureRequests = 0;
  await context.route("**/*", async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== "www.douyin.com") return route.abort();
    fixtureRequests++;
    if (requestUrl.pathname.endsWith("/user/profile/self/")) {
      accountReads++;
      return route.fulfill({ json: { status_code: 0, user: { uid: "fixture-account" } } });
    }
    if (requestUrl.pathname.endsWith("/comment/list/")) return route.fulfill({
      json: { status_code: 0, comments: [{ cid: "comment-fixture", text: "测试评论" }] }
    });
    const api = requestUrl.pathname.startsWith("/video/") ?
      "/aweme/v1/web/comment/list/?aweme_id=fixture-video" : "/aweme/v1/web/user/profile/self/";
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><script>fetch(${JSON.stringify(api)})</script>` });
  });
  const result = await captureContent({ dataDir: output, config: {}, item: {
    id: "fixture-video", key: "fixture-key", accountId: "fixture-account", title: "搞笑合集"
  } });
  assert.equal(result.comments, 1);
  assert.equal(accountReads, 1);
  assert.equal(context.pages().length, pageCount);
  report.fixtureRequests = fixtureRequests;
  await context.unrouteAll({ behavior: "wait" });
  pass("真实内容采集入口读取模拟账号/评论，采集后释放页面与锁");
  await stop();
  pass("IPC正常退出并移除本轮连接记录");

  await start();
  const restored = browser.contexts()[0].pages()[0];
  await restored.goto(url);
  assert.equal(await restored.evaluate(() => localStorage.getItem("persistence-check")), "retained");
  assert.ok((await restored.context().cookies(url)).some(c => c.name === "login-test" && c.value === "retained"));
  pass("持久profile重启后Cookie和本地登录存储保留");
  await stop();
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await closeBrowserChild(child);
  await log?.close();
  server.close();
  if (originalEndpoint === undefined) delete process.env.COLLECTION_BROWSER_ENDPOINT;
  else process.env.COLLECTION_BROWSER_ENDPOINT = originalEndpoint;
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
}
console.log(`${report.status}：${join(output, "result.json")}`);
if (report.error) console.error(report.error);
