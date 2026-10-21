import { readFile } from "node:fs/promises";
import { dir, save, provePages, unique } from "./local-scan.mjs";

const baseline = JSON.parse(await readFile(dir + "snapshot.json"));
const current = JSON.parse(await readFile(dir + "final-snapshot.json"));
const plan = JSON.parse(await readFile(dir + "classification-plan.json"));
const state = JSON.parse(await readFile(dir + "run-state.json"));
if (current.account?.id !== baseline.account?.id) throw new Error("audit_account_mismatch");
provePages(current.folderPages);
provePages(current.favoritePages);
for (const folder of current.folders) provePages(folder.pages);
const favorites = new Set(unique(current.favoritePages, "items").map(i => i.id));
const members = new Map(current.folders.map(f => [f.id, new Set(unique(f.pages, "items").map(i => i.id))]));
const plannedIds = new Set(plan.decisions.map(d => d.itemId));
const result = {
  at: current.at, accountId: current.account.id,
  startingFavorites: baseline.favorites.length, currentFavorites: favorites.size,
  startingUnclassified: baseline.unclassified.length, currentUnclassified: current.unclassified.length,
  invalidCount: current.invalidCount,
  reviewed: plan.decisions.length, verified: plan.decisions.filter(d => members.get(d.folderId)?.has(d.itemId)).length,
  unresolved: baseline.unclassified.filter(i => !plannedIds.has(i.id)).map(i => i.id),
  missingDestination: plan.decisions.filter(d => !members.get(d.folderId)?.has(d.itemId)).map(d => d.itemId),
  missingFavorites: baseline.favorites.filter(i => !favorites.has(i.id)).map(i => i.id),
  changedExistingMembers: baseline.folders.flatMap(f => f.items.filter(i => !members.get(f.id)?.has(i.id))
    .map(i => ({ folderId: f.id, itemId: i.id }))),
  batchCount: state.batches.length,
  folders: current.folders.map(f => ({ name: f.name, id: f.id, readable: f.items.length,
    displayed: f.total, added: plan.decisions.filter(d => d.folderId === f.id && members.get(f.id)?.has(d.itemId)).length }))
};
result.passed = result.currentUnclassified === 0 && result.unresolved.length === 0 &&
  result.missingDestination.length === 0 && result.missingFavorites.length === 0 && result.changedExistingMembers.length === 0;
await save("audit-result.json", result);
const report = `# 本地抖音全量归类验收

验收时间：${new Date(current.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）。

状态：${result.passed ? "**通过：本轮全部可读取的未分类存量已入夹。**" : "**未通过：仍有未完成项目，详见本地审计数据。**"}

| 指标 | 结果 |
| --- | ---: |
| 扫描前可读取收藏 | ${result.startingFavorites} |
| 扫描前未分类 | ${result.startingUnclassified} |
| 按计划目标夹最终读回 | ${result.verified} |
| 最终未分类 | ${result.currentUnclassified} |
| 平台标记失效、无法读取的收藏 | ${result.invalidCount} |
| 原有已入夹成员丢失 | ${result.changedExistingMembers.length} |
| 原有可读取收藏丢失 | ${result.missingFavorites.length} |

按本轮分类计划与当前平台成员回读核对目标归属、原有成员及收藏保留情况。失效内容保留原状，不取消收藏。

| 收藏夹 | 本轮新增 | 最终可读取成员 |
| --- | ---: | ---: |
${result.folders.map(f => `| ${f.name.replaceAll("|", "\\|")} | ${f.added} | ${f.readable} |`).join("\n")}

## 实现与边界

- 扫描覆盖全部分页，按“全部收藏 − 所有夹成员并集”识别未分类，不按发布时间、收藏时间或前三条等固定总量过滤。
- 使用接口提供的字符串收藏夹ID；完整保留数组，校验从cursor=0到明确末页的游标链，区分合法空夹、漏页和失败响应。
- 分类计划绑定本轮快照哈希，旧序号清单不能直接用于新扫描。
- 持久登录保存在本机独立Chrome配置；运行有执行锁、提交前落盘与读回记录。恢复执行先核对平台当前成员，排除已归类内容。
- 此报告核验收藏成员，不代表云端模型质量或所有账号的分类效果。

代码入口：\`scripts/local-scan.mjs\`、\`scripts/local-plan.mjs\`、\`scripts/local-run.mjs\`、\`scripts/local-audit.mjs\`。

详细证据仅保存在本机 \`.data/local-browser/\`：\`snapshot.json\`（基线）、\`classification-plan.json\`（分类决策）、\`run-state.json\`（逐批进度）、\`verified-batch-*.json\`（操作后读回）、\`final-snapshot.json\`（独立终验）、\`audit-result.json\`（对账）。不要公开分享浏览器配置和私有快照。
`;
await save("audit-report.json", { at: current.at, markdown: report });
console.log(JSON.stringify({ passed: result.passed, verified: result.verified, unclassified: result.currentUnclassified,
  missingFavorites: result.missingFavorites.length, changedExistingMembers: result.changedExistingMembers.length }));
if (!result.passed) process.exitCode = 1;
