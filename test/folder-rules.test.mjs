import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFolderRules, matchesFolderRule, diffFolderRules } from "../scripts/folder-rules.mjs";
import { refreshDailyClassification, putJson } from "../scripts/daily.mjs";

const folder = (id, name) => ({ id, name, owner: "account" });
const matches = (rules, title) => rules.filter(r => matchesFolderRule({ title }, r)).map(r => r.folderId);
const page = data => ({ query: { cursor: "0" }, status: 200, code: 0, hasMore: false, ...data });
const snapshot = folders => ({
  account: { id: "account" }, at: "2026-10-11T14:00:00Z", complete: true,
  folderPages: [page({ folders })],
  folders: folders.map(f => ({ ...f, pages: [page({ items: [], itemsType: "array", requestSeq: 2,
    query: { cursor: "0", collects_id: f.id } })], emptyEvidence: { folderId: f.id,
    accountId: f.owner, folderTotal: 0, clickMark: 1, emptyText: "暂无收藏作品", visibleItems: 0 } })),
  favoritePages: [page({ items: [{ id: "video", title: "曲奇烘焙教程" }] })],
  unclassified: [{ id: "video", title: "曲奇烘焙教程" }]
});

test("新增收藏夹按名称选择词库；未收录主题仍可字面匹配，不受旧12组限制", () => {
  const rules = generateFolderRules([folder("1", "01. 烘焙"), folder("2", "露营"), folder("3", "b摄影")]);
  assert.deepEqual(matches(rules, "蛋糕和曲奇"), ["1"]);
  assert.deepEqual(matches(rules, "周末露营装备"), ["2"]);
  assert.deepEqual(matches(rules, "人像构图"), ["3"]);
});

test("保留真实字符串ID，同夹改名后彻底重建关键词；删除夹不再生成规则", () => {
  const old = generateFolderRules([folder("9000000000000000010", "拍照"), folder("removed", "购物")]);
  const current = generateFolderRules([folder("9000000000000000010", "烘焙")]);
  assert.deepEqual(matches(current, "人像摄影"), []);
  assert.deepEqual(matches(current, "面包制作"), ["9000000000000000010"]);
  assert.deepEqual(diffFolderRules(old, current).map(d => d.type), ["renamed", "removed"]);
  assert.deepEqual(diffFolderRules(current, current), []);
});

test("名称排除条件不会反向成为正向关键词；非AI非商业非宏经非英语有效", () => {
  const rules = generateFolderRules([
    folder("general", "a知识（非AI非商业非宏经非英语"),
    folder("ai", "a ai知识"), folder("english", "a英语（非口语）"),
    folder("spoken", "a商务口语")
  ]);
  assert.deepEqual(matches(rules, "AI科普"), ["ai"]);
  assert.deepEqual(matches(rules, "历史知识科普"), ["general"]);
  assert.deepEqual(matches(rules, "雅思英语口语"), ["spoken"]);
  assert.deepEqual(matches(rules, "英语语法"), ["english"]);
  assert.deepEqual(matches(rules, "商业模式科普"), []);
  assert.deepEqual(matches(rules, "宏观经济科普"), []);
});

test("不含与排除支持具体词；ASCII词有边界，不把said当AI", () => {
  const rules = generateFolderRules([folder("bake", "烘焙（不含面包）"), folder("ai", "AI")]);
  assert.deepEqual(matches(rules, "曲奇"), ["bake"]);
  assert.deepEqual(matches(rules, "面包烘焙"), []);
  assert.deepEqual(matches(rules, "she said hello"), []);
  assert.deepEqual(matches(rules, "chatgpt"), ["ai"]);
  assert.deepEqual(matches(generateFolderRules([folder("x", "烘焙（排除饼干）")]), "饼干"), []);
});

test("名称模糊或重名时停用；其他不接收所有未命中内容", () => {
  const rules = generateFolderRules([
    folder("1", "其他（非知识非时尚非吃喝玩拍"), folder("2", "收藏夹1"),
    folder("3", "摄影"), folder("4", "b摄影")
  ]);
  assert.equal(rules.every(r => !r.enabled), true);
  assert.deepEqual(matches(rules, "旅行摄影"), []);
  assert.throws(() => generateFolderRules([folder(123, "AI")]), /invalid_folder/);
});

test("实际每日编排先刷新再分类，归档旧规则及变更，零旧关键词残留", async () => {
  const base = await mkdtemp(join(tmpdir(), "folder-sync-"));
  const run = join(base, "run");
  await mkdir(run);
  try {
    const old = generateFolderRules([folder("target", "拍照"), folder("deleted", "购物")]);
    await putJson(join(base, "rules.json"), old);
    const { plan, report } = await refreshDailyClassification(
      snapshot([folder("target", "烘焙"), folder("new", "健身")]), "account", base, run);
    assert.equal(plan.decisions[0].folderId, "target");
    assert.equal(plan.decisions[0].folderName, "烘焙");
    assert.deepEqual(report.changes.map(c => c.type), ["renamed", "added", "removed"]);
    const saved = JSON.parse(await readFile(join(base, "rules.json")));
    assert.deepEqual(matches(saved, "摄影"), []);
    assert.deepEqual(JSON.parse(await readFile(join(base, "rules-before-name-sync.json"))), old);
    const evidence = JSON.parse(await readFile(join(run, "rules-update.json")));
    assert.equal(evidence.snapshotHash, plan.snapshotHash);
    assert.equal(evidence.rulesHash, plan.rulesHash);
    const again = await refreshDailyClassification(snapshot([folder("target", "烘焙"), folder("new", "健身")]),
      "account", base, run);
    assert.deepEqual(again.report.changes, []);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("分页缺失或账号不符时，不覆盖可用规则、不退回旧规则出计划", async () => {
  const base = await mkdtemp(join(tmpdir(), "folder-sync-failure-"));
  try {
    const old = generateFolderRules([folder("old", "AI")]);
    await putJson(join(base, "rules.json"), old);
    const incomplete = snapshot([folder("new", "烘焙")]);
    incomplete.favoritePages[0].hasMore = true;
    await assert.rejects(refreshDailyClassification(incomplete, "account", base, base), /incomplete_page/);
    await assert.rejects(refreshDailyClassification(snapshot([folder("new", "烘焙")]), "other", base, base), /unverified/);
    const emptyPrefetch = snapshot([folder("new", "烘焙")]);
    delete emptyPrefetch.folders[0].emptyEvidence;
    await assert.rejects(refreshDailyClassification(emptyPrefetch, "account", base, base), /empty_members_unverified/);
    assert.deepEqual(JSON.parse(await readFile(join(base, "rules.json"))), old);
    await assert.rejects(readFile(join(base, "classification-plan.json")), { code: "ENOENT" });
  } finally { await rm(base, { recursive: true, force: true }); }
});
