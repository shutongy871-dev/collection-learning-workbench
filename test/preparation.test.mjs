import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { learningPreparation } from "../src/learning/preparation.mjs";
import { emptyState } from "../src/learning/import.mjs";
import { learningStore } from "../src/learning/store.mjs";
import { startLearningServer } from "../src/learning/server.mjs";
import { contentConfig, questionConfig } from "../src/understanding/config.mjs";
import { configureBatch, batchStatus } from "../src/learning/batch.mjs";
import { dayKey } from "../src/learning/domain.mjs";

const item = { key: "douyin:synthetic:preparation", platform: "douyin", id: "preparation", accountId: "synthetic", title: "测试知识原理讲解",
  description: "主动回忆后再检查遗漏。", hashtags: [], firstSeenAt: new Date().toISOString() };
const models = () => ({ content: contentConfig({}), question: { ...questionConfig({}),
  apiKey: "synthetic-only", model: "synthetic-only", maxCostCny: .01,
  inputCnyPerMillion: .1, outputCnyPerMillion: .1 } });
const batch = () => ({ ledger: { days: {}, items: {} } });
const state = () => ({ ...emptyState(), items: [item], cards: {} });
test("准备状态区分未启动、缺配置、真实运行、失败和每日限制", () => {
  const s = state(), b = batch(), plan = { items: [item], remainingCny: .25 };
  assert.equal(learningPreparation(s, b, { plan }).status, "idle");
  assert.equal(learningPreparation(s, b, { plan, modelError: "question_not_configured" }).status, "needs_configuration");
  assert.equal(learningPreparation(s, b, { active: true }).status, "preparing");
  b.ledger.days[dayKey(Date.now())] = { entries: { failed: { status: "blocked", error: "platform_forbidden" } } };
  assert.deepEqual(learningPreparation(s, b, { plan }), { status: "blocked", error: "platform_forbidden" });
  assert.equal(learningPreparation(s, batch(), { plan: { items: [], remainingCny: 0 } }).error, "daily_budget_limit");
  assert.equal(learningPreparation(s, batch(), { plan: {
    items: [], remainingCny: .1, eligibleItems: 1, remainingItems: 0 } }).error, "daily_item_limit");
  assert.equal(learningPreparation(emptyState(), batch()).status, "empty_library");
});
test("已有到期题目可直接学习，不被缺少密钥或后台失败阻塞", () => {
  const s = state();
  s.questions = [{ id: "synthetic-question", itemKey: item.key }];
  s.progress[item.key] = {};
  s.cards["synthetic-question"] = { card: { due: new Date(Date.now() - 1000).toISOString() } };
  assert.equal(learningPreparation(s, batch(), { modelError: "question_not_configured", taskError: "browser_busy" }).status, "ready");
});
test("修复模型配置后，旧配置错误不阻止新任务", () => {
  const b = batch();
  b.latest = { date: dayKey(Date.now()), error: "question_not_configured" };
  assert.equal(learningPreparation(state(), b, { plan: { items: [item], remainingCny: .25 } }).status, "idle");
});
async function setup(t, options = {}) {
  const { initialItems = [item], ...serverOptions } = options;
  await mkdir(resolve(".data"), { recursive: true });
  const dataDir = await mkdtemp(resolve(".data/preparation-test-"));
  const store = learningStore(dataDir);
  await store.mutate(s => { s.items = initialItems; });
  const server = await startLearningServer({ dataDir, port: 0, importOnStart: false, getModelConfig: models, ...serverOptions });
  t.after(async () => { await new Promise(r => server.close(r)); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, post = false) => (await fetch(`${origin}/api/learning/${path}`,
    post ? { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" } : {})).json();
  return { dataDir, request, origin };
}
test("缺密钥时点击学习返回配置要求，不抓视频、不占用每日处理名额", async t => {
  let captures = 0;
  const { request, dataDir } = await setup(t, {
    getModelConfig: () => ({ ...models(), question: questionConfig({}) }),
    batchAdapters: { captureContent: async () => { captures++; } }
  });
  assert.equal((await request("start", true)).status, "needs_configuration");
  assert.equal((await request("preparation")).status, "needs_configuration");
  assert.equal(captures, 0);
  assert.deepEqual((await batchStatus(dataDir)).ledger.days, {});
});
test("点击学习实际启动一次任务，重复点击和轮询不重启；失败反馈明确", { timeout: 5000 }, async t => {
  let captures = 0, release, entered;
  const gate = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
  const { request } = await setup(t, { batchAdapters: { captureContent: async () => {
    captures++; entered(); await gate; throw Object.assign(Error("platform_forbidden"), { code: "platform_forbidden" });
  } } });
  assert.equal((await request("preparation")).status, "idle");
  assert.equal(captures, 0);
  assert.equal((await request("start", true)).status, "preparing");
  await ready;
  try {
    assert.equal((await request("start", true)).status, "preparing");
    assert.equal((await request("preparation")).status, "preparing");
    assert.equal(captures, 1);
  } finally { release(); }
  let result;
  for (let i = 0; i < 100; i++) {
    result = await request("preparation");
    if (result.status !== "preparing") break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.deepEqual(result, { status: "blocked", error: "platform_forbidden" });
  assert.equal((await request("start", true)).status, "blocked");
  assert.equal(captures, 1);
});
test("每日预算用尽时点击学习不启动视频抓取", async t => {
  let captures = 0;
  const { dataDir, request } = await setup(t, { batchAdapters: { captureContent: async () => { captures++; } } });
  await configureBatch(dataDir, { budgetCnyPerDay: 0 });
  assert.equal((await request("start", true)).error, "daily_budget_limit");
  assert.equal(captures, 0);
});
test("同步分类完成后自动启动新收藏的内容准备，无需点击开始学习", { timeout: 5000 }, async t => {
  let captures = 0;
  const { origin } = await setup(t, {
    initialItems: [], autoPrepare: true,
    classificationRunner: async ({ dataDir }) => {
      await mkdir(join(dataDir, "local-browser"), { recursive: true });
      await writeFile(join(dataDir, "local-browser", "snapshot.json"), JSON.stringify({
        at: new Date().toISOString(), platform: "douyin", account: { id: "synthetic" },
        favorites: [{ id: item.id, title: item.title, description: item.description }],
        folders: [], complete: true, expectedFavorites: 1
      }));
      return { status: "completed", scanned: 1, verified: 0 };
    },
    batchAdapters: { captureContent: async () => {
      captures++;
      throw Object.assign(Error("platform_forbidden"), { code: "platform_forbidden" });
    } }
  });
  for (let i = 0; i < 100; i++) {
    if (!(await (await fetch(`${origin}/api/batch`)).json()).active) break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(captures, 0);
  await fetch(`${origin}/api/collection-sync`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: "{}" });
  let b;
  for (let i = 0; i < 100; i++) {
    b = await (await fetch(`${origin}/api/batch`)).json();
    if (!b.active && b.latest?.error === "platform_forbidden") break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(captures, 1);
  assert.equal(b.latest.error, "platform_forbidden");
  assert.equal((await (await fetch(`${origin}/api/state`)).json()).items.length, 1);
});
