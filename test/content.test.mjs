import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { contentConfig, providerPython, processingSignature } from "../src/understanding/config.mjs";
import { routeContent, speechDensity } from "../src/understanding/route.mjs";
import { frameTimes, inspectMedia, extractAudio, extractFrames, execute, fail } from "../src/understanding/media.mjs";
import { validateTranscript, validateVision, understandFrames, visionReservation } from "../src/understanding/providers.mjs";
import { processContent, latestContent, publicContent, digest, normalizeComments } from "../src/understanding/pipeline.mjs";
import { startLearningServer } from "../src/learning/server.mjs";
import { emptyState } from "../src/learning/import.mjs";
import { commentsFromResponse } from "../scripts/capture-content.mjs";

const item = { key: "douyin:a:1", id: "1", accountId: "a", platform: "douyin",
  title: "经济原理讲解", description: "", hashtags: [], author: "测试作者", url: "https://www.douyin.com/video/1",
  categories: ["其他灵感"], firstSeenAt: "2026-10-16T00:00:00Z" };
const asset = { hash: "a".repeat(64), path: "/test-only.mp4", durationMs: 10000, hasAudio: true, hasVideo: true, size: 100 };
const transcript = { provider: "whisper", model: "test-only", segments: [
  { startMs: 0, endMs: 9000, text: "这是一段足够密集的测试转写文字，用于验证时间证据以及内容路由，不代表真实视频。" }
], processingSeconds: 1 };
const config = () => ({ ...contentConfig({}), asrRateCnyPerMinute: 0.006 });
const visionConfig = () => ({ ...config(), visionApiKey: "test-only", visionModel: "test-model",
  visionMaxCostCny: .02, visionInputCnyPerMillion: .1, visionOutputCnyPerMillion: .1 });
async function temp(t) {
  await mkdir(resolve(".data"), { recursive: true });
  const dir = await mkdtemp(resolve(".data/content-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function fakes() {
  const calls = [];
  return { calls, adapters: {
    inspectMedia: async () => asset,
    extractAudio: async () => { calls.push("audio"); return "/test-only.wav"; },
    transcribe: async () => { calls.push("asr"); return structuredClone(transcript); },
    extractFrames: async () => { calls.push("frames"); return [{ id: "frame-1", timestampMs: 5000, path: "test-only.jpg" }]; },
    understandFrames: async () => { calls.push("vision"); return { costCny: .01, usage: { inputTokens: 10, outputTokens: 10 },
      result: { observations: [{ frameId: "frame-1", text: "测试画面" }], claims: [{ text: "测试要点", evidenceIds: ["frame-1"] }] } }; }
  } };
}

test("内容路由不读取收藏夹或评论；关键词冲突和空文案不默认娱乐", () => {
  assert.equal(routeContent({ ...item, title: "", categories: ["化妆"], comments: ["口播"] }).route, "undecided");
  assert.equal(routeContent({ ...item, title: "搞笑猫咪" }).route, "entertainment");
  assert.equal(routeContent({ ...item, title: "搞笑中的物理原理" }).route, "undecided");
  assert.equal(routeContent({ ...item, title: "化妆步骤演示" }).route, "visual");
  assert.equal(routeContent({ ...item, title: "化妆原理讲解" }).route, "mixed");
  assert.equal(routeContent(item).route, "speech");
  assert.equal(routeContent({ ...item, title: "" }, { segments: [], durationMs: 10000 }).route, "undecided");
});
test("FunASR 自动选择独立环境和模型；显式 Python 配置优先", () => {
  const c = contentConfig({ CONTENT_ASR_PROVIDER: "funasr", CONTENT_ASR_MODEL: "" });
  assert.equal(c.python, providerPython("funasr"));
  assert.equal(c.asrModel, "paraformer-zh");
  assert.equal(contentConfig({ CONTENT_ASR_PROVIDER: "funasr", CONTENT_PYTHON: "/custom/python" }).python, "/custom/python");
  assert.equal(contentConfig({}).asrModel, "base");
});
test("百炼官方凭证变量仅供 Qwen 使用，处理签名不保存凭证", () => {
  assert.equal(contentConfig({ DASHSCOPE_API_KEY: " test-key " }).visionApiKey, "test-key");
  assert.equal(contentConfig({ DASHSCOPE_API_KEY: "qwen-key", CONTENT_VISION_PROVIDER: "doubao" }).visionApiKey, "");
  const c = contentConfig({ DASHSCOPE_API_KEY: "fallback-key", CONTENT_VISION_API_KEY: "explicit-key" });
  assert.equal(c.visionApiKey, "explicit-key");
  assert.ok(!JSON.stringify(processingSignature(c)).includes("explicit-key"));
});
test("Qwen 北京价格配置覆盖预留，缺密钥与预留不足都先阻止调用", () => {
  const c = contentConfig({ CONTENT_VISION_MODEL: "qwen-vl-plus", CONTENT_VISION_API_KEY: "test-only",
    CONTENT_VISION_INPUT_CNY_PER_MILLION: "0.8", CONTENT_VISION_OUTPUT_CNY_PER_MILLION: "2",
    CONTENT_VISION_MAX_COST_CNY: "0.02" });
  assert.equal(visionReservation(c), .02);
  assert.throws(() => visionReservation({ ...c, visionApiKey: "" }), /vision_not_configured/);
  assert.throws(() => visionReservation({ ...c, visionMaxCostCny: .01 }), /vision_reservation_too_small/);
});
test("实际语音密度可解决未知路线；重叠片段时间只计一次", () => {
  const route = routeContent({ ...item, title: "" }, { segments: transcript.segments, durationMs: 10000 });
  assert.equal(route.route, "speech"); assert.equal(route.confidence, "high");
  const density = speechDensity([{ startMs: 0, endMs: 5000, text: "测试 hello" },
    { startMs: 4000, endMs: 8000, text: "测试 world" }], 10000);
  assert.equal(density.coverage, .8); assert.equal(density.units, 6);
  assert.equal(speechDensity([], 0), null);
});
test("人工路由必须有有效类型和原因；保留可追溯覆盖依据", () => {
  assert.throws(() => routeContent(item, { override: { route: "visual" } }), /invalid_route_override/);
  const r = routeContent(item, { override: { route: "visual", reason: "讲解依赖屏幕上的操作" } });
  assert.equal(r.confidence, "manual"); assert.equal(r.route, "visual"); assert.equal(r.generateQuestions, false);
});
test("转写时间戳与视觉引用严格校验，不给无证据内容编造时间", () => {
  for (const segment of [{ startMs: -1, endMs: 2, text: "测试" }, { startMs: 0, endMs: 10001, text: "测试" },
    { startMs: 2, endMs: 2, text: "测试" }])
    assert.throws(() => validateTranscript({ segments: [segment] }, asset), /invalid_asr_segment/);
  assert.throws(() => validateTranscript({ segments: [] }, asset), /speech_evidence_missing/);
  const frames = [{ id: "frame-1", timestampMs: 5000 }];
  assert.throws(() => validateVision({ observations: [{ frameId: "invented", text: "编造" }], claims: [] }, frames, []));
  assert.throws(() => validateVision({ observations: [{ frameId: "frame-1", text: "可见内容" }],
    claims: [{ text: "不受支持", evidenceIds: ["comment-1"] }] }, frames, []));
});
test("娱乐路线只保留元信息与评论，即使传入媒体也不调用任何媒体工具", async t => {
  const dataDir = await temp(t), fake = fakes();
  fake.adapters.inspectMedia = async () => { throw Error("不应该读取媒体"); };
  const comments = [{ id: "c1", text: "观众观点", sourceUrl: item.url, collectedAt: "2026-10-16T00:00:00Z" }];
  const result = await processContent({ dataDir, item: { ...item, title: "搞笑猫咪" }, config: config(),
    mediaPath: "/invalid.mp4", comments, adapters: fake.adapters });
  assert.equal(result.status, "completed"); assert.deepEqual(fake.calls, []);
  assert.equal(result.comments[0].usableAsVideoEvidence, false);
  assert.equal(result.generateQuestions, false); assert.equal(result.coverage.videoUnderstood, false);
  assert.throws(() => normalizeComments([comments[0], comments[0]]), /invalid_comments/);
});
test("口播需要媒体；重复执行成功任务不重复转写，换账号互不污染", async t => {
  const dataDir = await temp(t), fake = fakes();
  const args = { dataDir, item, config: config(), adapters: fake.adapters };
  assert.equal((await processContent(args)).status, "needs_media");
  const first = await processContent({ ...args, mediaPath: "video.mp4" });
  const second = await processContent({ ...args, mediaPath: "video.mp4" });
  assert.equal(first.status, "completed"); assert.equal(first.id, second.id);
  assert.deepEqual(fake.calls, ["audio", "asr"]);
  assert.equal(first.stages.asr.segments[0].assetId, asset.hash);
  assert.equal((await latestContent(dataDir, "douyin:b:1")), null);
  assert.equal(first.costs.actualCny, .001);
});
test("视觉路线仅抽帧+视觉；混合路线同时包含语音证据与帧证据", async t => {
  for (const [title, expected] of [["化妆步骤演示", ["frames", "vision"]], ["化妆原理讲解", ["audio", "asr", "frames", "vision"]]]) {
    const dataDir = await temp(t), fake = fakes();
    const job = await processContent({ dataDir, item: { ...item, title }, mediaPath: "video.mp4",
      config: visionConfig(), adapters: fake.adapters });
    assert.equal(job.status, "completed"); assert.deepEqual(fake.calls, expected);
    assert.equal(publicContent(job).observations[0].timestampMs, 5000);
    assert.equal(publicContent(job).observations[0].path, undefined);
    assert.equal(job.coverage.mode, "sampled_frames");
  }
});
test("混合路线等待视觉配置；恢复后复用已保存转写", async t => {
  const dataDir = await temp(t), fake = fakes(), c = visionConfig();
  const args = { dataDir, item: { ...item, title: "化妆原理讲解" }, mediaPath: "video.mp4", adapters: fake.adapters };
  const first = await processContent({ ...args, config: { ...c, visionApiKey: "" } });
  assert.equal(first.status, "needs_configuration"); assert.deepEqual(fake.calls, ["audio", "asr"]);
  const resumed = await processContent({ ...args, config: c, retry: true });
  assert.equal(resumed.status, "completed"); assert.deepEqual(fake.calls, ["audio", "asr", "frames", "vision"]);
});
test("预算在调用前预留，超限不发请求；本地资源价格未知不标记成本为零", async t => {
  const dataDir = await temp(t), fake = fakes();
  const job = await processContent({ dataDir, item, mediaPath: "video.mp4",
    config: { ...config(), budgetCny: .0001 }, adapters: fake.adapters });
  assert.equal(job.status, "budget_exceeded"); assert.equal(fake.calls.includes("asr"), false);
  const other = await processContent({ dataDir: await temp(t), item, mediaPath: "video.mp4",
    config: { ...config(), asrRateCnyPerMinute: null }, adapters: fakes().adapters });
  assert.equal(other.costs.actualCny, null); assert.equal(other.costs.accountingComplete, false);
});
test("视觉调用结果未知时保留预留，显式重试也不能再次收费", async t => {
  const dataDir = await temp(t), fake = fakes();
  fake.adapters.understandFrames = async () => { fake.calls.push("vision"); throw fail("vision_call_outcome_unknown"); };
  const args = { dataDir, item: { ...item, title: "化妆步骤" }, mediaPath: "video.mp4", config: visionConfig(), adapters: fake.adapters };
  const first = await processContent(args);
  assert.equal(first.costs.chargedOrReservedCny, .02);
  const again = await processContent({ ...args, retry: true });
  assert.equal(again.status, "needs_reconciliation");
  assert.equal(fake.calls.filter(c => c === "vision").length, 1);
});
test("响应已保存、阶段未保存的中断恢复：不重复模型调用", async t => {
  const dataDir = await temp(t), fake = fakes();
  const args = { dataDir, item: { ...item, title: "化妆步骤" }, mediaPath: "video.mp4", config: visionConfig(), adapters: fake.adapters };
  const job = await processContent(args);
  const path = join(dataDir, "understanding", digest(item.key), job.id, "job.json");
  job.status = "running"; delete job.stages.vision;
  await writeFile(path, JSON.stringify(job));
  const recovered = await processContent(args);
  assert.equal(recovered.status, "completed"); assert.equal(fake.calls.filter(x => x === "vision").length, 1);
});
test("仅标题或评论更新不会重复理解同一媒体；过期worker锁可恢复", async t => {
  const dataDir = await temp(t), fake = fakes(), args = {
    dataDir, item: { ...item, title: "化妆步骤" }, mediaPath: "video.mp4", config: visionConfig(), adapters: fake.adapters
  };
  await mkdir(join(dataDir, "understanding"), { recursive: true });
  await writeFile(join(dataDir, "understanding/worker.lock"), JSON.stringify({ pid: 2147483647, token: "exited" }));
  const first = await processContent(args);
  const second = await processContent({ ...args, item: { ...args.item, title: "化妆步骤详解" },
    comments: [{ id: "new", text: "新增评论", sourceUrl: item.url, collectedAt: "2026-10-16T00:00:00Z" }] });
  assert.notEqual(first.id, second.id);
  assert.equal(second.status, "completed"); assert.equal(fake.calls.filter(c => c === "vision").length, 1);
  assert.equal(second.costs.actualCny, .01);
});
test("页面评论响应只保留真实字符串ID，去重限量，不把异常空响应当作零评论", () => {
  assert.equal(commentsFromResponse({ status_code: 0, comments: null }, item.url), null);
  assert.equal(commentsFromResponse({ status_code: 1, comments: [] }, item.url), null);
  assert.deepEqual(commentsFromResponse({ status_code: 0, comments: [] }, item.url), []);
  const result = commentsFromResponse({ status_code: 0, comments: [{ cid: "1", text: "观点" },
    { cid: "1", text: "观点" }, { cid: Number.MAX_SAFE_INTEGER + 2, text: "不安全的数值ID" }] }, item.url);
  assert.equal(result.length, 1); assert.equal(result[0].sourceUrl, item.url);
});
test("不合格模型输出也计成本；usage缺失不伪装实际零费用", async t => {
  const dataDir = await temp(t), fake = fakes();
  fake.adapters.understandFrames = async () => ({ error: "invalid_vision_output", costCny: .01 });
  const job = await processContent({ dataDir, item: { ...item, title: "化妆步骤" }, mediaPath: "video.mp4",
    config: visionConfig(), adapters: fake.adapters });
  assert.equal(job.status, "blocked"); assert.equal(job.costs.actualCny, .01);
  const noUsage = fakes(); noUsage.adapters.understandFrames = async () => ({ result: {}, costCny: null });
  const unknown = await processContent({ dataDir: await temp(t), item: { ...item, title: "化妆步骤" },
    mediaPath: "video.mp4", config: visionConfig(), adapters: noUsage.adapters });
  assert.equal(unknown.error, "vision_usage_missing"); assert.equal(unknown.costs.actualCny, null);
});
test("稀少转写不当作可靠知识；全静音/无时间证据会阻塞", async t => {
  const fake = fakes(); fake.adapters.transcribe = async () => ({ ...transcript, segments: [{ startMs: 0, endMs: 500, text: "嗨" }] });
  const job = await processContent({ dataDir: await temp(t), item, mediaPath: "video.mp4", config: config(), adapters: fake.adapters });
  assert.equal(job.status, "needs_review");
  fake.adapters.transcribe = async () => ({ ...transcript, segments: [] });
  const empty = await processContent({ dataDir: await temp(t), item, mediaPath: "video.mp4", config: config(), adapters: fake.adapters });
  assert.equal(empty.status, "blocked");
});
test("视觉适配器发送图片+片段ID，解析Qwen/豆包兼容响应并记录无效输出账单", async t => {
  const dir = await temp(t), framePath = join(dir, "frame.jpg");
  await writeFile(framePath, Buffer.from("test-only"));
  for (const provider of ["qwen", "doubao"]) {
    let sent;
    const result = await understandFrames([{ id: "frame-1", path: framePath, timestampMs: 5000 }], [],
      { ...visionConfig(), visionProvider: provider }, async (_url, options) => {
        sent = JSON.parse(options.body);
        return Response.json({ usage: { prompt_tokens: 1000, completion_tokens: 100 }, choices: [{
          finish_reason: "stop", message: { content: JSON.stringify({ observations: [{ frameId: "frame-1", text: "描述" }],
            claims: [{ text: "错误引用", evidenceIds: ["invented"] }] }) } }] });
      });
    assert.equal(result.costCny, .00011); assert.equal(result.error, "invalid_vision_evidence");
    assert.equal(sent.messages[0].content[2].type, "image_url");
    assert.equal(sent.model, "test-model");
  }
});
test("并发任务互斥，不因重试同时启动第二个模型进程", async t => {
  const dataDir = await temp(t), fake = fakes();
  let release, entered;
  const start = new Promise(r => { entered = r; });
  fake.adapters.transcribe = async () => { entered(); await new Promise(r => { release = r; }); return transcript; };
  const args = { dataDir, item, mediaPath: "video.mp4", config: config(), adapters: fake.adapters };
  const first = processContent(args); await start;
  try { await assert.rejects(() => processContent(args), /worker_locked/); }
  finally { release(); }
  assert.equal((await first).status, "completed");
});
test("真实ffmpeg Spike：完整音轨、均匀抽帧、哈希、时长上限", async t => {
  const dir = await temp(t), c = config(), path = join(dir, "fixture.mp4");
  try { await execute(c.ffmpeg, ["-version"]); await execute(c.ffprobe, ["-version"]); }
  catch { t.skip("ffmpeg可选依赖未安装"); return; }
  await execute(c.ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", path]);
  const real = await inspectMedia(path, c);
  assert.equal(real.hasAudio, true); assert.equal(real.hasVideo, true); assert.equal(real.hash.length, 64);
  const audio = await extractAudio(real, dir, c);
  assert.ok((await readFile(audio)).length > 10000);
  const frames = await extractFrames(real, dir, { ...c, frameIntervalMs: 1000, maxFrames: 3 });
  assert.equal(frames.length, 3);
  assert.ok(frames[0].timestampMs > 0 && frames.at(-1).timestampMs < real.durationMs);
  assert.ok(new Set(frames.map(f => f.hash)).size > 1);
  assert.deepEqual(frameTimes(120000, 4, 15000), [15000, 45000, 75000, 105000]);
  await assert.rejects(() => inspectMedia(path, { ...c, maxDurationMs: 1000 }), /duration_limit/);
});
test("学习API读取最新内容结果，不暴露本地路径，不改变题卡或学习记录", async t => {
  const dataDir = await temp(t);
  await mkdir(join(dataDir, "learning"));
  await writeFile(join(dataDir, "learning/state.json"), JSON.stringify({ ...emptyState(), items: [item] }));
  await processContent({ dataDir, item, mediaPath: "video.mp4", config: config(), adapters: fakes().adapters });
  const server = await startLearningServer({ dataDir, port: 0, importOnStart: false });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const data = await (await fetch(`${origin}/api/content?itemKey=${item.key}`)).json();
  assert.equal(data.result.status, "completed"); assert.equal(data.result.segments.length, 1);
  assert.equal(JSON.stringify(data).includes("/test-only"), false);
  assert.equal((await fetch(`${origin}/api/content?itemKey=douyin:b:1`)).status, 404);
  assert.equal(JSON.parse(await readFile(join(dataDir, "learning/state.json"), "utf8")).questions.length, 0);
});
test("单帧实测CLI只处理画面，记录用量并在重复执行时复用结果（本地模拟供应商）", async t => {
  const dir = await temp(t), c = config(), media = join(dir, "silent.mp4");
  try { await execute(c.ffmpeg, ["-version"]); } catch { t.skip("ffmpeg未安装"); return; }
  await execute(c.ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", media]);
  await mkdir(join(dir, "learning"));
  await writeFile(join(dir, "learning/state.json"), JSON.stringify({ ...emptyState(), items: [item] }));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 10 }, choices: [{
      finish_reason: "stop", message: { content: JSON.stringify({
        observations: [{ frameId: "frame-1", text: "蓝色测试画面" }], claims: []
      }) }
    }] }));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const env = { ...process.env, CONTENT_VISION_PROVIDER: "qwen",
    CONTENT_VISION_API_KEY: "test-only", CONTENT_VISION_MODEL: "test-model",
    CONTENT_VISION_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    CONTENT_VISION_INPUT_CNY_PER_MILLION: "0.8", CONTENT_VISION_OUTPUT_CNY_PER_MILLION: "2",
    CONTENT_VISION_MAX_COST_CNY: "0.02", CONTENT_BUDGET_CNY: "0.05" };
  const output = join(dir, "result.json");
  const args = ["scripts/content.mjs", "vision-check", "--data-dir", dir, "--item", item.key,
    "--media", media, "--out", output];
  await execute(process.execPath, args, { env, timeout: 15000 });
  const result = JSON.parse(await readFile(output, "utf8"));
  assert.equal(result.status, "completed"); assert.equal(result.segments.length, 0);
  assert.equal(result.costs.actualCny, .00082);
  assert.equal(requests[0].max_tokens, 512);
  assert.equal(requests[0].messages[0].content.filter(x => x.type === "image_url").length, 1);
  await execute(process.execPath, args, { env, timeout: 15000 });
  assert.equal(requests.length, 1);
});
