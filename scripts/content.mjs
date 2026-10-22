import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { configuredModels } from "../src/understanding/model-settings.mjs";
import { routeContent } from "../src/understanding/route.mjs";
import { providerDoctor, visionReservation } from "../src/understanding/providers.mjs";
import { processContent, publicContent } from "../src/understanding/pipeline.mjs";

const help = `视频内容路由与处理
  npm run content:doctor
  npm run content:plan [-- --item <视频ID或学习键> --out <JSON路径>]
  npm run content:process -- --item <视频ID或学习键> --media <本地视频>
  npm run content:process -- --input <任务JSON> [--retry]
  npm run content:vision-check -- --input <任务JSON> [--out <JSON路径>]
任务JSON：{itemKey, mediaPath?, comments?:[{id,text,sourceUrl,collectedAt}], override?:{route,reason}}
route: speech / visual / mixed / entertainment。未知类型可通过实际ASR补充证据。
娱乐路线无需媒体；其余路线只接受本地媒体。--retry 恢复已阻塞任务，不重跑已完成结果。
vision-check 使用一帧真实画面做付费连通验证，费用纳入该视频预算；doctor 仅检查本地配置。
配置放在 .env.content，模板见 .env.content.example。`;
export async function main(args = process.argv.slice(2)) {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: "boolean" }, item: { type: "string" }, media: { type: "string" }, input: { type: "string" },
    out: { type: "string" }, "data-dir": { type: "string" }, retry: { type: "boolean" }
  } });
  if (v.help) { console.log(help); return; }
  const dataDir = resolve(v["data-dir"] || process.env.LEARNING_DATA_DIR || ".data");
  const command = positionals[0], config = configuredModels(dataDir).content;
  if (command === "doctor") { console.log(JSON.stringify(await providerDoctor(config), null, 2)); return; }
  if (!["plan", "process", "vision-check"].includes(command)) throw new Error(help);
  if (command === "vision-check") {
    // 先检查凭证和预算，避免缺配置的探测覆盖工作台已有结果。
    if (visionReservation(config) > config.budgetCny) throw new Error("budget_exceeded");
    config.maxFrames = 1;
    config.visionMaxOutputTokens = Math.min(config.visionMaxOutputTokens, 512);
  }
  const state = JSON.parse(await readFile(resolve(dataDir, "learning/state.json"), "utf8"));
  const input = v.input ? JSON.parse(await readFile(resolve(v.input), "utf8")) : {};
  const key = v.item || input.itemKey;
  const items = key ? state.items.filter(i => i.key === key || i.id === key) : state.items;
  if (!items.length || (key && items.length !== 1)) throw new Error("item_not_found_or_ambiguous");
  let result;
  if (command === "plan") {
    const plans = items.map(item => ({ itemKey: item.key, title: item.title, ...routeContent(item) }));
    result = { version: "density-v1", metadataOnly: true, modelCalls: 0, items: plans,
      counts: Object.fromEntries(["speech", "visual", "mixed", "entertainment", "undecided"]
        .map(r => [r, plans.filter(p => p.route === r).length])) };
  } else {
    if (!key) throw new Error("single_item_required");
    result = publicContent(await processContent({ dataDir, item: items[0], config,
      mediaPath: v.media || input.mediaPath, comments: input.comments,
      override: command === "vision-check" ? { route: "visual", reason: "单帧验证视觉模型凭证、画面识别与用量返回" } : input.override,
      retry: v.retry }));
    if (!["completed", "needs_review"].includes(result.status)) process.exitCode = 2;
  }
  if (v.out) {
    await writeFile(resolve(v.out), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ output: resolve(v.out), counts: result.counts, status: result.status }));
  } else console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => {
  console.error(e.code || e.message); process.exitCode = 1;
});
