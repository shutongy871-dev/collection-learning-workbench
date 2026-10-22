import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredModels, modelSettings, modelPresets } from "../src/understanding/model-settings.mjs";
import { startLearningServer } from "../src/learning/server.mjs";

const key = "synthetic-local-api-key-only";
const input = { provider: "qwen", ...modelPresets.qwen, apiKey: key, contentBudget: .05 };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "model-settings-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("model settings persist privately, do not echo credentials, and supply both model stages after restart", async t => {
  const dir = await fixture(t), manager = modelSettings(dir, {});
  assert.equal(manager.status().credentialPresent, false);
  const saved = await manager.save(input);
  assert.equal(saved.configured, true);
  assert.equal(JSON.stringify(saved).includes(key), false);
  assert.equal((await stat(join(dir, "model-settings.json"))).mode & 0o777, 0o600);
  const models = configuredModels(dir, {});
  assert.equal(models.question.apiKey, key);
  assert.equal(models.content.visionApiKey, key);
  assert.equal(models.question.model, "qwen-vl-plus");
  assert.equal(models.question.maxCostCny, .0168);
  const restarted = modelSettings(dir, {});
  await restarted.save({ ...input, apiKey: "", model: "qwen-vl-plus-latest" });
  assert.equal(configuredModels(dir, {}).question.apiKey, key);
  assert.equal(configuredModels(dir, {}).question.model, "qwen-vl-plus-latest");
});
test("reject wrong provider endpoints, invalid price/budget and credential reuse across providers", async t => {
  const dir = await fixture(t), manager = modelSettings(dir, {});
  await manager.save(input);
  const before = await readFile(join(dir, "model-settings.json"), "utf8");
  await assert.rejects(manager.save({ ...input, baseUrl: "https://example.com/v1" }), /官方接口/);
  await assert.rejects(manager.save({ ...input, inputPrice: -1 }), /单价/);
  await assert.rejects(manager.save({ ...input, contentBudget: .001 }), /预算/);
  await assert.rejects(manager.save({ ...input, provider: "doubao",
    baseUrl: modelPresets.doubao.baseUrl, apiKey: "" }), /API Key/);
  assert.equal(await readFile(join(dir, "model-settings.json"), "utf8"), before);
});
test("model settings refuse symlinks", async t => {
  const dir = await fixture(t);
  await symlink(join(dir, "missing.json"), join(dir, "model-settings.json"));
  await assert.rejects(modelSettings(dir, {}).save(input), /符号链接/);
});
test("HTTP model settings save enables batch, never exports key and rejects cross-origin saves", async t => {
  const dir = await fixture(t);
  const server = await startLearningServer({ dataDir: dir, port: 0, modelEnvironment: {}, importOnStart: false });
  t.after(() => new Promise(r => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const send = source => fetch(`${origin}/api/model-settings`, {
    method: "POST", headers: { "content-type": "application/json", origin: source }, body: JSON.stringify(input) });
  assert.equal((await send("https://example.com")).status, 403);
  const response = await send(origin);
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes(key), false);
  for (const path of ["model-settings", "export", "state"]) {
    const body = await (await fetch(`${origin}/api/${path}`)).text();
    assert.equal(body.includes(key), false, path);
  }
  const batch = await (await fetch(`${origin}/api/batch`)).json();
  assert.equal(batch.config.enabled, true);
  for (let i = 0; i < 100; i++) {
    const current = await (await fetch(`${origin}/api/batch`)).json();
    if (!current.active) return;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail("配置保存后的后台任务未结束");
});
