import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredModels, modelSettings, modelPresets } from "../src/understanding/model-settings.mjs";
import { startLearningServer } from "../src/learning/server.mjs";
import { understandFrames } from "../src/understanding/providers.mjs";
import { requestQuestions } from "../src/learning/generator.mjs";

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
test("reject invalid endpoint formats, price/budget and credential reuse across providers", async t => {
  const dir = await fixture(t), manager = modelSettings(dir, {});
  await manager.save(input);
  const before = await readFile(join(dir, "model-settings.json"), "utf8");
  await assert.rejects(manager.save({ ...input, baseUrl: "https://example.com/v1?key=test" }), /API 地址/);
  await assert.rejects(manager.save({ ...input, inputPrice: -1 }), /单价/);
  await assert.rejects(manager.save({ ...input, contentBudget: .001 }), /预算/);
  await assert.rejects(manager.save({ ...input, provider: "doubao",
    baseUrl: modelPresets.doubao.baseUrl, apiKey: "" }), /API Key/);
  assert.equal(await readFile(join(dir, "model-settings.json"), "utf8"), before);
});
test("built-in supplier URLs are editable defaults; new addresses persist without reusing saved credentials", async t => {
  for (const provider of ["qwen", "doubao"]) {
    const dir = await fixture(t), manager = modelSettings(dir, {});
    const initial = { ...input, provider, baseUrl: modelPresets[provider].baseUrl };
    await manager.save(initial);
    const baseUrl = `https://workspace-${provider}.example.org/v1`;
    await assert.rejects(manager.save({ ...initial, baseUrl, apiKey: "" }), /地址已更换/);
    assert.equal(manager.status().baseUrl, initial.baseUrl);
    const replacement = "synthetic-replacement-api-key";
    await manager.save({ ...initial, baseUrl, apiKey: replacement });
    const models = configuredModels(dir, {});
    assert.equal(models.content.visionBaseUrl, baseUrl);
    assert.equal(models.question.baseUrl, baseUrl);
    assert.equal(models.question.apiKey, replacement);
    assert.equal(modelSettings(dir, {}).status().baseUrl, baseUrl);
    await manager.save({ ...initial, baseUrl, apiKey: "" });
    assert.equal(configuredModels(dir, {}).question.apiKey, replacement);
  }
});
test("model settings refuse symlinks", async t => {
  const dir = await fixture(t);
  await symlink(join(dir, "missing.json"), join(dir, "model-settings.json"));
  await assert.rejects(modelSettings(dir, {}).save(input), /符号链接/);
});
test("custom endpoint persists for both stages; changing the endpoint requires its own credential", async t => {
  const dir = await fixture(t), manager = modelSettings(dir, {});
  const custom = { ...input, provider: "compatible", baseUrl: "https://models.example.org/v1/",
    model: "example-vision-model", inputPrice: 1, outputPrice: 2 };
  await manager.save(custom);
  const configured = configuredModels(dir, { DASHSCOPE_API_KEY: "unused-synthetic-key" });
  assert.equal(configured.content.visionProvider, "compatible");
  assert.equal(configured.question.provider, "compatible");
  assert.equal(configured.content.visionBaseUrl, "https://models.example.org/v1");
  assert.equal(configured.question.baseUrl, configured.content.visionBaseUrl);
  assert.equal(configured.question.apiKey, key);
  assert.equal(manager.status().baseUrl, "https://models.example.org/v1");
  assert.equal(JSON.stringify(manager.status()).includes(key), false);
  await manager.save({ ...custom, apiKey: "" });
  await assert.rejects(manager.save({ ...custom, baseUrl: "https://other.example.org/v1", apiKey: "" }), /API Key/);
  for (const baseUrl of ["http://models.example.org/v1", "file:///tmp/model",
    "https://user:password@models.example.org/v1", "https://models.example.org/v1?key=test",
    "https://models.example.org/v1#key", "https://models.example.org/v1/chat/completions"]) {
    await assert.rejects(manager.save({ ...custom, baseUrl }), /API 地址|Base URL/);
  }
});
test("custom compatible service receives image and question requests, and both responses preserve usage", async t => {
  const dir = await fixture(t), requests = [], evidence = "主动回忆时先用自己的话复述，再对照原文检查遗漏。";
  const endpoint = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    requests.push({ path: req.url, body: parsed, authorization: req.headers.authorization });
    const visual = Array.isArray(parsed.messages[0].content);
    const content = visual ? { observations: [{ frameId: "frame-1", text: "画面展示学习步骤" }],
      claims: [{ text: "画面包含学习步骤", evidenceIds: ["frame-1"] }] } :
      { questions: [{ prompt: "根据原文，主动回忆时首先做什么？",
        options: ["用自己的话复述", "删除原文", "跳过复习", "只读标题"], answer: 0,
        evidence, explanation: "先复述，再核对遗漏。", sourceId: "source-1" }] };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50 },
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] }));
  });
  await new Promise(r => endpoint.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => endpoint.close(r)));
  await modelSettings(dir, {}).save({ ...input, provider: "compatible",
    baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`, model: "mock-vision" });
  const models = configuredModels(dir, {}), path = join(dir, "frame.jpg");
  await writeFile(path, Buffer.from([255, 216, 255, 217]));
  const vision = await understandFrames([{ id: "frame-1", path, timestampMs: 0 }], [], models.content);
  const question = await requestQuestions([{ id: "source-1", text: evidence }], models.question);
  assert.equal(vision.error, undefined);
  assert.equal(question.error, undefined);
  assert.equal(question.result.length, 1);
  assert.equal(vision.usage.inputTokens, 100);
  assert.equal(question.usage.outputTokens, 50);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.path === "/v1/chat/completions" && r.authorization === `Bearer ${key}` &&
    r.body.model === "mock-vision"));
  assert.ok(requests[0].body.messages[0].content.some(c => c.type === "image_url"));
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
