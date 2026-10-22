// End-to-end checks in an isolated learning-data copy and a fresh browser context.
// Uses a clean headless browser; never navigates any platform tab.
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { importCollections } from "../src/learning/import.mjs";
import { startLearningServer } from "../src/learning/server.mjs";
import { dayKey } from "../src/learning/domain.mjs";
import { learningStore } from "../src/learning/store.mjs";
import { processContent, atomicJSON, digest } from "../src/understanding/pipeline.mjs";
import { contentConfig, questionConfig } from "../src/understanding/config.mjs";
import { execute } from "../src/understanding/media.mjs";

const output = resolve(process.env.LEARNING_TEST_OUTPUT_DIR || ".data/learning-verification");
await mkdir(output, { recursive: true });
const dataDir = await mkdtemp(join(output, "run-"));
// Default fixtures contain no personal collections, so this check also runs in a clean checkout.
const fixtureDir = join(dataDir, "fixtures", "local-browser");
await mkdir(fixtureDir, { recursive: true });
await writeFile(join(fixtureDir, "snapshot.json"), JSON.stringify({
  at: new Date().toISOString(), platform: "douyin", account: { id: "synthetic-ui-account" },
  complete: true, expectedFavorites: 3, folders: [],
  favorites: Array.from({ length: 3 }, (_, i) => ({
    id: `synthetic-video-${i}`, title: `测试收藏${i}`, description: "学习时先主动回忆，再核对遗漏。"
  }))
}));
const state = await importCollections(resolve(process.env.LEARNING_TEST_DATA_DIR || join(dataDir, "fixtures")));
const productionQuestionCount = state.questions.length;
// Explicit test-only excerpt/question: the production library currently has no ready questions.
const fixtureItem = state.items.at(-1);
assert.ok(fixtureItem, "需要至少一条已导入的抖音收藏");
const automaticItem = state.items.find(i => i.key !== fixtureItem.key && i.key !== state.items[0].key);
assert.ok(automaticItem, "需要三条隔离测试收藏");
automaticItem.title = "自动出题验收原理讲解";
automaticItem.description = "";
automaticItem.hashtags = [];
automaticItem.firstSeenAt = new Date(Date.now() + 1000).toISOString();
const fixtureEvidence = "浏览器测试摘录：学习时先主动回忆，再对照原文核对遗漏。";
state.excerpts[fixtureItem.key] = fixtureEvidence;
state.questions.push({ id: "ui-check-only", itemKey: fixtureItem.key, prompt: "按测试摘录，学习时首先做什么？",
  options: ["主动回忆", "删除摘录", "只读标题", "跳过核对"], answer: 0, evidence: fixtureEvidence,
  explanation: "这是一道仅用于隔离浏览器验收的测试题。", seed: false });
await mkdir(join(dataDir, "learning"));
await writeFile(join(dataDir, "learning/state.json"), JSON.stringify(state), { mode: 0o600 });
await processContent({ dataDir, item: fixtureItem, config: contentConfig({}),
  override: { route: "entertainment", reason: "仅用于隔离浏览器验收" },
  comments: [{ id: "ui-comment-only", text: "<script>bad()</script> 这是观众观点",
    sourceUrl: fixtureItem.url, collectedAt: new Date().toISOString() }] });
let questionRequests = 0, finishQuestionPreparation;
const questionGate = new Promise(resolve => { finishQuestionPreparation = resolve; });
const mockProvider = createServer(async (req, res) => {
  let body = "";
  for await(const chunk of req) body += chunk;
  const request = JSON.parse(body), source = JSON.parse(request.messages[1].content)[0];
  questionRequests++;
  await questionGate;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 200 }, choices: [{
    finish_reason: "stop", message: { content: JSON.stringify({ questions: [
      { prompt: "根据测试原文，学习时应当先做什么？", options: ["主动回忆", "只读标题", "删除内容", "跳过核对"],
        answer: 0, evidence: source.text, sourceId: source.id, explanation: "先主动回忆，再核对遗漏。" },
      { prompt: "根据测试原文，回忆以后应该做什么？", options: ["对照原文核对", "删除全部", "只看标题", "停止学习"],
        answer: 0, evidence: source.text, sourceId: source.id, explanation: "随后应对照原文核对遗漏。" }
    ] }) }
  }] }));
});
await new Promise(r => mockProvider.listen(0, "127.0.0.1", r));
const modelConfig = { content: { ...contentConfig({}), asrRateCnyPerMinute: 0 },
  question: { ...questionConfig({}), apiKey: "ui-test-only", model: "ui-mock",
    baseUrl: `http://127.0.0.1:${mockProvider.address().port}/v1`, inputCnyPerMillion: .1, outputCnyPerMillion: .1,
    maxCostCny: .01 } };
const mediaPath = join(dataDir, "fixture.mp4"), automaticEvidence = "测试转写：学习时先主动回忆，再对照原文核对遗漏，这是主动学习的关键步骤。";
await execute(modelConfig.content.ffmpeg, ["-nostdin", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=2",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "2", "-c:v", "libx264", "-c:a", "aac", mediaPath]);
await processContent({ dataDir, item: automaticItem, mediaPath, config: modelConfig.content,
  adapters: { transcribe: async (_audio, asset) => ({ provider: "ui-mock", model: "test-only",
    segments: [{ startMs: 0, endMs: asset.durationMs - 20, text: automaticEvidence }] }) } });
const mediaDir = join(dataDir, "content-media", digest(automaticItem.key));
await mkdir(mediaDir, { recursive: true });
await atomicJSON(join(mediaDir, "input.json"), { itemKey: automaticItem.key, mediaPath, comments: [] });
await mkdir(join(dataDir, "content-batch"), { recursive: true });
await atomicJSON(join(dataDir, "content-batch", "ledger.json"), {
  version: 1,
  days: { [dayKey(Date.now())]: { date: dayKey(Date.now()), entries: { "ui-reserved-slot": { status: "completed", costCny: 0 } } } },
  items: {}
});
let syncCalls = 0, finishSync;
const server = await startLearningServer({ dataDir, port: 0, importOnStart: false, getModelConfig: () => modelConfig,
  modelEnvironment: {},
  batchAdapters: { captureContent: async () => { throw new Error("ui_unexpected_media_acquisition"); } },
  accountAdapters: {
    launchLogin: () => ({ exitCode: 0, signalCode: null, once() {} }),
    readAccount: async () => ({ id: "synthetic-ui-account", nickname: "测试使用者" })
  },
  classificationRunner: async () => {
    syncCalls++;
    return await new Promise(resolve => { finishSync = resolve; });
  } });
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = process.env.LEARNING_TEST_CDP
  ? await chromium.connectOverCDP(process.env.LEARNING_TEST_CDP)
  : await chromium.launch({ headless: true, ...(process.env.LEARNING_TEST_BROWSER_EXECUTABLE
    ? { executablePath: process.env.LEARNING_TEST_BROWSER_EXECUTABLE } : { channel: "chrome" }) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
const page = await context.newPage();
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", msg => { if (msg.type() === "error" && !msg.text().includes("favicon")) errors.push(msg.text()); });
const check = async (name, fn) => { await fn(); console.log(`✓ ${name}`); };
try {
  await page.goto(origin);
  await page.getByRole("heading", { name: "让收藏，成为你的收获。" }).waitFor();
  await check("右上角账号入口可发起登录、核验昵称并在刷新后保留", async () => {
    await page.getByLabel("抖音账号", { exact: true }).click();
    await page.locator("#account-state").filter({ hasText: "尚未确认抖音登录" }).waitFor();
    const buttons = await page.locator(".account-panel button").evaluateAll(elements =>
      elements.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
    assert.equal(buttons.length, 3);
    for (const [i, rect] of buttons.entries()) {
      assert.ok(rect.height >= 42);
      assert.equal(rect.x, buttons[0].x);
      assert.equal(rect.width, buttons[0].width);
      if (i) assert.ok(rect.y - buttons[i - 1].y - buttons[i - 1].height >= 10);
    }
    await page.locator(".account-panel").screenshot({ path: join(output, "account-menu.png") });
    await page.getByRole("button", { name: "登录抖音", exact: true }).click();
    await page.locator("#account-state").filter({ hasText: "请在专用窗口扫码" }).waitFor();
    await page.getByRole("button", { name: "检查登录", exact: true }).click();
    await page.locator("#account-state").filter({ hasText: "测试使用者 · 上次检查已登录" }).waitFor();
    await page.reload();
    await page.getByLabel("抖音账号", { exact: true }).click();
    await page.locator("#account-state").filter({ hasText: "测试使用者 · 上次检查已登录" }).waitFor();
    await page.getByLabel("抖音账号", { exact: true }).click();
  });
  await check("首页只保留刷题入口，不展示收藏标题或心得", async () => {
    assert.equal(await page.locator(".stat-value").first().textContent(), `${state.items.length.toLocaleString("zh-CN")}条`);
    assert.equal(await page.locator(".stat-value").nth(1).textContent(), "5条");
    assert.equal(await page.locator(".sidebar, nav, #due-badge").count(), 0);
    assert.equal(await page.locator(".preparation-panel, .source-notice, #batch-panel").count(), 0);
    assert.equal(await page.getByText("后台运行状态", { exact: true }).count(), 0);
    assert.equal(await page.locator("nav a[data-view=library], nav a[data-view=notes]").count(), 0);
    assert.equal(await page.locator(".collection-card").count(), 0);
    assert.equal(await page.getByText("我的心得", { exact: true }).count(), 0);
    assert.equal(await page.getByText("收藏库", { exact: true }).count(), 0);
    assert.equal(await page.getByText("A LITTLE EVERY DAY", { exact: true }).count(), 0);
    assert.equal(await page.getByText("YOUR DAILY MOMENT", { exact: true }).count(), 0);
    assert.equal(await page.locator(".stat-foot").count(), 0);
    for (const item of state.items) assert.equal(await page.getByText(item.title, { exact: true }).count(), 0);
    await page.screenshot({ path: join(output, "desktop.png"), fullPage: true });
  });
  await check("单页保留收藏趋势和学习足迹，无其他页面入口", async () => {
    assert.equal(await page.locator(".chart").count(), 1);
    assert.equal(await page.getByRole("heading", { name: "把喜欢，变成自己的", exact: true }).count(), 1);
    assert.equal(await page.locator('a[href="#growth"]').count(), 0);
    assert.equal(await page.locator("[data-chart-day]").count(), 0);
    assert.equal(await page.getByText("留下心得", { exact: true }).count(), 0);
  });
  await check("答题不展示来源标题、原收藏链接或心得", async () => {
    const item = fixtureItem, question = state.questions.find(q => q.itemKey === item.key);
    const current = await (await fetch(`${origin}/api/state`)).json();
    assert.ok(current.today.itemKeys.includes(item.key), JSON.stringify(current.today));
    await page.getByRole("button", { name: "开始学习", exact: false }).click();
    await page.locator("#quiz[open]").waitFor();
    assert.equal(await page.locator("#quiz").evaluate(dialog => dialog.open), true,
      JSON.stringify({ errors, toast: await page.locator("#toast").textContent() }));
    assert.equal(await page.getByText(item.title, { exact: true }).count(), 0);
    await page.locator(`[data-choice="${question.answer}"]`).click();
    await page.getByRole("button", { name: "提交答案，查看解析" }).click();
    await page.locator(".answer-panel").waitFor();
    assert.match(await page.locator(".answer-panel h3").textContent(), /答对了/);
    assert.equal(await page.locator(".answer-panel blockquote").textContent(), question.evidence);
    assert.equal(await page.getByRole("link", { name: /原收藏/ }).count(), 0);
    assert.equal(await page.locator("[data-rating]").count(), 4);
    await page.getByRole("button", { name: "记住了 2 天后复习" }).click();
    await page.getByRole("heading", { name: "本题完成。" }).waitFor();
    assert.equal(await page.locator("#quiz textarea").count(), 0);
    assert.equal(await page.getByText("心得", { exact: false }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "继续学习", exact: false }).count(), 1);
    await page.getByRole("button", { name: "关闭答题", exact: true }).click();
    const saved = JSON.parse(await readFile(join(dataDir, "learning/state.json"), "utf8"));
    assert.equal(saved.events.length, 1);
    assert.ok(Date.parse(saved.progress[item.key].dueAt) > Date.now() + 23 * 3_600_000);
  });
  await check("无密钥点击学习直接打开配置，不虚报正在生成", async () => {
    const key = modelConfig.question.apiKey;
    modelConfig.question.apiKey = "";
    await page.getByRole("button", { name: "开始学习", exact: false }).click();
    await page.locator("#model-dialog[open]").waitFor();
    assert.match(await page.locator("#model-status").textContent(), /请先配置自己的模型/);
    assert.equal(questionRequests, 0);
    assert.equal(await page.locator("#preparing-dialog[open]").count(), 0);
    await page.getByRole("button", { name: "关闭模型配置", exact: true }).click();
    modelConfig.question.apiKey = key;
  });
  await check("点击学习实际启动出题、显示进度、准备后自动打开答题", async () => {
    await learningStore(dataDir).mutate(s => { s.learningConfig.dailyVideos = 2; });
    await fetch(`${origin}/api/batch/config`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxItemsPerDay: 2 }) });
    await page.getByRole("button", { name: "开始学习", exact: false }).click();
    await page.locator("#preparing-dialog[open]").waitFor();
    assert.match(await page.locator("#preparing-status").textContent(), /正在读取视频内容并出题/);
    finishQuestionPreparation();
    await page.locator("#quiz[open]").waitFor();
    assert.equal(await page.locator("#preparing-dialog[open]").count(), 0);
    assert.equal(questionRequests, 1);
    await page.getByRole("button", { name: "关闭答题", exact: true }).click();
  });
  await check("每日视频数→自动出题发布→直接学习→FSRS→重载", async () => {
    await page.getByLabel("每天学习视频数", { exact: true }).fill("2");
    await page.locator("#learning-form").getByRole("button", { name: "保存", exact: true }).click();
    await page.locator("#toast").filter({ hasText: "每日学习视频数已保存" }).waitFor();
    let batch;
    const deadline = Date.now() + 15000;
    do {
      batch = await (await fetch(`${origin}/api/batch`)).json();
      if (!batch.active && batch.latest?.status !== "running" &&
          batch.ledger.items[automaticItem.key]?.status === "completed") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    let saved = JSON.parse(await readFile(join(dataDir, "learning/state.json"), "utf8"));
    assert.ok(!batch.active && batch.latest?.status !== "running" &&
      batch.ledger.items[automaticItem.key]?.status === "completed", JSON.stringify(batch.latest));
    assert.equal(questionRequests, 1, JSON.stringify(batch.latest));
    assert.equal(saved.learningConfig.dailyVideos, 2);
    assert.equal(saved.questions.filter(q => q.itemKey === automaticItem.key).length, 2);
    assert.equal(Object.values(saved.drafts).filter(d => d.itemKey === automaticItem.key && d.status === "approved").length, 2);
    assert.equal(saved.progress[automaticItem.key].source, "automatic");
    await page.reload();
    await page.getByRole("heading", { name: "让收藏，成为你的收获。" }).waitFor();
    assert.equal(await page.getByText(automaticItem.title, { exact: true }).count(), 0);
    await page.getByRole("button", { name: "开始学习", exact: false }).click();
    await page.locator("[data-choice='0']").click();
    await page.getByRole("button", { name: "提交答案，查看解析" }).click();
    await page.locator(".answer-panel").waitFor();
    assert.equal(await page.locator(".answer-panel blockquote").textContent(), automaticEvidence);
    await page.locator("[data-rating='good']").click();
    await page.getByRole("heading", { name: "本题完成。" }).waitFor();
    await page.getByRole("button", { name: "关闭答题", exact: true }).click();
    await page.reload();
    saved = JSON.parse(await readFile(join(dataDir, "learning/state.json"), "utf8"));
    const event = saved.events.find(e => e.itemKey === automaticItem.key);
    const q = saved.questions.find(q => q.id === event.questionId);
    assert.equal(saved.cards[event.questionId].card.reps, 1);
    assert.equal(event.rating, "good");
    assert.equal(q.sourceSpans[0].kind, "transcript");
    assert.equal(questionRequests, 1);
  });
  await check("桌面、手机和平板无侧栏留白及横向溢出", async () => {
    for (const width of [1440, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.locator(".workspace").evaluate(el => getComputedStyle(el).marginLeft), "0px");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px overflow`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(output, "mobile.png"), fullPage: true });
  });
  await check("手动同步分类按钮启动任务、刷新保留进度、完成自动更新", async () => {
    await page.getByRole("button", { name: "同步并分类", exact: false }).click();
    await page.getByRole("button", { name: "正在同步分类", exact: false }).waitFor();
    assert.equal(await page.locator("#refresh").isDisabled(), true);
    await page.reload();
    await page.getByRole("button", { name: "正在同步分类", exact: false }).waitFor();
    assert.equal(syncCalls, 1);
    finishSync({ status: "completed", scanned: state.items.length, verified: 0, pending: 0 });
    await page.getByRole("button", { name: "同步并分类", exact: false }).waitFor();
    assert.equal(await page.locator("#refresh").isDisabled(), false);
  });
  await check("模型配置：隐藏输入、保存启动后台、重开不回显密钥，手机无溢出", async () => {
    await page.getByLabel("抖音账号", { exact: true }).click();
    await page.getByRole("button", { name: "模型配置", exact: true }).click();
    await page.getByRole("heading", { name: "模型配置", exact: true }).waitFor();
    assert.equal(await page.getByLabel("API 地址（Base URL）", { exact: true }).inputValue(),
      "https://dashscope.aliyuncs.com/compatible-mode/v1");
    const changedEndpoint = "https://workspace.example.org/compatible-mode/v1";
    await page.getByLabel("API 地址（Base URL）", { exact: true }).fill(changedEndpoint);
    assert.equal(await page.locator("#model-form input[name=apiKey]").getAttribute("type"), "password");
    await page.getByLabel("API Key", { exact: true }).fill("synthetic-ui-model-key-only");
    assert.equal(await page.getByLabel("模型名称 / 接入点 ID", { exact: true }).inputValue(), "qwen-vl-plus");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole("button", { name: "保存并开始出题", exact: true }).click();
    await page.locator("#toast").filter({ hasText: "模型配置已保存" }).waitFor();
    assert.equal(await page.locator("#model-dialog").evaluate(d => d.open), false);
    assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "");
    await page.getByLabel("抖音账号", { exact: true }).click();
    await page.getByRole("button", { name: "模型配置", exact: true }).click();
    await page.locator("#model-status").filter({ hasText: "本机已保存密钥" }).waitFor();
    assert.equal(await page.getByLabel("API 地址（Base URL）", { exact: true }).inputValue(), changedEndpoint);
    assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "");
    await page.getByRole("button", { name: "关闭模型配置", exact: true }).click();
    for (let i = 0; i < 100; i++) {
      if (!(await (await fetch(`${origin}/api/batch`)).json()).active) break;
      await new Promise(r => setTimeout(r, 20));
    }
  });
  await check("供应商切换不展开费用；自定义接口可保存、重开回读且不回显密钥", async () => {
    await page.getByLabel("抖音账号", { exact: true }).click();
    await page.getByRole("button", { name: "模型配置", exact: true }).click();
    await page.locator("#model-dialog[open]").waitFor();
    for (const provider of ["doubao", "qwen", "compatible"]) {
      await page.getByLabel("模型供应商", { exact: true }).selectOption(provider);
      assert.equal(await page.locator("#model-form details").evaluate(el => el.open), false);
      assert.equal(await page.locator("#model-endpoint").isVisible(), true);
      assert.equal(await page.getByLabel("API 地址（Base URL）", { exact: true }).isEditable(), true);
    }
    await page.getByLabel("API 地址（Base URL）", { exact: true }).fill("https://models.example.org/v1/");
    await page.getByLabel("API Key", { exact: true }).fill("synthetic-custom-model-key-only");
    await page.getByLabel("模型名称 / 接入点 ID", { exact: true }).fill("example-vision-model");
    await page.getByRole("button", { name: "保存并开始出题", exact: true }).click();
    assert.equal(await page.locator("#model-form details").evaluate(el => el.open), true);
    assert.equal(await page.locator("#model-dialog").evaluate(el => el.open), true);
    await page.getByLabel("输入单价（元 / 百万 tokens）", { exact: true }).fill("1");
    await page.getByLabel("输出单价（元 / 百万 tokens）", { exact: true }).fill("2");
    await page.getByRole("button", { name: "保存并开始出题", exact: true }).click();
    await page.locator("#model-dialog:not([open])").waitFor({ state: "attached" });
    await page.getByLabel("抖音账号", { exact: true }).click();
    await page.getByRole("button", { name: "模型配置", exact: true }).click();
    await page.locator("#model-dialog[open]").waitFor();
    assert.equal(await page.getByLabel("模型供应商", { exact: true }).inputValue(), "compatible");
    assert.equal(await page.getByLabel("API 地址（Base URL）", { exact: true }).inputValue(), "https://models.example.org/v1");
    assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "");
    assert.equal(await page.locator("#model-form details").evaluate(el => el.open), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole("button", { name: "关闭模型配置", exact: true }).click();
    for (let i = 0; i < 100; i++) {
      if (!(await (await fetch(`${origin}/api/batch`)).json()).active) break;
      await new Promise(r => setTimeout(r, 20));
    }
  });
  assert.deepEqual(errors, []);
  await writeFile(join(output, "result.json"), JSON.stringify({ checkedAt: new Date().toISOString(), checks: 11, items: state.items.length,
    productionQuestions: productionQuestionCount, fixtureQuestions: 1, generatedQuestions: 2, questionRequests,
    consoleErrors: errors, isolatedData: true }, null, 2));
  console.log("全部浏览器验收通过；正式学习记录未被修改。");
} finally {
  finishQuestionPreparation();
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => mockProvider.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
