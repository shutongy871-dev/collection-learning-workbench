import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { accountManager } from "../src/learning/account.mjs";
import { learningStore } from "../src/learning/store.mjs";
import { startLearningServer } from "../src/learning/server.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "account-test-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = learningStore(dataDir);
  await store.initialize(false);
  return { dataDir, store };
}
function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, connected: true,
    send: () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); } });
  return child;
}
test("fresh account: login is idempotent; current read binds account and exposes only display fields", async t => {
  const f = await fixture(t);
  let launches = 0;
  const child = fakeChild();
  const manager = accountManager({ ...f, launchLogin: () => { launches++; return child; },
    readAccount: async () => ({ id: "synthetic-account", nickname: "测试使用者", cookie: "not-public" }) });
  assert.deepEqual(await manager.status(), { status: "unverified" });
  assert.deepEqual(await manager.login(), { status: "login_pending" });
  await manager.login();
  assert.equal(launches, 1);
  const result = await manager.check();
  assert.deepEqual(Object.keys(result).sort(), ["checkedAt", "nickname", "status"]);
  assert.equal(result.nickname, "测试使用者");
  assert.equal(result.status, "verified");
  assert.equal(child.exitCode, 0);
  assert.deepEqual(await manager.status(), result);
  assert.deepEqual(await accountManager({ ...f }).status(), result);
});
test("failed current check invalidates previous status and cannot bind another library's account", async t => {
  const f = await fixture(t);
  let current = { id: "synthetic-first", nickname: "测试甲" };
  const manager = accountManager({ ...f, readAccount: async () => {
    if (!current) throw new Error("logged_in_account_required");
    return current;
  } });
  await manager.check();
  await f.store.mutate(s => { s.sources = [{ platform: "douyin", accountId: current.id }]; });
  current = { id: "synthetic-second", nickname: "测试乙" };
  await assert.rejects(manager.check(), /account_changed/);
  assert.equal((await manager.status()).status, "unverified");
  current = null;
  await assert.rejects(manager.check(), /logged_in_account_required/);
  assert.equal((await manager.status()).status, "unverified");
});
test("concurrent login calls launch at most one process", async t => {
  const f = await fixture(t);
  let launches = 0;
  const manager = accountManager({ ...f, launchLogin: () => { launches++; return fakeChild(); } });
  const results = await Promise.allSettled([manager.login(), manager.login()]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(launches, 1);
  await manager.close();
});
test("fresh HTTP server returns no collections and account endpoint handles login/check", async t => {
  const f = await fixture(t);
  const server = await startLearningServer({ dataDir: f.dataDir, port: 0, importOnStart: false,
    accountAdapters: { launchLogin: fakeChild,
      readAccount: async () => ({ id: "synthetic-http", nickname: "测试账号" }) } });
  t.after(() => new Promise(r => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${origin}/api/state`)).json();
  assert.deepEqual(state.items, []);
  assert.deepEqual(state.sources, []);
  const post = path => fetch(`${origin}/api/account/${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: "{}" });
  assert.equal((await post("login")).status, 202);
  const checked = await (await post("check")).json();
  assert.equal(checked.status, "verified");
  assert.equal(checked.nickname, "测试账号");
  assert.equal(JSON.stringify(checked).includes("synthetic-http"), false);
});
