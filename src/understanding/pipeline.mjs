import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { routeContent, speechDensity } from "./route.mjs";
import { processingSignature } from "./config.mjs";
import { inspectMedia, extractAudio, extractFrames, fail } from "./media.mjs";
import { transcribe, understandFrames, validateTranscript, visionReservation } from "./providers.mjs";

export const PIPELINE_VERSION = "content-v1";
export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function readJSON(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
}
export async function atomicJSON(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
export const itemDirectory = (dataDir, key) => join(dataDir, "understanding", digest(key));
export function normalizeComments(comments = []) {
  if (!Array.isArray(comments) || comments.length > 30) throw fail("invalid_comments");
  const ids = new Set();
  return comments.map(c => {
    if (typeof c.id !== "string" || !c.id || ids.has(c.id) || typeof c.text !== "string" ||
        !c.text.trim() || c.text.length > 2000 || typeof c.sourceUrl !== "string" ||
        !/^https:\/\/(?:www\.)?douyin\.com\//.test(c.sourceUrl) ||
        !Number.isFinite(Date.parse(c.collectedAt))) throw fail("invalid_comments");
    ids.add(c.id);
    return { id: c.id, text: c.text.trim(), sourceUrl: c.sourceUrl, collectedAt: c.collectedAt,
      kind: "comment", usableAsVideoEvidence: false };
  });
}
export async function latestContent(dataDir, itemKey) {
  return readJSON(join(itemDirectory(dataDir, itemKey), "latest.json"));
}
export function publicContent(job) {
  if (!job) return null;
  return { id: job.id, itemKey: job.itemKey, status: job.status, route: job.route, error: job.error,
    updatedAt: job.updatedAt, metadata: job.metadata, comments: job.comments,
    segments: job.stages?.asr?.segments ?? [], observations: (job.stages?.vision?.observations ?? []).map(o => ({
      ...o, timestampMs: job.stages.frames.find(f => f.id === o.frameId)?.timestampMs
    })),
    claims: job.stages?.vision?.claims ?? [], coverage: job.coverage, costs: job.costs,
    durationMs: job.asset?.durationMs, quality: job.quality, generateQuestions: false };
}
export async function acquireLock(root) {
  await mkdir(root, { recursive: true });
  const file = join(root, "worker.lock"), token = randomUUID();
  // 过期锁恢复也串行化，防止两个新进程同时删除旧锁、误删对方刚建立的新锁。
  const guard = `${file}.recovery`;
  try { await writeFile(guard, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch (e) { if (e.code === "EEXIST") throw fail("worker_locked"); throw e; }
  try {
    const old = await readJSON(file);
    if (old) {
      if (!Number.isInteger(old.pid) || old.pid < 1) throw fail("worker_locked");
      try { process.kill(old.pid, 0); throw fail("worker_locked"); }
      catch (error) { if (error.code !== "ESRCH") throw fail("worker_locked"); }
      await unlink(file);
    }
    await writeFile(file, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
  } finally { await unlink(guard); }
  return async () => { if ((await readJSON(file))?.token === token) await unlink(file); };
}
export function totalReserved(calls) {
  return calls.reduce((sum, c) => sum + (c.costCny ?? c.reservedCny ?? 0), 0);
}
// The caller holds the understanding worker lock. Both understanding and question generation
// share the media ledger, including pending calls whose billing outcome is unknown.
export function ledgerCharge({ ledger, ledgerFile, save, id, signature, budgetCny, beforeReserve }) {
  return async (stage, reserve, fn, remote) => {
    if (ledger.calls.some(c => c.remote && c.state === "pending")) throw fail("call_outcome_unknown");
    const cached = ledger.calls.find(c => c.stage === stage && (c.signature === signature || c.jobId === id) &&
      c.state === "returned" && !c.error && c.result);
    if (cached) {
      if (totalReserved(ledger.calls) > budgetCny + 1e-9) throw fail("budget_exceeded");
      if (remote && cached.costCny === null) throw fail("vision_usage_missing");
      return cached.result;
    }
    if (!Number.isFinite(reserve) || reserve < 0) throw fail("invalid_reservation");
    if (totalReserved(ledger.calls) + reserve > budgetCny + 1e-9) throw fail("budget_exceeded");
    if (ledger.calls.filter(c => (c.signature === signature || c.jobId === id) && c.stage === stage).length >= 2) throw fail("retry_limit");
    await beforeReserve?.(reserve);
    const call = { id: randomUUID(), jobId: id, stage, signature, remote, state: "pending",
      reservedCny: reserve, costCny: null, at: new Date().toISOString(),
      usage: null, elapsedMs: null, processingSeconds: null, error: null, result: null };
    ledger.calls.push(call);
    await atomicJSON(ledgerFile, ledger); await save();
    const start = Date.now();
    let result;
    try {
      result = await fn();
      call.elapsedMs = Date.now() - start;
      call.state = "returned";
      call.costCny = result.costCny ?? null;
      call.usage = result.usage ?? null;
      call.result = result;
      if (!remote) call.processingSeconds = result.processingSeconds ?? call.elapsedMs / 1000;
      if (result.error) call.error = result.error;
    } catch (e) {
      call.elapsedMs = Date.now() - start; call.error = e.code || "processing_failed";
      if (!remote) call.state = "failed";
      await atomicJSON(ledgerFile, ledger); await save(); throw e;
    }
    await atomicJSON(ledgerFile, ledger); await save();
    if (totalReserved(ledger.calls) > budgetCny + 1e-9) throw fail("budget_exceeded");
    if (result.error) throw fail(result.error);
    if (remote && result.costCny === null) throw fail("vision_usage_missing");
    return result;
  };
}
const dependencyStatus = code => ({
  media_required: "needs_media", local_media_required: "needs_media", vision_not_configured: "needs_configuration",
  vision_pricing_missing: "needs_configuration", asr_dependency_missing: "needs_configuration",
  budget_exceeded: "budget_exceeded", call_outcome_unknown: "needs_reconciliation",
  vision_call_outcome_unknown: "needs_reconciliation"
})[code] || "blocked";

/** 顺序持久任务。昂贵调用前保存预留；中断后不自动重复未知结果的远端调用。
 * SQL unique: item_key + input_hash + pipeline_version + config_hash.
 * 预算台账按媒体内容哈希隔离，换路由/模型仍合并该内容的重试费用。 */
export async function processContent({ dataDir, item, mediaPath, comments = [], override, retry = false, config, adapters = {} }) {
  if (!item?.key || item.platform !== "douyin" || item.key !== `douyin:${item.accountId}:${item.id}`) throw fail("invalid_item");
  const cleanComments = normalizeComments(comments);
  const metadata = { title: item.title || "", description: item.description || "", author: item.author || "",
    hashtags: item.hashtags ?? [], url: item.url };
  let route = routeContent(item, { override });
  const unlock = await acquireLock(join(dataDir, "understanding"));
  let job, save;
  try {
    let asset = null;
    // 娱乐路线无论是否传了媒体都不触碰音视频。
    if (mediaPath && route.route !== "entertainment") asset = await (adapters.inspectMedia ?? inspectMedia)(mediaPath, config);
    const contentHash = asset?.hash ?? digest(metadata);
    const inputHash = digest({ metadata, comments: cleanComments, contentHash, override });
    const id = digest({ itemKey: item.key, inputHash, pipeline: PIPELINE_VERSION, config: processingSignature(config) });
    const directory = itemDirectory(dataDir, item.key), jobDir = join(directory, id);
    await mkdir(jobDir, { recursive: true });
    const file = join(jobDir, "job.json"), ledgerFile = join(directory, `cost-${contentHash}.json`);
    const ledger = await readJSON(ledgerFile, { contentHash, calls: [] });
    job = await readJSON(file);
    if (job?.status === "completed" || job?.status === "needs_review") {
      await atomicJSON(join(directory, "latest.json"), job); return job;
    }
    if (job && !retry && job.status !== "running") return job;
    job ??= { id, itemKey: item.key, version: PIPELINE_VERSION, inputHash, contentHash,
      config: processingSignature(config), createdAt: new Date().toISOString(), metadata,
      comments: cleanComments, asset, route, status: "running", stages: {}, attempts: 0, generateQuestions: false };
    job.attempts++; job.status = "running"; delete job.error;
    save = async () => {
      job.updatedAt = new Date().toISOString();
      const reservedCny = totalReserved(ledger.calls);
      job.costs = { budgetCny: config.budgetCny, chargedOrReservedCny: reservedCny,
        actualCny: ledger.calls.every(c => c.costCny !== null && c.costCny !== undefined) ?
          ledger.calls.reduce((s, c) => s + c.costCny, 0) : null,
        accountingComplete: ledger.calls.every(c => Number.isFinite(c.costCny)),
        calls: ledger.calls.map(({ result, ...call }) => call) };
      await atomicJSON(file, job);
      await atomicJSON(join(directory, "latest.json"), job);
    };
    await save();
    const charge = ledgerCharge({ ledger, ledgerFile, save, id,
      signature: digest(processingSignature(config)), budgetCny: config.budgetCny, beforeReserve: config.beforeReserve });
    if (route.route === "entertainment") {
      job.status = "completed"; job.quality = "metadata_only";
      job.coverage = { mode: "metadata_only", comments: cleanComments.length, videoUnderstood: false };
      await save(); return job;
    }
    if (!asset) throw fail("media_required");
    const needsSpeech = ["speech", "mixed", "undecided"].includes(route.route);
    if (needsSpeech && !job.stages.asr) {
      if (!asset.hasAudio) throw fail(route.route === "undecided" ? "route_evidence_missing" : "no_audio_track");
      const audio = await (adapters.extractAudio ?? extractAudio)(asset, jobDir, config);
      const costCny = config.asrRateCnyPerMinute === null ? null : asset.durationMs / 60000 * config.asrRateCnyPerMinute;
      const result = await charge("asr", costCny ?? 0, async () => ({
        ...await (adapters.transcribe ?? transcribe)(audio, asset, config), costCny
      }), false);
      job.stages.asr = validateTranscript(result, asset);
      await save();
    }
    if (job.stages.asr) {
      route = routeContent(item, { segments: job.stages.asr.segments, durationMs: asset.durationMs, override });
      job.route = route;
      if (route.route === "undecided") throw fail("route_evidence_missing");
    }
    if (["visual", "mixed"].includes(route.route)) {
      // 配置/预算先检查，不在模型不可用时白做抽帧。
      const reserve = visionReservation(config);
      if (!job.stages.vision) {
        if (!job.stages.frames) {
          job.stages.frames = await (adapters.extractFrames ?? extractFrames)(asset, jobDir, config);
          await save();
        }
        const result = await charge("vision", reserve, () =>
          (adapters.understandFrames ?? understandFrames)(job.stages.frames, job.stages.asr?.segments ?? [], config), true);
        job.stages.vision = result.result;
        await save();
      }
    }
    const density = speechDensity(job.stages.asr?.segments, asset.durationMs);
    job.coverage = { mode: job.stages.vision ? "sampled_frames" : "audio_track",
      frameCount: job.stages.frames?.length ?? 0, frameTimesMs: job.stages.frames?.map(f => f.timestampMs) ?? [],
      speechDensity: density, videoUnderstood: false };
    const weakSpeech = density && (density.units < 8 || density.coverage < .15 ||
      job.stages.asr.segments.some(s => Number.isFinite(s.avgLogprob) && s.avgLogprob < -1));
    job.status = weakSpeech ? "needs_review" : "completed";
    job.quality = weakSpeech ? "weak_speech_evidence" : "machine_extracted_unverified";
    await save(); return job;
  } catch (e) {
    if (!job || !save) throw e;
    job.status = dependencyStatus(e.code);
    job.error = e.code || "processing_failed";
    await save(); return job;
  } finally { await unlock(); }
}
