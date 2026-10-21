import { loadState } from "../src/local-service/store.mjs";
import { readFile } from "node:fs/promises";
const localDir = new URL("../.data/local-browser/", import.meta.url);
async function optionalJson(name) {
  try { return JSON.parse(await readFile(new URL(name, localDir), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
const localRun = await optionalJson("run-state.json");
const localAudit = await optionalJson("audit-result.json");
const localPlan = await optionalJson("classification-plan.json");
const state = await loadState();
let service = { online: false };
try {
  const r = await fetch("http://127.0.0.1:7788/driver/health", { signal: AbortSignal.timeout(1500) });
  service = { online: r.ok, ...await r.json() };
} catch { /* 离线也是诊断结果，不启动服务、不下发任务。 */ }
console.log(JSON.stringify({
  localExecution: {
    status: localRun?.status ?? "not_started", total: localPlan?.total ?? 0,
    verified: Object.values(localRun?.entries ?? {}).filter(e => e.status === "verified").length,
    finalAuditPassed: localAudit?.passed ?? false,
    finalUnclassified: localAudit?.currentUnclassified ?? null,
    platformInvalid: localAudit?.invalidCount ?? null
  },
  legacyService: service,
  legacyTasks: { total: state.tasks.length, recordedSuccess: state.tasks.reduce((n, t) => n + (t.itemsDone ?? 0), 0) },
  legacyConfiguration: {
    platform: state.config.platform, schedule: state.config.schedule,
    rules: state.config.rules?.length ?? 0, foldersCached: state.config.folders?.length ?? 0,
    llmConfigured: Boolean(state.config.llm?.apiKey), feishuConfigured: Boolean(state.config.feishuWebhook)
  },
  legacyRecentTasks: state.tasks.slice(-5).map(t => ({
    id: t.id, status: t.status, step: t.driverStep, done: t.itemsDone,
    failed: t.itemsFailed, blockedReason: t.blockedReason, contentVersion: t.contentVersion,
    lastLog: t.log?.at(-1)?.message
  })),
  limitations: [
    "当前仅支持抖音",
    "新执行器以localExecution和独立终验为准；旧扩展任务数据保留原状",
    "本轮分类计划由助手生成并绑定快照；自动模型分类尚未接入",
    "09:00每日执行器已实现；系统调度生效状态待验证；云端部署暂停",
    "Webhook只负责发消息；机器人回复指令处理未实现"
  ]
}, null, 2));
