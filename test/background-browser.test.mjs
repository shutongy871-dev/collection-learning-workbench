import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  browserLaunchOptions, browserEndpoint, connectBrowser, reuseBackgroundBrowser,
  localEndpoint, removeOwnConnection
} from "../scripts/browser-session.mjs";

function fakeBrowser(args, error) {
  const calls = { disconnected: 0, detached: 0, commands: [] };
  return { calls, browser: {
    newBrowserCDPSession: async () => ({
      send: async method => { calls.commands.push(method); if (error) throw error; return { arguments: args }; },
      detach: async () => { calls.detached++; }
    }),
    close: async () => { calls.disconnected++; }
  } };
}
async function fixture(t, connection) {
  const dir = await mkdtemp(join(tmpdir(), "background-browser-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (connection) await writeFile(join(dir, "connection.json"), JSON.stringify(connection));
  return dir;
}

test("所有自动启动默认无窗口和静音，只有显式人工登录可开窗", () => {
  for (const options of [undefined, { cdp: true }]) {
    const launch = browserLaunchOptions(options);
    assert.equal(launch.headless, true);
    assert.ok(launch.args.includes("--mute-audio"));
  }
  assert.equal(browserLaunchOptions({ login: true }).headless, false);
});

test("非本机、凭证及路径端点在连接前被拒绝", async () => {
  for (const value of ["https://example.com", "http://localhost:9222", "file:///tmp/a",
    "http://127.0.0.1:9222/path", "http://user:pass@127.0.0.1:9222", "http://127.0.0.1:9222/?x=1"]) {
    await assert.rejects(connectBrowser(value, { connectCDP: () => assert.fail("不得连接") }), /browser_endpoint/);
  }
  assert.equal(localEndpoint("http://127.0.0.1:9222/"), "http://127.0.0.1:9222");
});

test("子步骤绑定端点，连接记录被替换也不会跟随或回退", async t => {
  const dir = await fixture(t, { endpoint: "http://127.0.0.1:9333" });
  assert.equal(await browserEndpoint(dir, { COLLECTION_BROWSER_ENDPOINT: "http://127.0.0.1:9222" }),
    "http://127.0.0.1:9222");
  await assert.rejects(browserEndpoint(dir, { COLLECTION_BROWSER_ENDPOINT: "invalid" }), /invalid_browser_endpoint/);
});

test("核验真实启动参数：可见窗口、非静音及无法证明模式的实例均断开", async () => {
  for (const [args, error, code] of [
    [["--mute-audio"], null, "visible_browser_in_use"],
    [["--headless=new"], null, "browser_audio_not_muted"],
    [null, null, "browser_background_unverified"],
    [null, Error("method denied"), "browser_background_unverified"]
  ]) {
    const { browser, calls } = fakeBrowser(args, error);
    await assert.rejects(connectBrowser("http://127.0.0.1:9222", { connectCDP: async () => browser }), { code });
    assert.equal(calls.disconnected, 1);
    assert.equal(calls.detached, 1);
    assert.deepEqual(calls.commands, ["Browser.getBrowserCommandLine"]); // 没有Browser.close或页面指令。
  }
});

test("已核验的静默实例可复用；人工setup可以显式读取登录窗口", async () => {
  const { browser, calls } = fakeBrowser(["--headless=new", "--mute-audio"]);
  assert.equal(await connectBrowser("http://127.0.0.1:9222", { connectCDP: async () => browser }), browser);
  assert.equal(calls.disconnected, 0);
  const manual = fakeBrowser([]);
  assert.equal(await connectBrowser("http://127.0.0.1:9222",
    { background: false, connectCDP: async () => manual.browser }), manual.browser);
  assert.deepEqual(manual.calls.commands, []);
});

test("伪造headless元数据也不能让后台接管可见窗口或触发冷启动", async t => {
  const dir = await fixture(t, { endpoint: "http://127.0.0.1:9222", headless: true, mode: "background" });
  const { browser, calls } = fakeBrowser(["--mute-audio"]);
  await assert.rejects(reuseBackgroundBrowser(dir, { connectCDP: async () => browser }),
    { code: "visible_browser_in_use" });
  assert.equal(calls.disconnected, 1);
});

test("仅连接记录缺失或浏览器已退出时允许冷启动", async t => {
  const dir = await fixture(t);
  assert.equal(await reuseBackgroundBrowser(dir), null);
  await writeFile(join(dir, "connection.json"), JSON.stringify({ endpoint: "http://127.0.0.1:9222" }));
  assert.equal(await reuseBackgroundBrowser(dir, { connectCDP: async () => { throw Error("ECONNREFUSED"); } }), null);
});

test("退出仅删除本轮连接记录，保留后来启动的实例记录", async t => {
  const dir = await fixture(t, { runId: "new" });
  await removeOwnConnection(dir, "old");
  assert.equal(JSON.parse(await readFile(join(dir, "connection.json"))).runId, "new");
  await removeOwnConnection(dir, "new");
  await assert.rejects(readFile(join(dir, "connection.json")), { code: "ENOENT" });
  await removeOwnConnection(dir, "new");
});
