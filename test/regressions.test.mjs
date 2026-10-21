import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { createSession, decide, normalizeNet, exportSession, hydrateSession } from "../src/local-service/driver.mjs";
import { nextScheduledTask } from "../src/local-service/schedule.mjs";

const rules = [{ folderId: "folder-1", folderName: "AI", keywords: ["test"] }];
const session = () => createSession({ id: "test", platform: "douyin" }, rules);
const managed = () => ({
  dom: { actions: [{ label: "退出管理" }], cards: [] },
  net: { writes: [], reads: [] }
});

test("单次执行只派发一次 click，勾选保持为 true", async () => {
  const text = await readFile(new URL("../src/extension/content/driver.js", import.meta.url), "utf8");
  const fn = text.slice(text.indexOf("function realClick("), text.indexOf("async function execCommand"));
  let clicks = 0;
  const el = { dispatchEvent(e) { if (e.type === "click") clicks++; }, click() { clicks++; } };
  vm.runInNewContext(`${fn}\nrealClick(el)`, { el, window: {}, MouseEvent: class { constructor(type) { this.type = type; } } });
  assert.equal(clicks, 1);
});

test("全部收藏不能被标为未分类并进入移动流程", () => {
  const s = session();
  s.subStep = 1;
  const net = normalizeNet({ reads: [{ url: "/aweme/v1/web/aweme/listcollection/", data: { aweme_list: [{ aweme_id: "123", desc: "test" }] } }] });
  assert.equal(decide(s, { ...managed(), net }).reason, "unclassified_scope_unverified");
  assert.equal(s.done, 0);
});

test("空响应与没有收到响应可区分", () => {
  const net = normalizeNet({ reads: [{ url: "/aweme/v1/web/aweme/listcollection/", data: { aweme_list: [], has_more: 0 } }] });
  assert.equal(net.videoListSeen, true);
  assert.equal(normalizeNet({}).videoListSeen, false);
});

test("管理入口耗尽会阻塞而不是永久空转", () => {
  const s = session();
  s.step = "manage";
  const r = { dom: { actions: [], cards: [] } };
  for (let i = 0; i < 20; i++) decide(s, r);
  assert.equal(s.status, "blocked");
  assert.equal(s.blockedReason, "manage_entry_exhausted");
});

test("页面退出管理后重置已尝试按钮，能够重新进入", () => {
  const s = session();
  Object.assign(s, { step: "item", manageTried: ["批量管理@10,10"], manageClicks: 1, manageObserve: 4 });
  const command = decide(s, { dom: { cards: [], actions: [{ id: "m", label: "批量管理", x: 10, y: 10, w: 80, h: 24 }] } });
  assert.deepEqual(command, { op: "click", id: "m" });
});

test("无关写请求、成功提示、卡片消失都不会增加成功数", () => {
  const s = session();
  Object.assign(s, { step: "item", subStep: 4, items: [{ id: "123", title: "test" }], verifyAfter: Date.now() });
  const r = managed();
  r.net.writes = [{ url: "/unrelated", method: "POST" }];
  r.dom.actions.push({ label: "移动成功" });
  for (let i = 0; i < 8; i++) decide(s, r);
  assert.equal(s.done, 0);
  assert.equal(s.blockedReason, "destination_readback_missing");
});

test("仅操作后的目标夹成员读回可以确认成功；旧缓存及其他文件夹不算", () => {
  const now = Date.now();
  const read = { url: "/aweme/v1/web/collects/video/list/?collects_id=folder-1", capturedAt: now + 1, status: 200,
    data: { status_code: 0, aweme_list: [{ aweme_id: "123" }] } };
  for (const [change, expected] of [
    [{ capturedAt: now - 1 }, 0],
    [{ url: "/aweme/v1/web/collects/video/list/?collects_id=other" }, 0],
    [{ status: 500 }, 0],
    [{ data: { status_code: 8, aweme_list: [{ aweme_id: "123" }] } }, 0],
    [{}, 1]
  ]) {
    const s = session();
    Object.assign(s, { step: "item", subStep: 4, items: [{ id: "123", title: "test" }], verifyAfter: now });
    const r = managed();
    r.net.reads = [{ ...read, ...change }];
    decide(s, r);
    assert.equal(s.done, expected);
  }
});

test("未命中规则保留待决策，不猜测其他文件夹", () => {
  const s = session();
  Object.assign(s, { step: "item", items: [{ id: "123", title: "unmatched" }] });
  assert.equal(decide(s, managed()).op, "noop");
  assert.equal(s.needHuman, 1);
  assert.equal(s.done, 0);
});

test("阻塞状态跨服务重启保留", () => {
  const s = session();
  Object.assign(s, { status: "blocked", blockedReason: "test" });
  const restored = hydrateSession(session(), exportSession(s));
  assert.equal(decide(restored, managed()).reason, "test");
});

test("北京时间9点只触发全量任务；延迟与次日补跑不带时间筛选", () => {
  const config = { platform: "douyin", schedule: { enabled: true, time: "09:00" } };
  assert.equal(nextScheduledTask({ ...config, schedule: { time: "09:00" } }, [], new Date("2026-10-11T03:00:00Z")), null);
  assert.equal(nextScheduledTask(config, [], new Date("2026-10-11T00:59:59Z")), null);
  const task = nextScheduledTask(config, [], new Date("2026-10-11T01:00:00Z"));
  assert.equal(task.scheduledFor, "2026-10-11T01:00:00.000Z");
  assert.equal(task.scope, "all_unclassified");
  assert.equal("cutoffAt" in task, false);
  assert.equal(task.delayed, false);
  const late = nextScheduledTask(config, [], new Date("2026-10-11T15:30:00Z"));
  assert.equal(late.delayed, true);
  assert.equal(late.scheduledFor, task.scheduledFor);
  assert.equal(late.scope, "all_unclassified");
  assert.equal(nextScheduledTask(config, [task], new Date("2026-10-11T15:30:00Z")), null);
  const followingDay = nextScheduledTask(config, [{ ...task, status: "failed" }], new Date("2026-10-12T01:00:00Z"));
  assert.equal(followingDay.scope, "all_unclassified");
  assert.equal(followingDay.scheduleDate, "2026-10-12");
  assert.equal("cutoffAt" in followingDay, false);
});

test("完整未分类快照超过3条全部进入队列；旧视频和历史失败视频不按日期排除", () => {
  const oldItem = { id: "old-failed", title: "test", create_time: 1, collectedAt: "2020-01-01" };
  const items = [oldItem, ...Array.from({ length: 7 }, (_, i) => ({ id: String(i), title: "test" }))];
  const s = createSession({ id: "retry", platform: "douyin", cutoffAt: "2026-10-11T01:00:00Z" }, rules);
  s.subStep = 1;
  const report = managed();
  report.net = { items, videoListSeen: true, scope: "unclassified_verified", writes: [] };
  decide(s, report);
  assert.equal(s.items.length, 8);
  assert.equal(s.items[0].id, "old-failed");
  assert.equal(s.scope, "all_unclassified");
  assert.equal("cutoffAt" in s, false);
  items.push({ id: "arrived-later", title: "test" });
  assert.equal(s.items.length, 8, "本轮集合固化后，新增收藏留给下一轮扫描");
});

test("真实HTTP服务：取消后不复活，未支持的平台拒绝执行，故障上报不推进任务", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collection-test-"));
  await writeFile(join(directory, "state.json"), JSON.stringify({
    config: { platform: "douyin", schedule: { enabled: false } }, devices: [], tasks: [
      { id: "legacy-paused", platform: "douyin", status: "paused", log: [] }
    ]
  }));
  const child = spawn(process.execPath, ["src/local-service/index.mjs"], {
    env: { ...process.env, COLLECTION_AGENT_PORT: "0", COLLECTION_AGENT_DATA_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    // The startup line exposes the actual ephemeral port for isolated integration tests.
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("service startup timeout")), 5000);
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("service exited")); });
      child.stdout.on("data", (data) => {
        const match = String(data).match(/localhost:(\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
      child.stderr.on("data", (data) => { clearTimeout(timeout); reject(new Error(String(data))); });
    });
    const api = async (path, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return { status: res.status, data: await res.json() };
    };
    assert.equal((await api("/tasks", { platform: "unsupported" })).status, 422);
    const task = (await api("/tasks", {})).data;
    assert.equal(task.scope, "all_unclassified");
    assert.equal("cutoffAt" in task, false);
    const report = { url: "https://www.douyin.com/user/self", dom: { actions: [], cards: [{ itemId: "1" }] },
      net: { reads: [], writes: [] }, loginSignals: { urlHasLogin: false, hasLoginPanel: false, hasQr: false } };
    assert.equal((await api("/driver/report", report)).data.command.op, "replay");
    await api(`/tasks/${task.id}/cancel`, {});
    assert.equal((await api("/driver/report", report)).data.command.op, "idle");
    assert.equal((await api("/driver/should-run")).data.run, false);
    assert.equal((await api("/notify/test", {})).status, 500);
    const next = (await api("/tasks", {})).data;
    await api("/driver/report", { clientError: { where: "test", message: "test" } });
    assert.equal((await api("/tasks")).data.find((t) => t.id === next.id).status, "pending");
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
