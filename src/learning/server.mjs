import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { importCollections } from "./import.mjs";
import { dailyLearningQueue, dayKey, dueQuestions, validateQuestion } from "./domain.mjs";
import { routeContent } from "../understanding/route.mjs";
import { latestContent, publicContent } from "../understanding/pipeline.mjs";
import { learningStore } from "./store.mjs";
import { previewReview, summarizeProgress } from "./scheduler.mjs";
import { decideDraft, generateQuestions, generationSummary, questionReservation } from "./generator.mjs";
import { learningPreparation } from "./preparation.mjs";
import { batchStatus, configureBatch, planBatch, runContentBatch } from "./batch.mjs";
import { collectionSync } from "./collection-sync.mjs";
import { accountManager } from "./account.mjs";
import { configuredModels, modelSettings } from "../understanding/model-settings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (res, status, payload) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(payload));
};
async function body(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 100_000) throw error("请求内容过大", 413);
  }
  try { return JSON.parse(data || "{}"); } catch { throw error("请求不是有效 JSON"); }
}
export async function startLearningServer({ dataDir = join(here, "../../.data"), port = 7790, importOnStart = true,
  autoPrepare = false, classificationRunner, accountAdapters = {}, modelEnvironment, batchAdapters = {},
  getModelConfig = () => configuredModels(dataDir, modelEnvironment) } = {}) {
  const store = learningStore(dataDir), mutate = store.mutate;
  const sync = collectionSync({ dataDir, store, runner: classificationRunner,
    onComplete: () => {
      if (autoPrepare) {
        if (!startBatch(true)) retryAfterBatch = true;
      }
    } });
  const account = accountManager({ dataDir, store, ...accountAdapters });
  const settings = modelSettings(dataDir, modelEnvironment);
  let batchTask = null, retryAfterBatch = false, taskError;
  await store.initialize(importOnStart);
  const startBatch = (retry = false) => {
    if (batchTask) return false;
    taskError = undefined;
    batchTask = (async () => {
      questionReservation(getModelConfig().question);
      await account.prepareForSync();
      const result = await runContentBatch({ dataDir, retry, getModelConfig, adapters: batchAdapters });
      if (result.reason === "batch_locked") taskError = "browser_busy";
    })()
      .catch(e => {
        taskError = e.code || (/^[a-z_]+$/.test(e.message) ? e.message : "batch_failed");
        console.error("content_batch_failed", taskError);
      })
      .finally(() => {
        batchTask = null;
        if (retryAfterBatch) { retryAfterBatch = false; startBatch(true); }
      });
    return true;
  };
  const preparation = async () => {
    let modelError;
    try { questionReservation(getModelConfig().question); }
    catch (e) { modelError = e.code || "invalid_model_config"; }
    const current = await store.read(), batch = await batchStatus(dataDir);
    const plan = await planBatch(dataDir, { retry: true });
    const result = learningPreparation(current, batch, { active: Boolean(batchTask), modelError, taskError, plan });
    const job = await sync.status();
    if (["idle", "blocked"].includes(result.status) && (job.status === "running" || job.active))
      return { status: "preparing", stage: "syncing", preparedVideos: 0 };
    return result;
  };
  const publicState = state => {
    const dailyItems = dailyLearningQueue(state.items, state.progress, state.questions, state.cards, state.events,
      state.learningConfig.dailyVideos);
    const keys = new Set(dailyItems.map(item => item.key));
    const today = dayKey(Date.now());
    return {
      ...state, attempts: undefined, drafts: undefined, migration: undefined,
      draftCounts: Object.values(state.drafts).filter(d => d.status === "pending")
        .reduce((counts, d) => ({ ...counts, [d.itemKey]: (counts[d.itemKey] ?? 0) + 1 }), {}),
      questions: state.questions.map(({ id, itemKey, prompt, options, origin }) => ({ id, itemKey, prompt, options, origin })),
      today: {
        itemKeys: dailyItems.map(item => item.key),
        videoLimit: state.learningConfig.dailyVideos,
        completedVideos: new Set(state.events.filter(e => dayKey(e.at) === today).map(e => e.itemKey)).size,
        dueQuestions: dueQuestions(state.items.filter(item => keys.has(item.key)), state.progress,
          state.questions, state.cards).length
      }
    };
  };
  const itemFor = (s, key) => {
    const item = s.items.find(i => i.key === key);
    if (!item) throw error("未找到这条收藏", 404);
    return item;
  };
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      const allowedHosts = new Set([`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`]);
      if (!allowedHosts.has(host)) throw error("无效访问地址", 403);
      const url = new URL(req.url, `http://${host}`);
      const state = await store.read();
      if (req.method === "GET" && url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
      if (req.method === "POST" && req.headers.origin && req.headers.origin !== `http://${host}`) throw error("请从本地工作台操作", 403);
      if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, publicState(state));
      if (req.method === "GET" && url.pathname === "/api/collection-sync") return json(res, 200, await sync.status());
      if (req.method === "GET" && url.pathname === "/api/account") return json(res, 200, await account.status());
      if (req.method === "GET" && url.pathname === "/api/model-settings") return json(res, 200, settings.status());
      if (req.method === "GET" && url.pathname === "/api/learning/preparation") return json(res, 200, await preparation());
      if (req.method === "GET" && url.pathname === "/api/batch") return json(res, 200, {
        ...await batchStatus(dataDir), plan: await planBatch(dataDir), active: Boolean(batchTask) });
      if (req.method === "GET" && url.pathname === "/api/drafts") {
        const key = itemFor(state, url.searchParams.get("itemKey")).key;
        return json(res, 200, { drafts: Object.values(state.drafts).filter(d => d.itemKey === key),
          generation: state.generations[key] ?? null });
      }
      if (req.method === "GET" && url.pathname === "/api/content") {
        const item = itemFor(state, url.searchParams.get("itemKey"));
        const result = await latestContent(dataDir, item.key);
        return json(res, 200, { suggestion: routeContent(item), result: publicContent(result) });
      }
      if (req.method === "GET" && url.pathname === "/api/export") {
        res.setHeader("Content-Disposition", 'attachment; filename="collection-learning-backup.json"');
        return json(res, 200, { ...state, exportedAt: new Date().toISOString() });
      }
      if (req.method === "POST" && url.pathname === "/api/refresh") {
        await mutate(async s => Object.assign(s, await importCollections(dataDir, s)));
        return json(res, 200, publicState(await store.read()));
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        const b = await body(req);
        if (url.pathname === "/api/learning/start") {
          const result = await preparation();
          const recoverable = new Set(["browser_busy", "visible_browser_in_use", "media_required", "explicit_retry_required"]);
          if (result.status === "idle" || (result.status === "blocked" && recoverable.has(result.error))) {
            await configureBatch(dataDir, { enabled: true, maxItemsPerDay: state.learningConfig.dailyVideos });
            startBatch(true);
            return json(res, 202, { status: "preparing", preparedVideos: 0, stage: "starting" });
          }
          return json(res, 200, result);
        }
        if (url.pathname === "/api/model-settings") {
          const saved = await settings.save(b);
          const current = await store.read();
          await configureBatch(dataDir, { enabled: true, maxItemsPerDay: current.learningConfig.dailyVideos });
          if (!startBatch(true)) retryAfterBatch = true;
          return json(res, 200, { ...saved, preparing: true });
        }
        if (url.pathname === "/api/account/login") return json(res, 202, await account.login());
        if (url.pathname === "/api/account/check") return json(res, 200, await account.check());
        if (url.pathname === "/api/collection-sync") {
          await account.prepareForSync();
          return json(res, 202, await sync.start());
        }
        if (url.pathname === "/api/batch/config") return json(res, 200, await configureBatch(dataDir, b));
        if (url.pathname === "/api/learning/config") {
          if (Object.keys(b).some(key => key !== "dailyVideos") || !Number.isInteger(b.dailyVideos) ||
              b.dailyVideos < 1 || b.dailyVideos > 50) throw error("每天学习视频数需为 1–50");
          await mutate(s => { s.learningConfig.dailyVideos = b.dailyVideos; });
          await configureBatch(dataDir, { enabled: true, maxItemsPerDay: b.dailyVideos });
          const response = publicState(await store.read());
          startBatch(true);
          return json(res, 200, response);
        }
        if (url.pathname === "/api/batch/run") {
          return json(res, 202, { status: startBatch(b.retry === true) ? "started" : "running" });
        }
        if (url.pathname === "/api/generate") {
          itemFor(state, b.itemKey);
          return json(res, 200, generationSummary(await generateQuestions({ dataDir, itemKey: b.itemKey,
            config: getModelConfig().question, retry: b.retry === true, autoPublish: true })));
        }
        const result = await mutate(async s => {
          const item = itemFor(s, b.itemKey);
          if (url.pathname === "/api/draft") {
            if (s.drafts[b.draftId]?.itemKey !== item.key) throw error("未找到草稿");
            return decideDraft(dataDir, s, b.draftId, b.decision);
          }
          if (url.pathname === "/api/enroll") {
            if (!s.progress[item.key]) s.progress[item.key] = { enrolledAt: new Date().toISOString(), dueAt: new Date().toISOString(), stage: -1, reviews: 0 };
            return { ok: true };
          }
          if (url.pathname === "/api/note") {
            if (typeof b.text !== "string" || b.text.length > 10_000) throw error("心得最长 10,000 字");
            s.notes[item.key] = { text: b.text.trim(), updatedAt: new Date().toISOString() };
            return s.notes[item.key];
          }
          if (url.pathname === "/api/excerpt") {
            if (typeof b.text !== "string" || b.text.length > 30_000) throw error("摘录最长 30,000 字");
            const source = `${item.description}\n${b.text.trim()}`;
            if (s.questions.some(q => q.itemKey === item.key && q.origin !== "generated" && !source.includes(q.evidence))) throw error("这段摘录已被题卡引用，请保留引用原文。");
            s.excerpts[item.key] = b.text.trim();
            return { ok: true };
          }
          if (url.pathname === "/api/question") {
            if (s.questions.filter(q => q.itemKey === item.key).length >= 30) throw error("每条收藏最多 30 道题");
            validateQuestion(b.question, `${item.description}\n${s.excerpts[item.key] ?? ""}`);
            const { prompt, options, answer, evidence, explanation } = b.question;
            s.questions.push({ id: randomUUID(), itemKey: item.key, prompt: prompt.trim(), options: options.map(x => x.trim()),
              answer, evidence: evidence.trim(), explanation: explanation.trim(), origin: "manual" });
            return { ok: true };
          }
          if (url.pathname === "/api/answer") {
            if (typeof b.attemptId !== "string" || !/^[\w-]{10,100}$/.test(b.attemptId)) throw error("无效答题编号");
            const old = s.attempts[b.attemptId];
            if (old) {
              if (old.itemKey !== item.key || old.questionId !== b.questionId || old.choice !== b.choice) throw error("答题编号冲突", 409);
              return old;
            }
            const q = s.questions.find(q => q.id === b.questionId && q.itemKey === item.key);
            if (!q || !Number.isInteger(b.choice) || b.choice < 0 || b.choice > 3) throw error("请选择有效答案");
            const record = s.cards[q.id];
            if (!s.progress[item.key] || Date.parse(record.card.due) > Date.now())
              throw error("这道题尚未到复习时间，请返回今日学习", 409);
            validateQuestion(q, q.origin === "generated" ? q.sourceSpans.map(s => s.text).join("\n") :
              `${item.description}\n${s.excerpts[item.key] ?? ""}`);
            const pending = Object.values(s.attempts).find(a => a.questionId === q.id && !a.completed &&
              a.revision === record.revision);
            if (pending && !pending.previews) pending.previews = previewReview(record, s.fsrs.parameters, pending.correct, pending.at);
            if (pending) return pending;
            const at = new Date().toISOString();
            const attempt = { attemptId: b.attemptId, itemKey: item.key, questionId: q.id, choice: b.choice,
              correct: b.choice === q.answer, answer: q.answer, evidence: q.evidence, explanation: q.explanation,
              sourceSpans: q.sourceSpans, at, revision: record.revision, cycleDueAt: record.card.due, completed: false,
              previews: previewReview(record, s.fsrs.parameters, b.choice === q.answer, at) };
            s.attempts[b.attemptId] = attempt;
            return attempt;
          }
          if (url.pathname === "/api/review") {
            const a = s.attempts[b.attemptId];
            if (!a || a.itemKey !== item.key) throw error("请先提交答案");
            if (a.completed) return { ok: true, progress: s.progress[item.key], card: s.cards[a.questionId] };
            const requested = b.rating ?? ({ remembered: "good", guessed: "hard", forgot: "again" })[b.confidence];
            if (!["again", "hard", "good", "easy"].includes(requested)) throw error("请选择记忆程度");
            const record = s.cards[a.questionId], rating = a.correct ? requested : "again";
            if (record.revision !== a.revision) throw error("本轮复习已更新，请刷新", 409);
            a.previews ??= previewReview(record, s.fsrs.parameters, a.correct, a.at);
            const scheduled = a.previews[rating];
            record.card = scheduled.card; record.revision++; record.lastReviewedAt = a.at;
            const p = s.progress[item.key];
            p.reviews = (p.reviews ?? 0) + 1; p.lastReviewedAt = a.at;
            summarizeProgress(s);
            a.completed = true;
            a.rating = rating;
            s.events.push({ id: a.attemptId, itemKey: item.key, at: a.at, correct: a.correct,
              rating, requestedRating: requested, questionId: a.questionId,
              log: scheduled.log, fsrs: structuredClone(s.fsrs) });
            return { ok: true, progress: s.progress[item.key], card: record };
          }
          throw error("接口不存在", 404);
        });
        return json(res, 200, result);
      }
      const assets = { "/": ["public/index.html", "text/html"], "/app.mjs": ["public/app.mjs", "text/javascript"],
        "/style.css": ["public/style.css", "text/css"], "/domain.mjs": ["domain.mjs", "text/javascript"] };
      const asset = assets[url.pathname];
      if (req.method !== "GET" || !asset) throw error("页面不存在", 404);
      const content = await readFile(join(here, asset[0]));
      res.writeHead(200, { "content-type": `${asset[1]}; charset=utf-8`, "cache-control": "no-cache",
        "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
      res.end(content);
    } catch (e) { json(res, e.status ?? 400, { error: e.message }); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  let preparationTimer;
  server.once("close", () => { clearInterval(preparationTimer); void account.close(); });
  if (autoPrepare) {
    const state = await store.read();
    await configureBatch(dataDir, { enabled: true, maxItemsPerDay: state.learningConfig.dailyVideos });
    startBatch(true);
    // Revisit the daily queue as new snapshots arrive and the learning day changes.
    preparationTimer = setInterval(() => {
      void sync.status().then(job => { if (job.status !== "running" && !job.active) startBatch(); });
    }, 60_000);
    preparationTimer.unref();
  }
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startLearningServer({ dataDir: process.env.LEARNING_DATA_DIR || undefined,
    port: Number(process.env.LEARNING_PORT || 7790), autoPrepare: true });
  console.log(`收藏学习工作台 http://127.0.0.1:${server.address().port}`);
}
