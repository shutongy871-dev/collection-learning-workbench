import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectionGrowthSeries, collectionFolderCounts } from "../src/learning/domain.mjs";
import { importCollections } from "../src/learning/import.mjs";

const item = (key, day, folderKeys = []) => ({ key, id: key, firstSeenAt: `${day}T01:00:00Z`,
  folderKeys, baseline: true });
test("趋势只去掉首次入库前的零值，入库后的平稳日期完整保留", () => {
  const items = [item("a", "2026-10-11"), item("b", "2026-10-13")];
  const series = collectionGrowthSeries(items, "2026-09-24", "2026-10-14");
  assert.deepEqual(series.map(d => [d.date, d.total]), [
    ["2026-10-11", 1], ["2026-10-12", 1], ["2026-10-13", 2], ["2026-10-14", 2]
  ]);
  assert.equal(collectionGrowthSeries(items, "2026-10-12", "2026-10-14")[0].total, 1);
  assert.deepEqual(collectionGrowthSeries([], "2026-10-01", "2026-10-14"), []);
});
test("收藏夹筛选在趋势聚合前执行，未分类独立筛选，空夹无伪造零线", () => {
  const items = [item("a", "2026-10-11", ["one", "two"]), item("b", "2026-10-13", ["two"]),
    item("c", "2026-10-14")];
  assert.equal(collectionGrowthSeries(items, "2026-10-01", "2026-10-14", "one").at(-1).total, 1);
  assert.equal(collectionGrowthSeries(items, "2026-10-01", "2026-10-14", "two").at(-1).total, 2);
  assert.equal(collectionGrowthSeries(items, "2026-10-01", "2026-10-14", "unclassified")[0].date, "2026-10-14");
  assert.deepEqual(collectionGrowthSeries(items, "2026-10-01", "2026-10-14", "empty"), []);
});
test("饼图按真实夹ID分别去重，包含空夹和未分类，多夹成员分别计数", () => {
  const items = [item("a", "2026-10-11", ["one", "one", "two"]),
    item("a", "2026-10-11", ["one", "two"]), item("b", "2026-10-12", ["two"]), item("c", "2026-10-13", ["deleted"])];
  const rows = collectionFolderCounts(items, [
    { key: "one", name: "摄影练习" }, { key: "two", name: "摄影参考" }, { key: "empty", name: "空夹" }
  ]);
  assert.deepEqual(Object.fromEntries(rows.map(r => [r.key, r.count])), { two: 2, one: 1, unclassified: 1, empty: 0 });
});

test("导入保留原始夹名及ID；仅有目录的增量不清空成员，改名和成员读回更新历史归属", async t => {
  const dir = await mkdtemp(join(tmpdir(), "collection-folders-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const folder = join(dir, "local-browser");
  await mkdir(folder, { recursive: true });
  const file = join(folder, "snapshot.json");
  const a = { id: "a", title: "摄影" }, b = { id: "b", title: "摄影" };
  const full = { at: "2026-10-11T01:00:00Z", account: { id: "account" }, complete: true,
    favorites: [a, b], folders: [{ id: "one", name: "拍照练习", items: [a] },
      { id: "two", name: "拍照参考", items: [a, b] }, { id: "empty", name: "空夹", items: [] }] };
  await writeFile(file, JSON.stringify(full));
  let state = await importCollections(dir);
  const key = id => `douyin:account:folder:${id}`;
  assert.equal(state.folders.length, 3);
  assert.equal(new Set(state.items.flatMap(i => i.categories)).size, 1);
  assert.equal(collectionFolderCounts(state.items, state.folders).find(f => f.key === key("two")).count, 2);
  const firstSeen = state.items.find(i => i.id === "a").firstSeenAt;
  state.notes["douyin:account:a"] = { text: "保留记录" };
  await writeFile(file, JSON.stringify({ ...full, at: "2026-10-12T01:00:00Z",
    complete: false, scope: "incremental_favorites", favorites: [a],
    folders: full.folders.map(({ items, ...f }) => ({ ...f, name: f.id === "one" ? "拍照新名字" : f.name })) }));
  state = await importCollections(dir, state);
  assert.equal(collectionFolderCounts(state.items, state.folders).find(f => f.key === key("two")).count, 2);
  assert.equal(state.folders.find(f => f.id === "one").name, "拍照新名字");
  await writeFile(file, JSON.stringify({ ...full, at: "2026-10-13T01:00:00Z",
    complete: false, scope: "classification_readback", favorites: [a],
    folders: [{ id: "one", name: "拍照新名字", items: [] }, { id: "two", name: "拍照参考", items: [a] }] }));
  state = await importCollections(dir, state);
  assert.deepEqual(state.items.find(i => i.id === "b").folderKeys, []);
  assert.deepEqual(state.items.find(i => i.id === "b").categories, ["未分类"]);
  assert.equal(state.folders.length, 2);
  assert.equal(state.items.find(i => i.id === "a").firstSeenAt, firstSeen);
  assert.equal(state.notes["douyin:account:a"].text, "保留记录");
});
