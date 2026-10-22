import { mkdir, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { atomicJSON, digest, itemDirectory, readJSON, processContent, totalReserved } from "../understanding/pipeline.mjs";
import { contentConfig, questionConfig, loadContentEnv } from "../understanding/config.mjs";
import { configuredModels } from "../understanding/model-settings.mjs";
import { routeContent } from "../understanding/route.mjs";
import { fail } from "../understanding/media.mjs";
import { learningStore } from "./store.mjs";
import { generateQuestions } from "./generator.mjs";
import { dayKey } from "./domain.mjs";

export const defaultBatchConfig = () => ({ version: 1, enabled: false, maxItemsPerDay: 5, budgetCnyPerDay: .25, hour: 9 });
const baseFor = dataDir => join(dataDir, "content-batch");
export const loadModelConfig = () => { loadContentEnv(); return { content: contentConfig(), question: questionConfig() }; };
function validateConfig(config) {
  if (typeof config.enabled !== "boolean" || !Number.isInteger(config.maxItemsPerDay) ||
    config.maxItemsPerDay < 1 || config.maxItemsPerDay > 50 ||
    !Number.isFinite(config.budgetCnyPerDay) || config.budgetCnyPerDay < 0 || config.budgetCnyPerDay > 10 ||
    !Number.isInteger(config.hour) || config.hour < 0 || config.hour > 23) throw new Error("invalid_batch_config");
  return config;
}
async function withLock(dataDir, name, fn) {
  const base = baseFor(dataDir);
  await mkdir(base, { recursive: true, mode: 0o700 });
  let compromised;
  const release = await lockfile.lock(join(base, name), { realpath: false, stale: 120000, update: 20000,
    onCompromised: e => { compromised = e; } });
  try { return await fn(() => { if (compromised) throw compromised; }); }
  finally { await release(); }
}
export async function configureBatch(dataDir, changes) {
  const allowed = ["enabled", "maxItemsPerDay", "budgetCnyPerDay", "hour"];
  if (Object.keys(changes).some(k => !allowed.includes(k))) throw new Error("invalid_batch_config");
  return withLock(dataDir, "config", async check => {
    const path = join(baseFor(dataDir), "config.json");
    const config = validateConfig({ ...await readJSON(path, defaultBatchConfig()), ...changes });
    check(); await atomicJSON(path, config); return config;
  });
}
export async function batchStatus(dataDir, now = new Date()) {
  const base = baseFor(dataDir);
  return { config: await readJSON(join(base, "config.json"), defaultBatchConfig()),
    ledger: await readJSON(join(base, "ledger.json"), { version: 1, days: {}, items: {} }),
    latest: await readJSON(join(base, "latest.json")), date: dayKey(now) };
}
const itemFingerprint = (state, item) => digest({ title: item.title, description: item.description,
  hashtags: item.hashtags, type: item.type, excerpt: state.excerpts[item.key] ?? "" });
export function selectBatchItems(state, ledger, retry = false) {
  // SQL: items LEFT JOIN batch_items USING(item_key), newest first; unchanged terminal rows require explicit retry.
  return [...state.items].sort((a, b) => Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt) || a.key.localeCompare(b.key))
    .filter(item => {
      const old = ledger.items[item.key], fingerprint = itemFingerprint(state, item);
      return !old || old.fingerprint !== fingerprint || (retry && !["completed", "skipped"].includes(old.status));
    }).map(item => ({ item, fingerprint: itemFingerprint(state, item) }));
}
const dailyUsed = day => Object.values(day.entries).reduce((sum, entry) => sum + (entry.costCny ?? entry.reservedCny), 0);
export async function planBatch(dataDir, { retry = false, now = new Date() } = {}) {
  const status = await batchStatus(dataDir, now), state = await learningStore(dataDir).read();
  const day = status.ledger.days[status.date] ?? { entries: {} };
  const available = Math.max(0, status.config.maxItemsPerDay - Object.keys(day.entries).length);
  const candidates = selectBatchItems(state, status.ledger, retry);
  let newItems = 0;
  const planned = candidates.filter(({ item }) => {
    if (day.entries[item.key]) return retry && !["completed", "skipped"].includes(day.entries[item.key].status);
    return newItems++ < available;
  });
  return { date: status.date, config: status.config, usedCny: dailyUsed(day),
    remainingCny: Math.max(0, status.config.budgetCnyPerDay - dailyUsed(day)), remainingItems: available,
    eligibleItems: candidates.length, items: planned.map(({ item }) =>
        ({ itemKey: item.key, title: item.title, route: routeContent(item).route })) };
}
async function itemCosts(dataDir, key) {
  let files;
  try { files = await readdir(itemDirectory(dataDir, key)); }
  catch (e) { if (e.code === "ENOENT") return 0; throw e; }
  let total = 0;
  for (const file of files.filter(f => /^cost-.*\.json$/.test(f)))
    total += totalReserved((await readJSON(join(itemDirectory(dataDir, key), file))).calls);
  return total;
}
export async function runContentBatch({ dataDir, retry = false, scheduled = false, now = new Date(),
  getModelConfig = () => configuredModels(dataDir), adapters = {} }) {
  const initial = await batchStatus(dataDir, now);
  const hour = new Date(+new Date(now) + 8 * 3600000).getUTCHours();
  if (scheduled && (!initial.config.enabled || hour < initial.config.hour))
    return { status: "skipped", reason: !initial.config.enabled ? "disabled" : "before_schedule" };
  try {
    return await withLock(dataDir, "execution", async check => {
      const { config, ledger, date } = await batchStatus(dataDir, now), base = baseFor(dataDir);
      const store = learningStore(dataDir);
      await store.initialize();
      const state = await store.read();
      const day = ledger.days[date] ??= { entries: {}, date };
      for (const oldDay of Object.values(ledger.days)) for (const entry of Object.values(oldDay.entries)) {
        if (entry.status !== "running") continue;
        entry.costCny = entry.previousCostCny + Math.max(0, (await itemCosts(dataDir, entry.itemKey)) - entry.baselineCostCny);
        entry.status = "interrupted"; entry.error = "explicit_retry_required";
        if (ledger.items[entry.itemKey]?.status === "running") ledger.items[entry.itemKey].status = "interrupted";
      }
      if (scheduled && day.scheduledAt) return { status: "skipped", reason: "already_scheduled", date };
      if (scheduled) day.scheduledAt = new Date(now).toISOString();
      const run = { status: "running", date, trigger: scheduled ? "scheduled" : "manual",
        startedAt: new Date().toISOString(), results: [] };
      const save = async () => {
        check();
        await atomicJSON(join(base, "ledger.json"), ledger);
        await atomicJSON(join(base, "latest.json"), run);
      };
      await save();
      const candidates = selectBatchItems(state, ledger, retry);
      let models;
      for (const { item, fingerprint } of candidates) {
        const prior = day.entries[item.key];
        if (!prior && Object.keys(day.entries).length >= config.maxItemsPerDay) { run.limit = "daily_item_limit"; continue; }
        if (prior && !retry) continue;
        const remaining = config.budgetCnyPerDay - dailyUsed(day);
        if (remaining <= 1e-9) { run.limit = "daily_budget_limit"; break; }
        // Configuration is lazy: a disabled scheduler never loads keys or invokes browser/model tools.
        try { models ??= getModelConfig(); }
        catch { run.status = "needs_configuration"; run.error = "invalid_model_config"; break; }
        const allowance = Math.min(models.content.budgetCny, models.question.budgetCny, remaining);
        const baseline = await itemCosts(dataDir, item.key);
        const beforeReserve = async reserve => {
          check();
          if ((await itemCosts(dataDir, item.key)) - baseline + reserve > allowance + 1e-9) throw fail("budget_exceeded");
        };
        const entry = { itemKey: item.key, fingerprint, status: "running", at: new Date().toISOString(),
          baselineCostCny: baseline, reservedCny: (prior?.costCny ?? prior?.reservedCny ?? 0) + allowance,
          previousCostCny: prior?.costCny ?? prior?.reservedCny ?? 0 };
        day.entries[item.key] = entry; ledger.items[item.key] = { fingerprint, status: "running", date };
        await save();
        try {
          let manifest = await readJSON(join(dataDir, "content-media", digest(item.key), "input.json"));
          if (manifest?.itemKey !== item.key) manifest = null;
          if (manifest?.mediaPath) {
            try { await access(manifest.mediaPath); } catch { manifest = null; }
          }
          // Metadata-only entertainment items have no knowledge questions to generate.
          const entertainment = routeContent(item).route === "entertainment";
          if (!manifest && !entertainment) {
            const capture = adapters.captureContent ?? (await import("../../scripts/capture-content.mjs")).captureContent;
            const captured = await capture({ item, dataDir, config: models.content });
            manifest = await readJSON(captured.input);
            if (manifest?.itemKey !== item.key) throw new Error("invalid_capture_manifest");
          }
          // Existing media costs count toward the per-media cap; only incremental batch costs use today's budget.
          const content = await (adapters.processContent ?? processContent)({ dataDir, item,
            mediaPath: manifest?.mediaPath, comments: manifest?.comments ?? [], retry,
            config: { ...models.content, budgetCny: models.content.budgetCny, beforeReserve },
            adapters: adapters.content ?? {} });
          entry.contentId = content.id;
          if (content.status !== "completed") { entry.status = content.status; entry.error = content.error; }
          else if (entertainment) entry.status = "skipped";
          else {
            const generated = await (adapters.generateQuestions ?? generateQuestions)({ dataDir, itemKey: item.key, retry,
              autoPublish: true,
              config: { ...models.question, budgetCny: models.question.budgetCny, beforeReserve },
              adapters: adapters.questions ?? {} });
            entry.status = generated.status; entry.error = generated.error;
            entry.generationId = generated.id; entry.draftCount = generated.questions?.length ?? 0;
          }
        } catch (e) {
          entry.status = "blocked"; entry.error = e.code || (/^[a-z_]+$/.test(e.message) ? e.message : "batch_item_failed");
          const attention = /^(visible_browser_in_use|browser_background_unverified|browser_audio_not_muted|browser_busy|account_not_logged_in|account_changed|platform_forbidden|platform_read_failed|self_page_ready_timeout)(?::|$)/.exec(e.code || e.message);
          if (attention) {
            entry.error = attention[1];
            run.status = "blocked"; run.error = entry.error;
          }
        } finally {
          entry.costCny = entry.previousCostCny + Math.max(0, (await itemCosts(dataDir, item.key)) - baseline);
          entry.finishedAt = new Date().toISOString();
          ledger.items[item.key] = { fingerprint, status: entry.status, date };
          run.results.push({ ...entry });
          await save();
        }
        if (run.status === "blocked") break; // 窗口占用、失去登录或平台限制时，停止本批剩余页面动作。
      }
      if (run.status === "running") run.status = run.results.some(e => !["completed", "skipped"].includes(e.status)) ? "partial" : "completed";
      run.finishedAt = new Date().toISOString(); run.usedCny = dailyUsed(day);
      await save(); return run;
    });
  } catch (e) {
    if (e.code === "ELOCKED") return { status: "skipped", reason: "batch_locked" };
    throw e;
  }
}
