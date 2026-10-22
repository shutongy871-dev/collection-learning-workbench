import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { categoryName } from "./domain.mjs";

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error(`无法读取收藏数据 ${path}: ${error.message}`); }
}
async function snapshots(dir, depth = 0) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const paths = [];
  for (const entry of entries) {
    if (entry.isFile() && /^(?:final-)?snapshot\.json$/.test(entry.name)) paths.push(join(dir, entry.name));
    if (entry.isDirectory() && depth < 2 && !/profile|cache|Default/i.test(entry.name)) paths.push(...await snapshots(join(dir, entry.name), depth + 1));
  }
  return paths;
}
export const emptyState = () => ({
  version: 1,
  learningConfig: { dailyVideos: 5 },
  items: [],
  progress: {},
  notes: {},
  excerpts: {},
  questions: [],
  events: [],
  attempts: {},
  sources: [],
  importedAt: null
});

// 单平台迁移也清理关联学习记录，避免旧来源留在导出和复习队列中。
export function retainDouyinState(previous) {
  const items = previous.items.filter(i => i.platform === "douyin");
  const keys = new Set(items.map(i => i.key));
  const byItem = records => Object.fromEntries(Object.entries(records).filter(([key]) => keys.has(key)));
  const questions = previous.questions.filter(q => keys.has(q.itemKey));
  const questionIds = new Set(questions.map(q => q.id));
  return {
    ...previous, items, questions,
    progress: byItem(previous.progress), notes: byItem(previous.notes), excerpts: byItem(previous.excerpts),
    events: previous.events.filter(e => keys.has(e.itemKey) && questionIds.has(e.questionId)),
    attempts: Object.fromEntries(Object.entries(previous.attempts).filter(([, a]) =>
      keys.has(a.itemKey) && questionIds.has(a.questionId))),
    sources: previous.sources.filter(s => s.platform === "douyin"),
    baselineCutoffs: Object.fromEntries(Object.entries(previous.baselineCutoffs ?? {}).filter(([key]) => key.startsWith("douyin:"))),
    warnings: []
  };
}

export async function importCollections(dataDir, previous = emptyState()) {
  previous = retainDouyinState(previous);
  const batches = [];
  for (const root of ["local-browser", "daily/runs"]) {
    for (const path of await snapshots(join(dataDir, root))) {
      const data = await optionalJson(path);
      if (!data?.favorites || !data.account?.id || !Number.isFinite(Date.parse(data.at))) continue;
      if (data.platform && data.platform !== "douyin") continue;
      batches.push({ platform: "douyin", accountId: String(data.account.id), at: data.at, items: data.favorites,
        folders: data.folders ?? [], complete: data.complete === true, scope: data.scope,
        expected: data.expectedFavorites ?? null, origin: "snapshot" });
    }
  }
  batches.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // Pin one account per platform. A later different login must not mix two people's library.
  const accounts = new Map(previous.sources.map(s => [s.platform, s.accountId]));
  for (const batch of batches) if (!accounts.has(batch.platform)) accounts.set(batch.platform, batch.accountId);
  const map = new Map(previous.items.map(i => [i.key, { ...i }]));
  const baselineCutoffs = { ...(previous.baselineCutoffs ?? {}) };
  for (const batch of batches) {
    const scope = `${batch.platform}:${batch.accountId}`;
    if (!(scope in baselineCutoffs)) baselineCutoffs[scope] = batches.filter(b => `${b.platform}:${b.accountId}` === scope).at(-1).at;
  }
  const sources = new Map(previous.sources.map(s => [s.platform, s]));
  for (const batch of batches) {
    if (accounts.get(batch.platform) !== batch.accountId || !Number.isFinite(Date.parse(batch.at))) continue;
    const scope = `${batch.platform}:${batch.accountId}`;
    const memberships = new Map();
    for (const folder of batch.folders) for (const item of folder.items ?? []) {
      const list = memberships.get(String(item.id)) ?? [];
      list.push(folder.name);
      memberships.set(String(item.id), list);
    }
    for (const raw of batch.items) {
      if (!raw.id) continue;
      const id = String(raw.id), key = `${scope}:${id}`, old = map.get(key);
      const cats = memberships.get(id);
      const firstSeenAt = old && Date.parse(old.firstSeenAt) < Date.parse(batch.at) ? old.firstSeenAt : batch.at;
      // An incomplete first import is still a historical baseline; do not present it as "new today".
      const baseline = old?.baseline ?? Date.parse(batch.at) <= Date.parse(baselineCutoffs[scope]);
      const url = `https://www.douyin.com/video/${encodeURIComponent(id)}`;
      map.set(key, {
        key, id, platform: batch.platform, accountId: batch.accountId,
        title: raw.title || old?.title || "未命名收藏",
        author: raw.author || old?.author || "作者未记录",
        type: "video",
        description: raw.description || old?.description || "",
        hashtags: Array.isArray(raw.hashtags) ? raw.hashtags.filter(x => typeof x === "string") : old?.hashtags ?? [],
        durationMs: Number.isFinite(raw.durationMs) && raw.durationMs > 0 ? raw.durationMs : old?.durationMs ?? null,
        categories: cats?.length ? [...new Set(cats.map(categoryName))] : old?.categories ?? ["未分类"],
        categoryBasis: old?.categoryBasis ?? "收藏夹",
        firstSeenAt, lastSeenAt: batch.at, baseline, url
      });
    }
    sources.set(batch.platform, { platform: batch.platform, accountId: batch.accountId, at: batch.at,
      complete: batch.complete, syncScope: batch.scope, expected: batch.expected,
      readable: [...map.values()].filter(i => i.platform === batch.platform && i.accountId === batch.accountId).length,
      lastRead: batch.items.length });
  }
  const items = [...map.values()].sort((a, b) => Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt) || a.key.localeCompare(b.key));
  return { ...previous, items, sources: [...sources.values()], baselineCutoffs, importedAt: new Date().toISOString() };
}
