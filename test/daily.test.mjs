import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dailyDue, buildDailyPlan } from "../scripts/daily-policy.mjs";
import { acquireLock, putJson } from "../scripts/daily.mjs";
import { setupDaily } from "../scripts/setup-daily.mjs";
import { execute } from "../src/understanding/media.mjs";
import { runtimeEnvironment } from "../scripts/runtime-config.mjs";

const config = { enabled: true, startsAt: "2026-10-12T01:00:00.000Z" };
const rules = [{ folderName: "AI", keywords: ["ai"] }, { folderName: "拍照", keywords: ["摄影"] }];
const page = (data) => ({ query: { cursor: "0" }, status: 200, code: 0, hasMore: false, ...data });
function snapshot() {
  const folders = [{ id: "9000000000000000010", name: "AI", owner: "account" },
    { id: "2", name: "拍照", owner: "account" }];
  const favorites = [{ id: "old", title: "AI", create_time: 1 }, { id: "filed", title: "摄影" },
    { id: "conflict", title: "AI 摄影" }, { id: "unknown", title: "hello" }];
  return { account: { id: "account" }, complete: true,
    folderPages: [page({ folders })],
    folders: folders.map(f => ({ ...f, pages: [page({ items: f.id === "2" ? [favorites[1]] : [],
      itemsType: "array", requestSeq: 2, query: { cursor: "0", collects_id: f.id } })],
      ...(f.id === "2" ? {} : { emptyEvidence: { folderId: f.id, accountId: f.owner,
        folderTotal: 0, clickMark: 1, emptyText: "暂无收藏作品", visibleItems: 0 } }) })),
    favoritePages: [page({ items: favorites })],
    unclassified: [favorites[0], ...favorites.slice(2)] };
}
test("账号绑定：读取当次身份、迁移旧账号日历记录、保留暂停开关，不进行分类", async t => {
  const dir=await mkdtemp(join(tmpdir(),"collection-setup-test-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await putJson(join(dir,"config.json"),{...config,enabled:false,accountId:"old"});
  await putJson(join(dir,"ledger.json"),{"2026-10-12":{status:"blocked"}});
  const result=await setupDaily(dir,async()=>({id:"new",nickname:"当前账号"}),new Date("2026-10-16T08:00:00Z"));
  const saved=JSON.parse(await readFile(join(dir,"config.json"),"utf8"));
  const ledger=JSON.parse(await readFile(join(dir,"ledger.json"),"utf8"));
  assert.equal(saved.accountId,"new");assert.equal(saved.enabled,false);
  assert.equal(result.changed,true);assert.equal(result.classificationPerformed,false);
  assert.deepEqual(ledger,{"old:2026-10-12":{status:"blocked",accountId:"old"}});
});
test("账号绑定：登录读取失败或执行锁占用时不覆盖原账号；失败后释放锁", async t => {
  const dir=await mkdtemp(join(tmpdir(),"collection-setup-test-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const original={...config,accountId:"old"};
  await putJson(join(dir,"config.json"),original);
  await assert.rejects(setupDaily(dir,async()=>{throw Error("login_required");}),/login_required/);
  assert.deepEqual(JSON.parse(await readFile(join(dir,"config.json"),"utf8")),original);
  const lock=await acquireLock(join(dir,"execution.lock"));
  assert.ok(lock);
  try {
    await assert.rejects(setupDaily(dir,async()=>{assert.fail("锁占用时不应读取平台");}),/another_run_in_progress/);
  } finally {await lock.release();}
});
test("安装当晚不补跑；北京时间09:00触发，失败不当日重试，唤醒及次日可运行", () => {
  assert.equal(dailyDue(config, {}, new Date("2026-10-11T14:00:00Z")), null);
  assert.equal(dailyDue(config, {}, new Date("2026-10-12T00:59:59Z")), null);
  assert.equal(dailyDue(config, {}, new Date("2026-10-12T01:00:00Z")).scheduleDate, "2026-10-12");
  assert.equal(dailyDue(config, {}, new Date("2026-10-12T03:00:00Z")).delayed, true);
  const ledger = { "2026-10-12": { status: "blocked" } };
  assert.equal(dailyDue(config, ledger, new Date("2026-10-12T03:00:00Z")), null);
  assert.equal(dailyDue(config, ledger, new Date("2026-10-13T01:00:00Z")).scheduleDate, "2026-10-13");
  assert.equal(dailyDue({ ...config, enabled: false }, {}, new Date("2026-10-12T03:00:00Z")), null);
});
test("全量存量差集只含未归类项，使用真实字符串ID；冲突和未命中留待处理", () => {
  const plan = buildDailyPlan(snapshot(), rules, "account");
  assert.equal(plan.total, 3);
  assert.equal(plan.decisions.length, 1);
  assert.equal(plan.decisions[0].itemId, "old");
  assert.equal(plan.decisions[0].folderId, "9000000000000000010");
  assert.deepEqual(plan.unresolved.map(i => i.reason), ["conflicting_rules", "no_rule_match"]);
});
test("账号变化、不完整分页、伪造未分类范围均阻止生成计划", () => {
  assert.throws(() => buildDailyPlan(snapshot(), rules, "other"), /unverified/);
  const incomplete = snapshot();
  incomplete.favoritePages[0].hasMore = true;
  assert.throws(() => buildDailyPlan(incomplete, rules, "account"), /incomplete_page/);
  const wrong = snapshot();
  wrong.unclassified = [];
  assert.throws(() => buildDailyPlan(wrong, rules, "account"), /scope_mismatch/);
});
test("旧版快照虽标完整，空夹没有独立页面证据仍拒绝生成计划", () => {
  const old = snapshot();
  delete old.folders[0].emptyEvidence;
  assert.throws(() => buildDailyPlan(old, rules, "account"), /empty_members_unverified/);
});
test("新快照不会重复执行已归类项，也不会沿用旧文件夹ID", () => {
  const before = snapshot();
  const after = structuredClone(before);
  after.folders[0].pages[0].items.push(before.unclassified[0]);
  after.unclassified.shift();
  const a = buildDailyPlan(before, rules, "account");
  const b = buildDailyPlan(after, rules, "account");
  assert.notEqual(a.snapshotHash, b.snapshotHash);
  assert.equal(b.decisions.length, 0);
  const renamed = snapshot();
  renamed.folders[0].name = "Changed";
  assert.equal(buildDailyPlan(renamed, rules, "account").decisions.length, 0);
});
test("跨进程锁拒绝并发，死进程锁可恢复，存活子进程阻止抢占", async () => {
  const dir = await mkdtemp(join(tmpdir(), "collection-daily-test-"));
  const path = join(dir, "lock");
  try {
    const [a, b] = await Promise.all([acquireLock(path), acquireLock(path)]);
    assert.equal([a, b].filter(Boolean).length, 1);
    assert.equal(await acquireLock(path), null);
    await (a ?? b).release();
    await putJson(path, { pid: 2147483647, children: [process.pid] });
    assert.equal(await acquireLock(path), null);
    await putJson(path, { pid: 2147483647 });
    const recovered = await acquireLock(path);
    assert.ok(recovered);
    await recovered.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("真实执行CLI的初始化失败释放锁，死进程锁恢复后也不会残留或访问平台", async t => {
  const dir = await mkdtemp(join(tmpdir(), "collection-local-run-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = snapshot(), plan = buildDailyPlan(data, rules, "account");
  await putJson(join(dir, "snapshot.json"), data);
  await putJson(join(dir, "classification-plan.json"), plan);
  await putJson(join(dir, "run-state.json"), { snapshotHash: "different-plan" });
  for (const stale of [false, true]) {
    if (stale) await putJson(join(dir, "execution.lock"), { pid: 2147483647 });
    await assert.rejects(execute(process.execPath, ["scripts/local-run.mjs"], {
      env: { ...runtimeEnvironment(), COLLECTION_RUN_DIR: dir }, timeout: 10000
    }), error => error.code === 1 && error.stderr.includes("run_plan_mismatch"));
    await assert.rejects(readFile(join(dir, "execution.lock")), { code: "ENOENT" });
    await assert.rejects(readFile(join(dir, "execution.lock.guard")), { code: "ENOENT" });
  }
});
