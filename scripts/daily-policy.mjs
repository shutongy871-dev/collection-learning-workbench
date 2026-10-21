import { createHash } from "node:crypto";
import { matchesFolderRule } from "./folder-rules.mjs";
import { scheduledTrigger } from "../src/local-service/schedule.mjs";
import { provePages, proveFolderMembers, unique } from "./local-scan.mjs";
import { dailyLedgerKey } from "./runtime-config.mjs";

export function dailyDue(config, ledger, now = new Date()) {
  if (!config.enabled || now < new Date(config.startsAt)) return null;
  const due = scheduledTrigger({ schedule: { enabled: true, time: "09:00", timezone: "Asia/Shanghai" } }, now);
  // 当天失败/中断也算一次尝试，避免每分钟重试；次日仍扫描全部积压。
  if (!due || ledger[dailyLedgerKey(config, due.scheduleDate)]) return null;
  const legacy = ledger[due.scheduleDate];
  if (legacy && (!legacy.accountId || legacy.accountId === config.accountId)) return null;
  return due;
}

export function buildDailyPlan(snapshot, rules, accountId) {
  if (!snapshot.complete || !accountId || String(snapshot.account?.id) !== String(accountId)) {
    throw new Error("account_or_snapshot_unverified");
  }
  const folderPages = provePages(snapshot.folderPages);
  const folderIds = unique(folderPages, "folders").map(f => f.id).sort();
  if (JSON.stringify(folderIds) !== JSON.stringify(snapshot.folders.map(f => f.id).sort())) {
    throw new Error("folder_scope_mismatch");
  }
  const filed = new Set();
  for (const folder of snapshot.folders) {
    if (!folder.id || String(folder.owner) !== String(accountId)) throw new Error("folder_owner_mismatch");
    for (const item of unique(proveFolderMembers(folder), "items")) filed.add(item.id);
  }
  // SQL 等效：全部可读收藏 LEFT ANTI JOIN 全部收藏夹成员 ON item_id。
  const items = unique(provePages(snapshot.favoritePages), "items").filter(i => !filed.has(i.id));
  if (JSON.stringify(items.map(i => i.id)) !== JSON.stringify(snapshot.unclassified.map(i => i.id))) {
    throw new Error("unclassified_scope_mismatch");
  }
  const decisions = [], unresolved = [];
  for (const item of items) {
    const hits = rules.filter(rule => matchesFolderRule(item, rule));
    const destinations = [...new Map(hits.map(r => [r.folderId ?? r.folderName, r])).values()];
    const targets = snapshot.folders.filter(f => f.name === destinations[0]?.folderName &&
      (!destinations[0].folderId || f.id === destinations[0].folderId));
    if (destinations.length !== 1 || targets.length !== 1) {
      unresolved.push({ ...item, reason: destinations.length > 1 ? "conflicting_rules" :
        destinations.length ? "destination_missing_or_ambiguous" : "no_rule_match",
        candidates: destinations.map(r => r.folderName) });
      continue;
    }
    decisions.push({ itemId: item.id, title: item.title, folderId: targets[0].id,
      folderName: targets[0].name, source: "daily_keyword_rule", reason: "single_destination_match" });
  }
  return { createdAt: new Date().toISOString(), account: snapshot.account, snapshotAt: snapshot.at,
    snapshotHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    rulesHash: createHash("sha256").update(JSON.stringify(rules)).digest("hex"),
    total: items.length, decisions, unresolved };
}
