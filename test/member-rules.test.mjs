import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnFolderRules, matchesFolderRule } from "../scripts/folder-rules.mjs";
import { ensureDefaultFolders } from "../scripts/ensure-default-folders.mjs";
import { defaultFolders, defaultFolderName } from "../scripts/default-folders.mjs";
import { refreshDailyClassification } from "../scripts/daily.mjs";

const samples = (prefix, title, n = 3) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, title }));
const folder = (id, name, items = []) => ({ id, name, owner: "account", items });
const page = data => ({ query: { cursor: "0" }, status: 200, code: 0, hasMore: false, ...data });
function snapshot(folders = [], unclassified = []) {
  const favorites = [...folders.flatMap(f => f.items), ...unclassified];
  return { complete: true, account: { id: "account" }, folderPages: [page({ folders })],
    folders: folders.map(f => ({ ...f, pages: [page({ items: f.items, itemsType: "array", requestSeq: 2,
      query: { cursor: "0", collects_id: f.id } })], ...(f.items.length ? {} : {
      emptyEvidence: { folderId: f.id, accountId: f.owner, folderTotal: 0,
        clickMark: 1, emptyText: "暂无收藏作品", visibleItems: 0 } }) })),
    favoritePages: [page({ items: favorites })], favorites, unclassified };
}
function adapter(initial = []) {
  const a = { folders: structuredClone(initial), created: [], saved: null, accountId: "account",
    async list() { return { accountId: a.accountId, folders: structuredClone(a.folders) }; },
    async create(name) { a.created.push(name); a.folders.push({ id: `real-${a.created.length}`, name }); },
    async persist(state) { a.saved = structuredClone(state); } };
  return a;
}

test("自定义收藏夹从三个不同成员学习新词，新视频不必包含夹名", () => {
  const rules = learnFolderRules([folder("x", "收藏夹1", samples("x", "攀岩 推荐")),
    folder("y", "旅行", samples("y", "海岛 推荐"))]);
  assert.equal(rules[0].trainingVideos, 3);
  assert.ok(rules[0].learnedKeywords.some(k => k.keyword === "攀岩" && k.support === 3));
  assert.equal(matchesFolderRule({ title: "攀岩装备" }, rules[0]), true);
  assert.equal(rules.flatMap(r => r.learnedKeywords).some(k => k.keyword === "推荐"), false);
});

test("重复视频、重复词和跨夹成员不增加支持样本", () => {
  const items = samples("x", "攀岩 攀岩", 2);
  const [r] = learnFolderRules([folder("x", "收藏夹1", [...items, ...items])]);
  assert.equal(r.trainingVideos, 2);
  assert.equal(r.learnedKeywords.length, 0);
  const shared = samples("shared", "攀岩");
  assert.equal(learnFolderRules([folder("x", "收藏夹1", shared), folder("y", "收藏夹2", shared)])
    .every(r => r.trainingVideos === 0 && !r.enabled), true);
});

test("跨夹常见词与小夹高频词不会因大夹样本多而误学习", () => {
  const rules = learnFolderRules([folder("x", "收藏夹1", samples("x", "攀岩", 30)),
    folder("y", "收藏夹2", samples("y", "攀岩", 3))]);
  assert.equal(rules.every(r => r.learnedKeywords.length === 0), true);
});

test("低于80%纯度的词不学，排除条件不能被成员学习覆盖", () => {
  const rules = learnFolderRules([folder("x", "收藏夹1", samples("x", "攀岩", 3)),
    folder("y", "收藏夹2", samples("y", "攀岩", 1))]);
  assert.equal(rules[0].learnedKeywords.length, 0);
  const [excluded] = learnFolderRules([folder("x", "烘焙（不含面包）", samples("x", "面包 烘焙"))]);
  assert.equal(excluded.learnedKeywords.some(k => k.keyword === "面包"), false);
  assert.equal(matchesFolderRule({ title: "面包烘焙" }, excluded), false);
});

test("完整标签可学习；重名夹仍停用；其他不会兜底接收", () => {
  const items = samples("x", "视频").map(i => ({ ...i, hashtags: ["岩壁安全"] }));
  const [r] = learnFolderRules([folder("x", "其他", items)]);
  assert.ok(r.learnedKeywords.some(k => k.keyword === "岩壁安全"));
  assert.equal(matchesFolderRule({ title: "无关内容" }, r), false);
  assert.equal(learnFolderRules([folder("x", "摄影", items), folder("y", "b摄影", samples("y", "海岛"))])
    .every(r => !r.enabled), true);
});

test("默认模板保留14类，无账号ID，创建名符合15字限制；只在默认分支注入种子", () => {
  assert.equal(defaultFolders.length, 14);
  assert.equal(new Set(defaultFolders.map(defaultFolderName)).size, 14);
  assert.ok(defaultFolders.every(t => defaultFolderName(t).length <= 15 && !t.id));
  const t = defaultFolders.find(t => t.name.includes("书籍"));
  const f = folder("x", defaultFolderName(t));
  assert.equal(learnFolderRules([f])[0].defaultTemplateApplied, false);
  assert.equal(learnFolderRules([f], { useDefaults: true })[0].defaultTemplateApplied, true);
});

test("每日入口从校验后的成员页训练，不使用伪造items缓存；账号切换不沿用旧词", async () => {
  const dir = await mkdtemp(join(tmpdir(), "member-rules-"));
  try {
    const s = snapshot([folder("x", "收藏夹1", samples("x", "攀岩"))], [{ id: "new", title: "攀岩装备" }]);
    s.folders[0].items = samples("fake", "海岛");
    const result = await refreshDailyClassification(s, "account", dir, dir);
    assert.equal(result.plan.decisions[0].itemId, "new");
    assert.equal(result.report.rules[0].learnedKeywords.some(k => k.keyword === "海岛"), false);
    const next = snapshot([folder("new-id", "收藏夹1", samples("y", "海岛"))]);
    next.account.id = "other";
    next.folders[0].owner = "other";
    const updated = await refreshDailyClassification(next, "other", dir, dir);
    assert.equal(updated.report.rules[0].learnedKeywords.some(k => k.keyword === "攀岩"), false);
    assert.equal(JSON.parse(await readFile(join(dir, "rules-update.json"))).accountId, "other");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("空目录创建14个默认夹并读回真实ID；已有用户目录跳过", async () => {
  const a = adapter();
  const result = await ensureDefaultFolders(snapshot(), "account", a);
  assert.equal(result.status, "completed");
  assert.equal(a.created.length, 14);
  assert.ok(result.entries.every(e => e.status === "verified" && e.id.startsWith("real-")));
  const b = adapter();
  assert.equal((await ensureDefaultFolders(snapshot([folder("x", "我自己的")]), "account", b)).skipped, true);
  assert.equal(b.created.length, 0);
});

test("提交后中断保留进度，重试读回已有夹，不重复创建", async () => {
  const a = adapter();
  const create = a.create;
  a.create = async name => { await create(name); throw new Error("interrupted"); };
  await assert.rejects(ensureDefaultFolders(snapshot(), "account", a), /interrupted/);
  assert.equal(a.saved.entries[0].status, "submitting");
  a.create = create;
  const result = await ensureDefaultFolders(snapshot(a.folders.map(f => folder(f.id, f.name))), "account", a, a.saved);
  assert.equal(result.status, "completed");
  assert.equal(a.created.length, 14);
  assert.equal(result.entries.length, 14);
});

test("扫描后出现用户目录、不完整分页或账号变化，创建前停止", async () => {
  const a = adapter([{ id: "x", name: "自定义" }]);
  await assert.rejects(ensureDefaultFolders(snapshot(), "account", a), /user_folders_changed/);
  assert.equal(a.created.length, 0);
  const incomplete = snapshot();
  incomplete.folderPages[0].hasMore = true;
  await assert.rejects(ensureDefaultFolders(incomplete, "account", adapter()), /incomplete_page/);
  const b = adapter(); b.accountId = "other";
  await assert.rejects(ensureDefaultFolders(snapshot(), "account", b), /account_changed/);
  await assert.rejects(ensureDefaultFolders(snapshot(), "account", b,
    { accountId: "other", entries: [] }), /checkpoint_account/);
});

test("未读回新建夹即停止，不将点击当作成功；重名目标拒绝恢复", async () => {
  const a = adapter(); a.create = async name => { a.created.push(name); };
  await assert.rejects(ensureDefaultFolders(snapshot(), "account", a), /readback_missing/);
  assert.equal(a.created.length, 1);
  assert.equal(a.saved.entries[0].status, "submitting");
  const name = defaultFolderName(defaultFolders[0]);
  const b = adapter([{ id: "1", name }, { id: "2", name }]);
  await assert.rejects(ensureDefaultFolders(snapshot(), "account", b,
    { accountId: "account", entries: [{ name, status: "submitting" }] }), /duplicate_default/);
});
