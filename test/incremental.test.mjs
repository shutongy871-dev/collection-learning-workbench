import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { incrementalReady, findBoundary, newCandidates, nextCheckpoint, mergePending,
  folderSignature, auditIntervalMs } from "../scripts/incremental-policy.mjs";
import { buildDailyPlan } from "../scripts/daily-policy.mjs";
import { refreshDailyClassification } from "../scripts/daily.mjs";
import { finishPages, provePages, unique } from "../scripts/local-scan.mjs";
import { importCollections, emptyState } from "../src/learning/import.mjs";

const at = "2026-10-23T01:00:00.000Z";
const old = Array.from({ length: 500 }, (_, n) => ({ id: `old-${n}`, title: "AI" }));
const folders = [{ id: "folder", name: "AI", owner: "account" }];
const checkpoint = {
  version: 1, accountId: "account", lastFullAt: at, headIds: old.slice(0, 20).map(i => i.id),
  knownIds: old.map(i => i.id), folderSignature: folderSignature(folders),
  pending: [{ id: "old-pending", title: "待分类" }]
};
const page = (items, extra = {}) => ({
  status: 200, code: 0, query: { cursor: "0" }, body: {}, cursor: 10, hasMore: true, items, ...extra
});
function snapshot(newItems = [], filed = []) {
  const favorites = [...newItems, ...old.slice(0, 10)];
  const emptyEvidence = { folderId: "folder", accountId: "account", folderTotal: 0,
    clickMark: 1, emptyText: "暂无收藏作品", visibleItems: 0 };
  return {
    at, account: { id: "account" }, complete: false, scope: "incremental_favorites",
    incremental: { checkpoint, boundary: findBoundary(favorites, checkpoint) },
    favoritePages: [page(favorites)], favorites,
    folderPages: [page([], { folders, hasMore: false })],
    folders: newItems.length ? folders.map(f => ({ ...f, items: filed,
      pages: [page(filed, { query: { cursor: "0", collects_id: f.id }, requestSeq: 2,
        itemsType: "array", hasMore: false })], ...(filed.length ? {} : { emptyEvidence }) })) : folders,
    unclassified: newItems.filter(i => !filed.some(f => f.id === i.id))
  };
}

test("增量条件：账号、收藏夹名称及七天核对边界；首次/缺锚点均全量", () => {
  assert.equal(incrementalReady(checkpoint, "account", folders, new Date(at)), true);
  assert.equal(incrementalReady(null, "account", folders, new Date(at)), false);
  assert.equal(incrementalReady(checkpoint, "other", folders, new Date(at)), false);
  assert.equal(incrementalReady(checkpoint, "account", [{ ...folders[0], name: "changed" }], new Date(at)), false);
  assert.equal(incrementalReady(checkpoint, "account", folders, new Date(Date.parse(at) + auditIntervalMs)), false);
  assert.equal(incrementalReady({ ...checkpoint, headIds: ["unknown"] }, "account", folders, new Date(at)), false);
});

test("连续旧锚点可跨页，删除部分旧收藏仍可找到后续锚点；单个旧项不截断", () => {
  const fresh = [{ id: "new" }];
  assert.equal(findBoundary([...fresh, old[0], { id: "another-new" }], checkpoint), null);
  const prefix = [...fresh, ...old.slice(2, 12)];
  assert.ok(findBoundary(prefix, checkpoint));
  assert.deepEqual(newCandidates(prefix, checkpoint), fresh);
  assert.equal(findBoundary([...old.slice(0, 5), ...fresh], checkpoint), null);
  assert.equal(findBoundary([...old.slice(0, 5)].reverse(), checkpoint), null);
});

test("500条历史收藏：已验证第一页找到边界后不调用DOM或请求下一页，仍不能证明全量", async () => {
  const first = page(old.slice(0, 10));
  const chain = await finishPages({}, { flush: async () => {} }, "/aweme/listcollection/",
    () => [first], { stopWhen: pages => Boolean(findBoundary(unique(pages, "items"), checkpoint)) });
  assert.equal(chain.length, 1);
  assert.throws(() => provePages(chain), /incomplete_page:10/);
  await assert.rejects(finishPages({}, { flush: async () => {} }, "/aweme/listcollection/",
    () => [{ ...first, status: 403 }], { stopWhen: () => true }), /platform_forbidden/);
  await assert.rejects(finishPages({}, { flush: async () => {} }, "/aweme/listcollection/",
    () => [{ ...first, query: { cursor: "10" } }], { stopWhen: () => true }), /incomplete_page:0/);
});

test("增量计划只处理新ID且用当前完整成员排重；历史待分类不伪造为本轮候选", () => {
  const fresh = [{ id: "new-ai", title: "AI" }, { id: "new-filed", title: "AI" }];
  const data = snapshot(fresh, [fresh[1]]);
  const plan = buildDailyPlan(data, [{ folderId: "folder", folderName: "AI", keywords: ["ai"] }], "account");
  assert.equal(plan.total, 1);
  assert.deepEqual(plan.decisions.map(i => i.itemId), ["new-ai"]);
  assert.throws(() => buildDailyPlan(data, [], "other"), /unverified/);
  const incompleteMembers = structuredClone(data);
  incompleteMembers.folders[0].pages[0].hasMore = true;
  assert.throws(() => buildDailyPlan(incompleteMembers, [], "account"), /incomplete_page/);
});

test("增量不能用缓存或伪造未分类范围执行；无新增可跳过成员但必须证明账号和前缀", () => {
  assert.equal(buildDailyPlan(snapshot(), [], "account").total, 0);
  const forged = snapshot();
  forged.unclassified = [old[0]];
  assert.throws(() => buildDailyPlan(forged, [], "account"), /scope_mismatch/);
  const noBoundary = snapshot();
  noBoundary.favoritePages[0].items = [{ id: "unknown" }];
  noBoundary.favorites = noBoundary.favoritePages[0].items;
  assert.throws(() => buildDailyPlan(noBoundary, [], "account"), /boundary_unverified/);
  const missingMembers = snapshot([{ id: "new", title: "AI" }]);
  delete missingMembers.folders[0].pages;
  assert.throws(() => buildDailyPlan(missingMembers, [], "account"));
});

test("无新增不训练成员规则；真实refresh入口可生成空计划", async t => {
  const dir = await mkdtemp(join(tmpdir(), "incremental-rules-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { plan, report } = await refreshDailyClassification(snapshot(), "account", dir, dir);
  assert.equal(plan.total, 0);
  assert.equal(report.skipped, true);
});

test("待分类跨增量保留，只有当前已读回成功项消除；全量重新核对待分类差集", () => {
  const fresh = [{ id: "verified", title: "AI" }, { id: "unmatched", title: "其它" }];
  const data = snapshot(fresh);
  const plan = { unresolved: [fresh[1]] };
  const state = { entries: { verified: { status: "verified" } } };
  assert.deepEqual(mergePending(checkpoint, data, plan, state).map(i => i.id), ["old-pending", "unmatched"]);
  const next = nextCheckpoint(checkpoint, data, mergePending(checkpoint, data, plan, state), new Date(at));
  assert.equal(next.lastFullAt, checkpoint.lastFullAt);
  assert.equal(next.knownIds.length, 502);
  assert.throws(() => nextCheckpoint(checkpoint, { ...data, scope: "classification_readback" }, []), /scope_invalid/);
  assert.deepEqual(mergePending(checkpoint, { ...data, complete: true }, plan, state).map(i => i.id), ["unmatched"]);
});

test("执行定位：全部待写ID已加载便停止翻页，不为已验证项读取历史页", async () => {
  const needed = new Set(["new"]);
  const chain = await finishPages({}, { flush: async () => {} }, "/aweme/listcollection/",
    () => [page([{ id: "new" }, ...old.slice(0, 9)])], {
      stopWhen: pages => [...needed].every(id => unique(pages, "items").some(i => i.id === id))
    });
  assert.equal(chain.length, 1);
});

test("导入增量和分类读回保留历史收藏、学习进度和未分类；来源数量不会降成前缀数量", async t => {
  const dir = await mkdtemp(join(tmpdir(), "incremental-import-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = join(dir, "daily/runs/run");
  await mkdir(run, { recursive: true });
  const baseline = { ...emptyState(), sources: [{ platform: "douyin", accountId: "account" }],
    items: old.map(i => ({ ...i, key: `douyin:account:${i.id}`, platform: "douyin", accountId: "account",
      categories: ["未分类"], firstSeenAt: "2026-10-22T01:00:00Z", baseline: true })),
    progress: { "douyin:account:old-499": { viewed: true } } };
  const fresh = { id: "new-ai", title: "AI" }, data = snapshot([fresh]);
  await writeFile(join(run, "snapshot.json"), JSON.stringify(data));
  await writeFile(join(run, "final-snapshot.json"), JSON.stringify({ ...data,
    at: "2026-10-23T01:01:00Z", scope: "classification_readback",
    folders: [{ ...folders[0], items: [fresh] }] }));
  const imported = await importCollections(dir, baseline);
  assert.equal(imported.items.length, 501);
  assert.deepEqual(imported.progress, baseline.progress);
  assert.deepEqual(imported.items.find(i => i.id === "old-499").categories, ["未分类"]);
  assert.deepEqual(imported.items.find(i => i.id === fresh.id).categories, ["AI"]);
  assert.equal(imported.sources[0].readable, 501);
  assert.equal(imported.sources[0].complete, false);
});
