import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { batchStatus, configureBatch, planBatch, runContentBatch, loadModelConfig } from "../src/learning/batch.mjs";
import { generateQuestions, generationSummary } from "../src/learning/generator.mjs";
import { learningStore } from "../src/learning/store.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  "data-dir": { type: "string" }, retry: { type: "boolean" }, enabled: { type: "string" },
  limit: { type: "string" }, budget: { type: "string" }, hour: { type: "string" },
  item: { type: "string" }, help: { type: "boolean" }
} });
const dataDir = resolve(values["data-dir"] || process.env.LEARNING_DATA_DIR || ".data");
async function main() {
  const command = positionals[0];
  if (values.help || !command) {
    console.log(`npm run content:batch -- plan|run|status|configure|generate
  --data-dir PATH    使用指定数据目录
  run --retry        显式恢复失败任务；未知调用结果仍暂停
  configure --enabled true|false --limit 5 --budget 0.25 --hour 9
  generate --item 视频ID或学习键 [--retry]
后台默认关闭。手动run也遵守每日条数和预算限制。`);
    return;
  }
  let result;
  if (command === "status") result = await batchStatus(dataDir);
  else if (command === "plan") result = await planBatch(dataDir, { retry: values.retry });
  else if (command === "run") result = await runContentBatch({ dataDir, retry: values.retry });
  else if (command === "configure") {
    const changes = {};
    if (values.enabled !== undefined) {
      if (!["true", "false"].includes(values.enabled)) throw new Error("enabled_requires_true_or_false");
      changes.enabled = values.enabled === "true";
    }
    for (const [flag, key] of [["limit", "maxItemsPerDay"], ["budget", "budgetCnyPerDay"], ["hour", "hour"]])
      if (values[flag] !== undefined) changes[key] = Number(values[flag]);
    result = await configureBatch(dataDir, changes);
  } else if (command === "generate") {
    const state = await learningStore(dataDir).read();
    const items = state.items.filter(i => values.item && [i.key, i.id].includes(values.item));
    if (items.length !== 1) throw new Error("single_item_required");
    result = generationSummary(await generateQuestions({ dataDir, itemKey: items[0].key,
      config: loadModelConfig().question, retry: values.retry }));
  } else throw new Error("unknown_command");
  console.log(JSON.stringify(result, null, 2));
}
main().catch(e => { console.error(e.code || e.message); process.exitCode = 1; });
