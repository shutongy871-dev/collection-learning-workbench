import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLearningServer } from "../src/learning/server.mjs";
import { collectionSync } from "../src/learning/collection-sync.mjs";
import { learningStore } from "../src/learning/store.mjs";

test("同步完成后通知题目准备；平台阻塞时不通知", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "sync-prepare-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = learningStore(dataDir);
  await store.initialize(false);
  let notifications = 0, result = { status: "completed", scanned: 0, verified: 0 };
  const sync = collectionSync({ dataDir, store, runner: async () => result,
    onComplete: async () => { assert.ok((await store.read()).importedAt); notifications++; } });
  async function run() {
    await sync.start();
    for (let i = 0; i < 100; i++) {
      const state = await sync.status();
      if (state.status !== "running") return state;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.fail("同步任务未结束");
  }
  assert.equal((await run()).status, "completed");
  assert.equal(notifications, 1);
  result = { status: "blocked", error: "logged_in_account_required" };
  assert.equal((await run()).status, "blocked");
  assert.equal(notifications, 1);
});

test("手动分类HTTP任务跨服务互斥、异步返回、核验完成后入库，失败不伪装成功", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "collection-sync-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let calls = 0, finish;
  const runner = async () => {
    calls++;
    const result = await new Promise(resolve => { finish = resolve; });
    if (result.status === "completed") {
      const directory = join(dataDir, "daily", "runs", "fixture");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "final-snapshot.json"), JSON.stringify({
        platform: "douyin", at: new Date().toISOString(), complete: true, account: { id: "test-account" },
        favorites: [{ id: "123", title: "隔离同步视频" }],
        folders: [{ id: "folder", name: "英语学习", items: [{ id: "123" }] }]
      }));
    }
    return result;
  };
  const first = await startLearningServer({ dataDir, port: 0, importOnStart: false, classificationRunner: runner });
  const second = await startLearningServer({ dataDir, port: 0, importOnStart: false, classificationRunner: runner });
  t.after(() => Promise.all([new Promise(r => first.close(r)), new Promise(r => second.close(r))]));
  const origin = server => `http://127.0.0.1:${server.address().port}`;
  const post = server => fetch(`${origin(server)}/api/collection-sync`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: "{}" });
  const started = await post(first);
  assert.equal(started.status, 202);
  assert.equal((await started.json()).status, "running");
  const duplicate = await (await post(second)).json();
  assert.equal(duplicate.active, true);
  assert.equal(calls, 1);
  assert.equal((await (await fetch(`${origin(second)}/api/state`)).json()).items.length, 0);
  finish({ status: "completed", scanned: 1, verified: 1, pending: 0 });
  async function terminal() {
    for (let i = 0; i < 100; i++) {
      const status = await (await fetch(`${origin(second)}/api/collection-sync`)).json();
      if (status.status !== "running") return status;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.fail("同步任务未结束");
  }
  const completed = await terminal();
  assert.equal(completed.status, "completed");
  assert.equal(completed.imported, 1);
  assert.equal(completed.classified, 1);
  const state = await (await fetch(`${origin(second)}/api/state`)).json();
  assert.deepEqual(state.items[0].categories, ["英语学习"]);
  await post(second);
  while (calls < 2) await new Promise(r => setTimeout(r, 10));
  finish({ status: "blocked", error: "account_changed" });
  const blocked = await terminal();
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.error, "account_changed");
  assert.equal(blocked.imported, undefined);
});
