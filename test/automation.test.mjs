import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { emptyState } from "../src/learning/import.mjs";
import { learningStore } from "../src/learning/store.mjs";
import { startLearningServer } from "../src/learning/server.mjs";
import { dueQuestions } from "../src/learning/domain.mjs";
import { normalizeLearning } from "../src/learning/scheduler.mjs";
import { contentConfig, questionConfig } from "../src/understanding/config.mjs";
import { atomicJSON, digest, itemDirectory } from "../src/understanding/pipeline.mjs";
import { execute, fail } from "../src/understanding/media.mjs";
import { currentSources, decideDraft, generateQuestions, questionReservation, questionSources, requestQuestions, validateGenerated } from "../src/learning/generator.mjs";
import { batchStatus, configureBatch, planBatch, runContentBatch } from "../src/learning/batch.mjs";

const text = "主动回忆是先尝试用自己的话复述，再对照原文检查遗漏。";
const sample = { key: "douyin:test:1", id: "1", accountId: "test", platform: "douyin", title: "知识原理讲解",
  description: text, hashtags: [], categories: ["通识与生活"], firstSeenAt: "2026-10-20T00:00:00Z" };
const rawQuestion = (sourceId = "description", evidence = text, prompt = "按照原文，主动回忆应先做什么？") => ({
  prompt, options: ["尝试复述", "删除原文", "只读标题", "只看答案"], answer: 0, evidence,
  explanation: "原文说明先用自己的话复述，再核对。", sourceId
});
const qconfig = () => ({ ...questionConfig({}), apiKey: "test-only", model: "test-only", maxCostCny: .01,
  inputCnyPerMillion: .1, outputCnyPerMillion: .1 });
const models = () => ({ content: { ...contentConfig({}), asrRateCnyPerMinute: 0 }, question: qconfig() });
async function fixture(t, items = [sample]) {
  await mkdir(resolve(".data"), { recursive: true });
  const dir = await mkdtemp(resolve(".data/automation-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = learningStore(dir);
  await store.mutate(s => { s.items = structuredClone(items); });
  return { dir, store };
}
async function http(t, dir) {
  const server = await startLearningServer({ dataDir: dir, importOnStart: false, port: 0, getModelConfig: models });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, get: async path => (await fetch(`${origin}/api/${path}`)).json(),
    post: async (path, data) => {
      const r = await fetch(`${origin}/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemKey: sample.key, ...data }) });
      return { status: r.status, data: await r.json() };
    } };
}
function generatedAdapter(counter, extra = {}) {
  return { requestQuestions: async spans => {
    counter.calls++;
    return { costCny: .002, result: validateGenerated({ questions: [rawQuestion(spans[0].id, spans[0].text)] }, spans), ...extra };
  } };
}

test("迁移v1逐题保留到期时间与心得事件，不伪造FSRS历史", () => {
  const q = { ...rawQuestion(), id: "old", itemKey: sample.key };
  const state = { ...emptyState(), items: [sample], questions: [q], progress: { [sample.key]: { dueAt: "2026-10-25T00:00:00Z", reviews: 8 } },
    notes: { [sample.key]: { text: "保留" } }, events: [{ id: "legacy-event" }] };
  const result = normalizeLearning(state);
  assert.equal(result.version, 2);
  assert.equal(result.cards.old.card.reps, 0);
  assert.equal(result.cards.old.card.stability, 0);
  assert.equal(new Date(result.cards.old.card.due).toISOString(), "2026-10-25T00:00:00.000Z");
  assert.equal(result.progress[sample.key].reviews, 8);
  assert.equal(result.notes[sample.key].text, "保留");
  assert.equal(result.events.length, 1);
  assert.equal(result.fsrs.parameters.w.length, 21);
});

test("同收藏两题独立排程，四档使用持久预览；答错强制Again且幂等", async t => {
  const { dir, store } = await fixture(t);
  await store.mutate(s => {
    s.questions = ["one", "two"].map(id => ({ ...rawQuestion(), id, itemKey: sample.key }));
  });
  const { get, post } = await http(t, dir);
  await post("enroll", {});
  const before = await get("state");
  assert.equal(dueQuestions(before.items, before.progress, before.questions, before.cards).length, 2);
  const a = (await post("answer", { questionId: "one", attemptId: "first-attempt", choice: 0 })).data;
  assert.deepEqual(Object.keys(a.previews), ["again", "hard", "good", "easy"]);
  const b = (await post("answer", { questionId: "two", attemptId: "other-attempt", choice: 1 })).data;
  assert.notEqual(a.attemptId, b.attemptId);
  await post("review", { attemptId: a.attemptId, rating: "easy" });
  let after = await get("state");
  assert.equal(after.cards.one.card.due, a.previews.easy.card.due);
  assert.equal(after.cards.two.card.due, before.cards.two.card.due);
  assert.deepEqual(dueQuestions(after.items, after.progress, after.questions, after.cards).map(q => q.id), ["two"]);
  assert.equal((await post("answer", { questionId: "one", attemptId: "too-early-now", choice: 0 })).status, 409);
  await post("review", { attemptId: b.attemptId, rating: "easy" });
  await post("review", { attemptId: b.attemptId, rating: "good" });
  after = await store.read();
  assert.equal(after.cards.two.card.due, b.previews.again.card.due);
  assert.equal(after.events.length, 2);
  assert.equal(after.events[1].rating, "again");
  assert.equal(after.events[1].requestedRating, "easy");
  assert.equal(after.events[1].fsrs.parameters.request_retention, .9);
});

test("两个HTTP服务与独立Node进程共用学习库，不覆盖并发写入；重启读取最新状态", async t => {
  const { dir, store } = await fixture(t), a = await http(t, dir), b = await http(t, dir);
  const module = pathToFileURL(resolve("src/learning/store.mjs")).href;
  const script = `const {learningStore}=await import(process.argv[1]);const store=learningStore(process.argv[2]);
    for(let n=0;n<8;n++)await store.mutate(s=>{s.notes[process.argv[3]+n]={text:"worker"};});`;
  await Promise.all([
    execute(process.execPath, ["--input-type=module", "-e", script, module, dir, "worker-a"]),
    execute(process.execPath, ["--input-type=module", "-e", script, module, dir, "worker-b"]),
    a.post("note", { text: "HTTP保留" }), b.post("excerpt", { text: "这是并发修改的原文摘录" })
  ]);
  const state = await store.read();
  assert.equal(Object.keys(state.notes).length, 17);
  assert.equal(state.notes[sample.key].text, "HTTP保留");
  assert.equal(state.excerpts[sample.key], "这是并发修改的原文摘录");
  assert.equal((await b.get("state")).notes[sample.key].text, "HTTP保留");
});

test("出题凭证不跨提供方/端点复用；缺模型或价格不能调用", () => {
  const env = { CONTENT_VISION_API_KEY: "private-value", CONTENT_VISION_PROVIDER: "qwen",
    CONTENT_VISION_MODEL: "qwen-vl-plus", CONTENT_VISION_MAX_COST_CNY: ".02",
    CONTENT_VISION_INPUT_CNY_PER_MILLION: ".8", CONTENT_VISION_OUTPUT_CNY_PER_MILLION: "2" };
  const shared = questionConfig(env);
  assert.equal(shared.apiKey, "private-value");
  assert.equal(shared.model, "qwen-vl-plus");
  assert.equal(shared.maxCostCny, .02);
  assert.equal(shared.inputCnyPerMillion, .8);
  assert.equal(shared.outputCnyPerMillion, 2);
  assert.equal(questionConfig({ ...env, CONTENT_QUESTION_PROVIDER: "doubao" }).apiKey, "");
  assert.equal(questionConfig({ ...env, CONTENT_QUESTION_BASE_URL: "https://different.example/v1" }).apiKey, "");
  assert.throws(() => questionReservation(questionConfig({})), /question_not_configured/);
  assert.throws(() => questionReservation({ ...qconfig(), maxCostCny: null }), /question_pricing_missing/);
  assert.throws(() => questionReservation({ ...qconfig(), maxCostCny: 0 }), /question_reservation_too_small/);
});
test("仅标题、评论或低质量转写不形成出题证据；时间与资产由程序绑定", () => {
  assert.equal(questionSources({ ...sample, description: "" }, "", { status: "completed", comments: [{ text }] }).spans.length, 0);
  const job = { id: "job", version: "v1", status: "completed", asset: { hash: "asset" },
    stages: { asr: { segments: [{ id: "asr-1", text, assetId: "asset", startMs: 1000, endMs: 8000 }] } } };
  const source = questionSources({ ...sample, description: "" }, "", job);
  assert.equal(source.spans[0].startMs, 1000);
  assert.equal(source.spans[0].assetId, "asset");
  assert.equal(questionSources({ ...sample, description: "" }, "", { ...job, status: "needs_review" }).spans.length, 0);
});
test("模型错误引用、重复选项、重复题与注入发布字段均不能成为草稿", () => {
  const spans = [{ id: "description", text }];
  for (const change of [{ sourceId: "invented" }, { evidence: "这是凭空编造的引用内容" },
    { options: ["Ａ", "A", "B", "C"] }, { status: "approved" }, { sourceSpans: [] }, { answer: 4 }]) {
    assert.throws(() => validateGenerated({ questions: [{ ...rawQuestion(), ...change }] }, spans));
  }
  assert.throws(() => validateGenerated({ questions: [rawQuestion(), rawQuestion()] }, spans), /duplicate_question/);
});
test("HTTP适配器即使输出截断或不合格也核算费用，缺usage不当作零成本", async () => {
  const spans = [{ id: "description", text }];
  for (const finish of ["length", "stop"]) {
    const result = await requestQuestions(spans, qconfig(), async (_url, options) => {
      assert.equal(JSON.parse(options.body).messages[0].role, "system");
      return Response.json({ usage: { prompt_tokens: 1000, completion_tokens: 100 }, choices: [{
        finish_reason: finish, message: { content: JSON.stringify({ questions: [{ ...rawQuestion(), sourceId: "invented" }] }) }
      }] });
    });
    assert.equal(result.costCny, .00011);
    assert.ok(result.error);
  }
  const result = await requestQuestions(spans, qconfig(), async () => Response.json({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ questions: [rawQuestion()] }) } }] }));
  assert.equal(result.costCny, null);
});
test("生成去重、草稿隔离、批准/拒绝幂等；不泄露证据，摘录变化后拒绝批准旧草稿", async t => {
  const { dir, store } = await fixture(t), counter = { calls: 0 };
  const args = { dataDir: dir, itemKey: sample.key, config: qconfig(), adapters: generatedAdapter(counter) };
  const first = await generateQuestions(args);
  assert.equal(first.status, "completed");
  await generateQuestions(args);
  assert.equal(counter.calls, 1);
  const api = await http(t, dir);
  let visible = await api.get("state");
  assert.equal(visible.questions.length, 0); assert.equal(visible.drafts, undefined);
  assert.equal(visible.draftCounts[sample.key], 1);
  const draftId = first.questions[0].id;
  await store.mutate(s => decideDraft(dir, s, draftId, "reject"));
  await store.mutate(s => decideDraft(dir, s, draftId, "reject"));
  await generateQuestions(args);
  assert.equal((await store.read()).drafts[draftId].status, "rejected");
  const updated = { ...args, config: { ...qconfig(), model: "next-model" } };
  const second = await generateQuestions(updated);
  await store.mutate(s => { s.excerpts[sample.key] = "这是新增的原文摘录，导致证据版本发生变化。"; });
  await assert.rejects(() => store.mutate(s => decideDraft(dir, s, second.questions[0].id, "approve")), /draft_source_changed/);
  const third = await generateQuestions(args);
  const id = third.questions[0].id;
  assert.equal((await api.post("draft", { draftId: id, decision: "approve" })).status, 200);
  assert.equal((await api.post("draft", { draftId: id, decision: "approve" })).status, 200);
  visible = await api.get("state");
  assert.equal(visible.questions.length, 1);
  for (const name of ["answer", "evidence", "explanation", "sourceSpans", "sourceHash"])
    assert.equal(visible.questions[0][name], undefined);
  // Approved evidence is a snapshot and remains answerable after the source excerpt changes.
  await api.post("excerpt", { text: "" });
  await api.post("enroll", {});
  assert.equal((await api.post("answer", { questionId: id, attemptId: "snapshot-answer", choice: 0 })).status, 200);
});
test("转写出题按不可变sourceSpans判题，无需把转写复制进正文", async t => {
  const { dir, store } = await fixture(t, [{ ...sample, description: "" }]);
  const directory = itemDirectory(dir, sample.key);
  await mkdir(directory, { recursive: true });
  await atomicJSON(join(directory, "latest.json"), { id: "transcript-job", version: "v1", status: "completed",
    asset: { hash: "a".repeat(64) }, stages: { asr: { segments: [{ id: "asr-1", text, assetId: "a".repeat(64), startMs: 0, endMs: 10000 }] } } });
  const job = await generateQuestions({ dataDir: dir, itemKey: sample.key, config: qconfig(), adapters: generatedAdapter({ calls: 0 }) });
  await store.mutate(s => decideDraft(dir, s, job.questions[0].id, "approve"));
  const api = await http(t, dir);
  await api.post("enroll", {});
  const result = await api.post("answer", { questionId: job.questions[0].id, attemptId: "asr-evidence-answer", choice: 0 });
  assert.equal(result.status, 200); assert.equal(result.data.sourceSpans[0].startMs, 0);
});
test("出题崩溃恢复复用已保存响应；未知结果和无usage均禁止再次收费", async t => {
  const { dir } = await fixture(t), counter = { calls: 0 };
  const args = { dataDir: dir, itemKey: sample.key, config: qconfig(), adapters: generatedAdapter(counter) };
  const job = await generateQuestions(args);
  await atomicJSON(join(itemDirectory(dir, sample.key), "questions", `${job.id}.json`), { ...job, status: "running", questions: [] });
  assert.equal((await generateQuestions(args)).status, "completed");
  assert.equal(counter.calls, 1);
  for (const missingUsage of [false, true]) {
    const { dir: isolated } = await fixture(t), calls = { calls: 0 };
    const adapters = missingUsage ? generatedAdapter(calls, { costCny: null }) : {
      requestQuestions: async () => { calls.calls++; throw fail("question_call_outcome_unknown"); }
    };
    const input = { ...args, dataDir: isolated, adapters };
    const first = await generateQuestions(input);
    assert.equal(first.status, "needs_reconciliation");
    assert.equal((await generateQuestions({ ...input, retry: true })).status, "needs_reconciliation");
    assert.equal(calls.calls, 1);
  }
});
test("同媒体台账合并理解与出题费用，超预算不发第二类请求", async t => {
  const { dir, store } = await fixture(t), counter = { calls: 0 };
  const source = await currentSources(dir, await store.read(), sample.key);
  const directory = itemDirectory(dir, sample.key);
  await mkdir(directory, { recursive: true });
  await atomicJSON(join(directory, `cost-${source.contentHash}.json`), { calls: [{ stage: "vision", costCny: .048, state: "returned" }] });
  const job = await generateQuestions({ dataDir: dir, itemKey: sample.key, config: qconfig(), adapters: generatedAdapter(counter) });
  assert.equal(job.status, "budget_exceeded"); assert.equal(counter.calls, 0);
});

function batchAdapters(dir, counter, options = {}) {
  return {
    captureContent: async ({ item }) => {
      counter.capture++;
      if (item.id === options.failId) throw fail("media_required");
      const directory = join(dir, "content-media", digest(item.key));
      await mkdir(directory, { recursive: true });
      const mediaPath = join(directory, "fixture.mp4"), input = join(directory, "input.json");
      await writeFile(mediaPath, "test-only");
      await atomicJSON(input, { itemKey: item.key, mediaPath, comments: [] });
      return { input };
    },
    content: {
      inspectMedia: async () => ({ hash: "b".repeat(64), durationMs: 10000, hasAudio: true, hasVideo: true }),
      extractAudio: async () => "test-only.wav",
      transcribe: async () => { counter.asr++; return { segments: [{ startMs: 0, endMs: 9000, text }] }; }
    },
    questions: generatedAdapter(counter)
  };
}
const many = count => Array.from({ length: count }, (_, n) => ({ ...sample, id: String(n + 1), key: `douyin:test:${n + 1}` }));
test("可见浏览器占用、登录失效或平台拒绝时停止整批，不连续打开后续页面", async t => {
  for (const message of ["visible_browser_in_use", "account_not_logged_in", "platform_forbidden",
    "self_page_ready_timeout:account,folders"]) {
    const { dir } = await fixture(t, many(2));
    let captures = 0;
    const run = await runContentBatch({ dataDir: dir, getModelConfig: models, adapters: {
      captureContent: async () => { captures++; throw Error(message); }
    } });
    assert.equal(run.status, "blocked");
    assert.equal(run.error, message.split(":")[0]);
    assert.equal(run.results.length, 1);
    assert.equal(captures, 1);
  }
});
test("后台默认关闭且不加载模型；同日限条数、跨日跳过完成项，缓存媒体复用", async t => {
  const { dir } = await fixture(t, many(4)), counter = { capture: 0, asr: 0, calls: 0 };
  let modelLoads = 0;
  const args = { dataDir: dir, now: new Date("2026-10-20T02:00:00Z"),
    getModelConfig: () => { modelLoads++; return models(); }, adapters: batchAdapters(dir, counter) };
  assert.equal((await runContentBatch({ ...args, scheduled: true })).reason, "disabled");
  assert.equal(modelLoads, 0);
  await configureBatch(dir, { maxItemsPerDay: 2, enabled: true });
  assert.equal((await planBatch(dir, { now: args.now })).items.length, 2);
  const first = await runContentBatch({ ...args, scheduled: true });
  assert.equal(first.status, "completed"); assert.equal(first.results.length, 2);
  const prepared = await learningStore(dir).read();
  assert.equal(prepared.questions.length, 2);
  assert.equal(Object.keys(prepared.progress).length, 2);
  assert.ok(Object.values(prepared.drafts).every(draft =>
    draft.status === "approved" && draft.decisionSource === "automatic"));
  assert.equal((await runContentBatch({ ...args, scheduled: true })).reason, "already_scheduled");
  assert.equal((await runContentBatch(args)).results.length, 0);
  assert.equal(counter.capture, 2);
  const next = await runContentBatch({ ...args, now: new Date("2026-10-21T02:00:00Z") });
  assert.equal(next.results.length, 2); assert.equal(counter.calls, 4);
  assert.equal((await runContentBatch({ ...args, now: new Date("2026-10-22T02:00:00Z") })).results.length, 0);
  const status = await batchStatus(dir, args.now);
  assert.equal(status.ledger.days["2026-10-20"].entries[sample.key].costCny, .002);
});
test("单条失败继续、同版本失败次日不自动重试；显式恢复复用媒体与ASR", async t => {
  const { dir } = await fixture(t, many(2)), counter = { capture: 0, asr: 0, calls: 0 };
  const adapters = batchAdapters(dir, counter, { failId: "1" });
  const args = { dataDir: dir, now: new Date("2026-10-20T02:00:00Z"), getModelConfig: models, adapters };
  const first = await runContentBatch(args);
  assert.equal(first.status, "partial"); assert.equal(first.results[1].status, "completed");
  assert.equal((await runContentBatch({ ...args, now: new Date("2026-10-21T02:00:00Z") })).results.length, 0);
  const before = counter.asr;
  const resumed = await runContentBatch({ ...args, retry: true, adapters: batchAdapters(dir, counter) });
  assert.equal(resumed.results.length, 1); assert.equal(resumed.results[0].status, "completed");
  assert.equal(counter.asr, before + 1);
  // A generation configuration failure does not invalidate cached acquisition/ASR.
  const { dir: other } = await fixture(t), c = { capture: 0, asr: 0, calls: 0 };
  const input = { dataDir: other, getModelConfig: () => ({ ...models(), question: { ...qconfig(), apiKey: "" } }),
    adapters: batchAdapters(other, c) };
  assert.equal((await runContentBatch(input)).results[0].status, "needs_configuration");
  const result = await runContentBatch({ ...input, retry: true, getModelConfig: models });
  assert.equal(result.results[0].status, "completed");
  assert.equal(c.capture, 1); assert.equal(c.asr, 1);
});
test("每日预算约束跨媒体台账的增量调用；批处理并发互斥", async t => {
  const { dir } = await fixture(t, many(2)), counter = { capture: 0, asr: 0, calls: 0 };
  await configureBatch(dir, { budgetCnyPerDay: .011 });
  const args = { dataDir: dir, getModelConfig: models, adapters: batchAdapters(dir, counter) };
  const result = await runContentBatch(args);
  assert.equal(result.results[0].status, "completed");
  assert.equal(result.results[1].status, "budget_exceeded");
  assert.equal(counter.calls, 1);
  assert.equal(result.usedCny, .002);
  const { dir: other } = await fixture(t), c = { capture: 0, asr: 0, calls: 0 };
  let release, entered;
  const ready = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  const adapters = batchAdapters(other, c), capture = adapters.captureContent;
  adapters.captureContent = async input => { entered(); await gate; return capture(input); };
  const first = runContentBatch({ dataDir: other, getModelConfig: models, adapters });
  await ready;
  try { assert.equal((await runContentBatch({ dataDir: other })).reason, "batch_locked"); }
  finally { release(); }
  assert.equal((await first).status, "completed");
});
test("批处理断点恢复按已落盘调用核算，保留失败需显式重试", async t => {
  const { dir } = await fixture(t);
  await mkdir(join(dir, "content-batch"), { recursive: true });
  const date = "2026-10-20";
  const entry = { itemKey: sample.key, fingerprint: "old", status: "running", previousCostCny: 0,
    baselineCostCny: 0, reservedCny: .05 };
  await atomicJSON(join(dir, "content-batch/ledger.json"), { version: 1, items: { [sample.key]: { status: "running" } },
    days: { [date]: { entries: { [sample.key]: entry } } } });
  await runContentBatch({ dataDir: dir, now: new Date(`${date}T02:00:00Z`), getModelConfig: models });
  const ledger = (await batchStatus(dir)).ledger;
  assert.equal(ledger.days[date].entries[sample.key].status, "interrupted");
  assert.equal(ledger.days[date].entries[sample.key].costCny, 0);
});

test("条数已满时，排序靠前的新收藏不阻塞本日失败项的显式恢复", async t => {
  const items = many(2), { dir, store } = await fixture(t, [items[1]]);
  const counter = { capture: 0, asr: 0, calls: 0 };
  await configureBatch(dir, { maxItemsPerDay: 1 });
  const args = { dataDir: dir, getModelConfig: models, now: new Date("2026-10-20T02:00:00Z") };
  const failed = await runContentBatch({ ...args, adapters: batchAdapters(dir, counter, { failId: "2" }) });
  assert.equal(failed.results[0].status, "blocked");
  await store.mutate(s => { s.items.push(items[0]); });
  const plan = await planBatch(dir, { retry: true, now: args.now });
  assert.deepEqual(plan.items.map(i => i.itemKey), [items[1].key]);
  const resumed = await runContentBatch({ ...args, retry: true, adapters: batchAdapters(dir, counter) });
  assert.deepEqual(resumed.results.map(i => i.itemKey), [items[1].key]);
  assert.equal(resumed.results[0].status, "completed");
});
