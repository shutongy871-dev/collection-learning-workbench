import { chromium } from "playwright-core";
import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { browserLaunchOptions, removeOwnConnection, stopLoginWhenPagesClose } from "./browser-session.mjs";

// 独立浏览器配置目录；不读取、复制用户日常 Chrome 的 Cookie，不加载旧执行插件。
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.some(a => !["--login", "--headless", "--defer-navigation"].includes(a)) ||
    (args.includes("--login") && args.includes("--headless"))) {
  throw new Error("usage: --login | --headless [--defer-navigation]");
}
const loginMode = args.includes("--login");
const dir = resolve(process.env.COLLECTION_BROWSER_DIR || resolve(root, ".data/local-browser"));
const profile = resolve(dir, "profile");
await mkdir(profile, { recursive: true, mode: 0o700 });
const context = await chromium.launchPersistentContext(profile, browserLaunchOptions({ login: loginMode, cdp: true }));
context.setDefaultTimeout(15_000);
const page = context.pages()[0] ?? await context.newPage();
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const records = [];
let pendingWrite = Promise.resolve();
const keys = [
  "status_code", "status_msg", "has_more", "cursor", "max_cursor", "min_cursor", "total",
  "aweme_count", "count", "collects_id", "collects_id_str", "collects_name", "total_number",
  "invalid_item_count", "name", "aweme_id", "id", "desc",
  "aweme_list", "awemes", "collects_list", "collects", "user", "uid", "sec_uid", "nickname",
  "author", "text_extra", "hashtag_name"
];
function project(data) {
  if (Array.isArray(data)) return data.map(project); // 完整数组，不截前12条
  if (!data || typeof data !== "object") return data;
  return Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, project(data[key])]));
}
context.on("response", async (response) => {
  const u = new URL(response.url());
  if (!["www.douyin.com", "www-hj.douyin.com"].includes(u.hostname) ||
      !/\/(collects\/(?:video\/)?list|aweme\/listcollection|user\/profile\/self)\/?$/.test(u.pathname)) return;
  const safeQuery = Object.fromEntries(["cursor", "max_cursor", "count", "collects_id", "collects_ids"]
    .filter((key) => u.searchParams.has(key)).map((key) => [key, u.searchParams.get(key)]));
  const entry = { at: new Date().toISOString(), path: u.pathname, query: safeQuery, status: response.status() };
  entry.method = response.request().method();
  const body = new URLSearchParams(response.request().postData() ?? "");
  entry.body = Object.fromEntries(["cursor", "max_cursor", "count", "collects_id", "collects_ids"]
    .filter((key) => body.has(key)).map((key) => [key, body.get(key)]));
  try {
    const data = await response.json();
    entry.keys = Object.keys(data);
    entry.data = project(data);
  } catch {
    entry.error = "response_not_json";
  }
  records.push(entry);
  // 只落最小业务字段；不写签名、Cookie、请求头、Webhook。原始历史任务保持不动。
  const payload = JSON.stringify({ runId, records }, null, 2);
  pendingWrite = pendingWrite.then(async () => {
    const dest = resolve(dir, `capture-${runId}.json`);
    await writeFile(`${dest}.tmp`, payload, { mode: 0o600 });
    await rename(`${dest}.tmp`, dest);
  }).catch(() => console.error("[capture] write_failed"));
  const list = entry.data?.aweme_list ?? entry.data?.collects_list ?? entry.data?.collects ?? [];
  console.log(JSON.stringify({ path: entry.path, status: entry.status, count: list.length,
    hasMore: entry.data?.has_more, error: entry.error }));
});

// 仅本机可访问的登录预览。POST 校验启动期随机值及来源，防止其他网页触发导航。
const csrf = randomBytes(24).toString("hex");
async function optionalJson(name) {
  try { return JSON.parse(await readFile(resolve(dir, name), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function localProgress() {
  const task = await optionalJson("run-state.json");
  const lock = await optionalJson("execution.lock");
  const audit = await optionalJson("audit-result.json");
  const dailyLock = await optionalJson("../daily/execution.lock");
  const daily = await optionalJson("../daily/latest.json");
  if (daily) return { active: Boolean(dailyLock), status: daily.status,
    verified: daily.verified ?? 0, audit: null };
  return {
    active: Boolean(lock), status: task?.status ?? "idle",
    verified: Object.values(task?.entries ?? {}).filter(e => e.status === "verified").length,
    audit: audit ? { at: audit.at, passed: audit.passed, verified: audit.verified,
      unclassified: audit.currentUnclassified, invalidCount: audit.invalidCount } : null
  };
}
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/") {
      const progress = await localProgress();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>本地收藏整理 · 登录</title>
        <style>html{background:#fff;color:#17202a}body{font:16px system-ui;max-width:1050px;margin:24px auto;padding:0 20px}img{max-width:100%}button,a{margin-right:16px}</style>
        <h1>本地浏览器登录</h1><p>扫码登录抖音后，点击“检查登录”。登录状态仅保存在这台电脑。</p>
        <p>已确认入夹：${progress.verified} 条。${progress.active ? "正在整理，请勿操作执行窗口。" : "当前没有执行中的归类任务。"}</p>
        ${progress.audit?.passed ? `<p>最近一次完整验收通过：未分类 ${progress.audit.unclassified} 条；平台失效内容 ${progress.audit.invalidCount} 条。</p>` : ""}
        <p>这是当前本地 Chrome 窗口的实时截图。此入口不会移动或取消收藏。</p>
        <form method="post" action="/refresh?csrf=${csrf}"><button ${progress.active ? "disabled" : ""}>检查登录</button><a href="/">刷新画面</a></form>
        <img src="/screen.png" alt="本地抖音浏览器当前画面"></html>`);
    } else if (req.method === "GET" && url.pathname === "/screen.png") {
      res.setHeader("Content-Type", "image/png");
      res.end(await page.screenshot());
    } else if (req.method === "GET" && url.pathname === "/status") {
      const progress = await localProgress();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ runId, url: page.url(), responses: records.length,
        accountSeen: records.some((r) => r.data?.user?.sec_uid && r.data?.status_code === 0),
        browserMode: loginMode ? "login" : "background",
        mode: progress.active ? "executing" : "idle", progress }));
    } else if (req.method === "POST" && url.pathname === "/refresh") {
      if (url.searchParams.get("csrf") !== csrf ||
        (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${server.address().port}`)) {
        res.writeHead(403).end(); return;
      }
      if (!loginMode || (await localProgress()).active) { res.writeHead(409).end("background_or_run_in_progress"); return; }
      await page.goto("https://www.douyin.com/user/self?showTab=favorite_collection", { waitUntil: "domcontentloaded" });
      res.writeHead(303, { Location: "/" }).end();
    } else res.writeHead(404).end();
  } catch {
    if (!res.headersSent) res.writeHead(503);
    res.end("browser_not_ready");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const [port, wsPath] = (await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
const endpoint = `http://127.0.0.1:${port}`;
await writeFile(resolve(dir, "connection.json.tmp"), JSON.stringify({
  endpoint, wsPath, preview: `http://127.0.0.1:${server.address().port}`, runId,
  mode: loginMode ? "login" : "background", headless: !loginMode, muted: true
}), { mode: 0o600 });
await rename(resolve(dir, "connection.json.tmp"), resolve(dir, "connection.json"));
console.log(`[local-browser] ${loginMode ? "登录" : "后台状态"}预览 http://127.0.0.1:${server.address().port}`);
console.log(`[local-browser] 已启动${loginMode ? "人工登录窗口" : "无窗口、静音 Chrome"}；浏览器本身不触发归类。`);
let stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    server.close();
    try { await context.close(); }
    finally {
      await pendingWrite;
      await removeOwnConnection(dir, runId);
      if (process.connected) process.disconnect();
    }
  })();
  return stopping;
}
const requestStop = () => { void stop().catch(() => { console.error("browser_shutdown_failed"); process.exitCode = 1; }); };
process.once("SIGTERM", requestStop);
process.once("SIGINT", requestStop);
process.on("message", message => { if (message?.action === "close") requestStop(); });
process.once("disconnect", requestStop);
context.once("close", requestStop);
// macOS may keep Chrome alive after its last window closes. Release our login
// profile at that point so the next background run does not see a phantom window.
if (loginMode) stopLoginWhenPagesClose(context, requestStop);
// 后台调用方安装采集监听后负责首次导航，避免 ready 后立即重复加载同一页面。
if (!process.argv.includes("--defer-navigation")) {
  await page.goto("https://www.douyin.com/user/self?showTab=favorite_collection", { waitUntil: "domcontentloaded" });
}
console.log("[local-browser] ready");
