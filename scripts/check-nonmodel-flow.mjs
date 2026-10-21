// Isolated integration: real ffmpeg/HTTP/storage, deterministic ASR and loopback vision responses.
// Never loads .env.content, opens a platform page, or writes to the production library.
import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { contentConfig, questionConfig } from "../src/understanding/config.mjs";
import { execute, inspectMedia } from "../src/understanding/media.mjs";
import { processContent, digest, atomicJSON } from "../src/understanding/pipeline.mjs";
import { importCollections } from "../src/learning/import.mjs";
import { startLearningServer } from "../src/learning/server.mjs";
import { refreshDailyClassification } from "./daily.mjs";
import { configureBatch, runContentBatch } from "../src/learning/batch.mjs";

const output = resolve(process.argv[2] || ".data/readiness/integration");
const dataDir = join(output, "data");
await mkdir(join(dataDir, "local-browser"), { recursive: true });
const checks = [];
const check = async (name, fn) => { await fn(); checks.push(name); console.log(`✓ ${name}`); };
const favorites = [
  { id: "1", title: "经济原理讲解", author: "验收样本", hashtags: [] },
  { id: "2", title: "化妆步骤演示", author: "验收样本", hashtags: [] },
  { id: "3", title: "化妆原理讲解", author: "验收样本", hashtags: [] },
  { id: "4", title: "搞笑猫咪", author: "验收样本", hashtags: [] },
  { id: "5", title: "产品思维商业案例", author: "验收样本", hashtags: [] },
  { id: "6", title: "化妆步骤补充", author: "验收样本", hashtags: [] }
];
const page = (field, values) => ({ path: "/fixture/", query: { cursor: "0" }, body: {},
  status: 200, code: 0, cursor: 0, hasMore: 0, [field]: values,
  ...(field === "items" ? { itemsType: "array" } : {}) });
const folders = [
  { id: "knowledge", name: "a知识（非AI非商业非宏经非英语）", owner: "readiness", items: [favorites[0]] },
  { id: "makeup", name: "化妆与护肤", owner: "readiness", items: favorites.slice(1, 3) },
  { id: "business", name: "商业与产品思维", owner: "readiness", items: [favorites[4]] }
].map(f => ({ ...f, total: f.items.length, pages: [page("items", f.items)] }));
const snapshot = { at: new Date().toISOString(), account: { id: "readiness", nickname: "隔离验收" },
  complete: true, scope: "all_readable_favorites", folders, folderPages: [page("folders", folders)],
  favorites, favoritePages: [page("items", favorites)], unclassified: [favorites[3], favorites[5]], invalidCount: 0 };
await atomicJSON(join(dataDir, "local-browser/snapshot.json"), snapshot);
let state;
await check("完整快照→每日规则/差集→重复导入", async () => {
  const dailyDir = join(dataDir, "daily");
  await mkdir(dailyDir, { recursive: true });
  const { plan } = await refreshDailyClassification(snapshot, snapshot.account.id, dailyDir, output);
  assert.equal(plan.total, 2);
  assert.deepEqual(plan.decisions.map(d => [d.itemId, d.folderId]), [["6", "makeup"]]);
  assert.deepEqual(plan.unresolved.map(i => i.id), ["4"]);
  state = await importCollections(dataDir);
  const again = await importCollections(dataDir, state);
  assert.equal(again.items.length, favorites.length);
  assert.deepEqual(again.items, state.items);
  await mkdir(join(dataDir, "learning"), { recursive: true });
  await atomicJSON(join(dataDir, "learning/state.json"), state);
});

const base = contentConfig({});
const mediaPath = join(output, "fixture.mp4");
let asset;
await check("真实ffmpeg生成媒体并校验音视频轨道与时长", async () => {
  // Missing dependencies fail this acceptance command; no skipped-success reports.
  await execute(base.ffmpeg, ["-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", mediaPath], { timeout: 30000 });
  asset = await inspectMedia(mediaPath, base);
  assert.ok(asset.hasAudio && asset.hasVideo && asset.durationMs >= 4000);
});

const requests = [], asrCalls = [], questionRequests = [];
const mockVision = createServer(async (req, res) => {
  try {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body), parts = request.messages[0].content;
    if (request.messages[0].role === "system") {
      const source = JSON.parse(request.messages[1].content)[0];
      questionRequests.push({ sourceId: source.id });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 200 }, choices: [{
        finish_reason: "stop", message: { content: JSON.stringify({ questions: [{
          prompt: "根据验收原文，这段转写的用途是什么？",
          options: ["检查提取与持久化", "真实识别质量评分", "统计用户人数", "删除全部文件"], answer: 0,
          evidence: source.text, sourceId: source.id, explanation: "测试原文说明其用途为检查提取、路由和证据持久化。"
        }] }) }
      }] }));
      return;
    }
    const images = parts.filter(p => p.type === "image_url");
    assert.equal(images.length, 3);
    for (const image of images) {
      const bytes = Buffer.from(image.image_url.url.split(",")[1], "base64");
      assert.equal(bytes.subarray(0, 2).toString("hex"), "ffd8");
      assert.ok(bytes.length > 1000);
    }
    requests.push({ frames: images.length, includesSpeech: parts[0].text.includes('"id":"asr-1"') });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 100 },
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        observations: images.map((_, i) => ({ frameId: `frame-${i + 1}`, text: "隔离验收模拟描述，不代表模型理解。" })),
        claims: [{ text: "仅用于验证证据引用与HTTP链路", evidenceIds: ["frame-1"] }]
      }) } }] }));
  } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
});
await new Promise(r => mockVision.listen(0, "127.0.0.1", r));
const config = { ...base, visionApiKey: "readiness-local-only", visionModel: "readiness-mock",
  visionBaseUrl: `http://127.0.0.1:${mockVision.address().port}/v1`, visionMaxCostCny: .02,
  visionInputCnyPerMillion: .1, visionOutputCnyPerMillion: .1, asrRateCnyPerMinute: 0,
  frameIntervalMs: 1000, maxFrames: 3 };
const adapters = { transcribe: async (audio, source) => {
  const bytes = await readFile(audio);
  assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
  const inspected = await inspectMedia(audio, config);
  assert.ok(inspected.hasAudio && !inspected.hasVideo);
  assert.ok(Math.abs(inspected.durationMs - source.durationMs) < 100);
  asrCalls.push(audio);
  return { provider: "readiness-mock", model: "deterministic", processingSeconds: 0,
    segments: [{ startMs: 0, endMs: source.durationMs - 100,
      text: "这是隔离验收提供的确定性测试转写，用于检查完整音轨提取、路由和证据持久化，不代表真实识别结果。" }] };
} };
const jobs = [];
let learningServer;
try {
  for (const [index, route] of ["speech", "visual", "mixed", "entertainment"].entries()) {
    await check(`${route}路线：媒体处理→模型边界→持久结果→重复执行`, async () => {
      const item = state.items.find(i => i.id === String(index + 1));
      const args = { dataDir, item, config, adapters, mediaPath };
      const before = { asr: asrCalls.length, vision: requests.length };
      const job = await processContent(args);
      assert.equal(job.status, "completed");
      assert.equal(job.route.route, route);
      assert.equal(asrCalls.length - before.asr, ["speech", "mixed"].includes(route) ? 1 : 0);
      assert.equal(requests.length - before.vision, ["visual", "mixed"].includes(route) ? 1 : 0);
      for (const frame of job.stages.frames ?? []) assert.ok((await stat(frame.path)).size > 1000);
      const again = await processContent(args);
      assert.equal(again.id, job.id);
      assert.equal(again.attempts, 1);
      assert.equal(again.costs.calls.length, job.costs.calls.length);
      assert.equal(again.generateQuestions, false);
      jobs.push({ args, job });
    });
  }
  assert.deepEqual(requests.map(r => r.includesSpeech), [false, true]);
  await check("中断恢复复用已落盘模型响应，未配置视觉时可恢复转写", async () => {
    const { args, job } = jobs[2], calls = requests.length;
    const interrupted = structuredClone(job);
    interrupted.status = "running";
    delete interrupted.stages.vision;
    await atomicJSON(join(dataDir, "understanding", digest(job.itemKey), job.id, "job.json"), interrupted);
    const recovered = await processContent(args);
    assert.equal(recovered.status, "completed");
    assert.equal(requests.length, calls);
    const resumeData = join(output, "resume-data");
    const blocked = await processContent({ ...args, dataDir: resumeData, config: { ...config, visionApiKey: "" } });
    assert.equal(blocked.status, "needs_configuration");
    const speechCalls = asrCalls.length;
    const resumed = await processContent({ ...args, dataDir: resumeData, retry: true });
    assert.equal(resumed.status, "completed");
    assert.equal(asrCalls.length, speechCalls);
    assert.equal(requests.length, calls + 1);
  });
  await check("真实HTTP工作台读取四条路线，重启后内容与心得保留", async () => {
    learningServer = await startLearningServer({ dataDir, port: 0 });
    let origin = `http://127.0.0.1:${learningServer.address().port}`;
    for (const { job } of jobs) {
      const response = await fetch(`${origin}/api/content?itemKey=${encodeURIComponent(job.itemKey)}`);
      assert.equal(response.status, 200);
      const { result } = await response.json();
      assert.equal(result.status, "completed");
      assert.ok(!JSON.stringify(result).includes(dataDir));
      if (result.observations.length) assert.ok(result.observations.every(o => o.timestampMs > 0));
    }
    const itemKey = jobs[0].job.itemKey;
    const response = await fetch(`${origin}/api/note`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ itemKey, text: "隔离HTTP验收心得" }) });
    assert.equal(response.status, 200);
    await new Promise(r => learningServer.close(r));
    learningServer = await startLearningServer({ dataDir, port: 0 });
    origin = `http://127.0.0.1:${learningServer.address().port}`;
    const saved = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(saved.notes[itemKey].text, "隔离HTTP验收心得");
    assert.equal(saved.items.length, favorites.length);
    assert.equal(saved.questions.length, 0);
  });
  await check("每日内容批处理复用媒体→自动出题HTTP→批准→FSRS保存→服务重启", async () => {
    const itemKey = jobs[0].job.itemKey;
    const manifestDir = join(dataDir, "content-media", digest(itemKey));
    await mkdir(manifestDir, { recursive: true });
    await atomicJSON(join(manifestDir, "input.json"), { itemKey, mediaPath, comments: [] });
    await configureBatch(dataDir, { maxItemsPerDay: 1 });
    const question = { ...questionConfig({}), apiKey: "readiness-local-only", model: "readiness-questions",
      baseUrl: config.visionBaseUrl, inputCnyPerMillion: .1, outputCnyPerMillion: .1, maxCostCny: .01 };
    const args = { dataDir, getModelConfig: () => ({ content: config, question }) };
    const run = await runContentBatch(args);
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].status, "completed");
    assert.equal(questionRequests.length, 1);
    assert.equal((await runContentBatch(args)).results.length, 0);
    const origin = `http://127.0.0.1:${learningServer.address().port}`;
    const post = async (path, data) => {
      const r = await fetch(`${origin}/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemKey, ...data }) });
      assert.equal(r.status, 200); return r.json();
    };
    const visible = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(visible.questions.length, 0);
    const { drafts } = await (await fetch(`${origin}/api/drafts?itemKey=${encodeURIComponent(itemKey)}`)).json();
    assert.equal(drafts.length, 1);
    await post("draft", { draftId: drafts[0].id, decision: "approve" });
    await post("enroll", {});
    const answer = await post("answer", { questionId: drafts[0].id, choice: 0, attemptId: "integration-attempt" });
    assert.equal(answer.sourceSpans[0].kind, "transcript");
    await post("review", { attemptId: answer.attemptId, rating: "good" });
    await new Promise(r => learningServer.close(r));
    learningServer = await startLearningServer({ dataDir, port: 0 });
    const saved = await (await fetch(`http://127.0.0.1:${learningServer.address().port}/api/state`)).json();
    assert.equal(saved.cards[drafts[0].id].card.due, answer.previews.good.card.due);
    assert.equal(saved.events.length, 1);
    assert.equal(saved.notes[itemKey].text, "隔离HTTP验收心得");
  });
  await atomicJSON(join(output, "result.json"), { checkedAt: new Date().toISOString(), status: "passed",
    checks, dataDir, media: { durationMs: asset.durationMs, hash: asset.hash },
    routes: jobs.map(({ job }) => ({ route: job.route.route, status: job.status,
      frames: job.stages.frames?.length ?? 0, segments: job.stages.asr?.segments.length ?? 0 })),
    mockAsrCalls: asrCalls.length, loopbackVisionCalls: requests.length, loopbackQuestionCalls: questionRequests.length, cloudModelCalls: 0,
    platformWrites: 0, productionDataUsed: false });
} finally {
  if (learningServer?.listening) await new Promise(r => learningServer.close(r));
  await new Promise(r => mockVision.close(r));
}
