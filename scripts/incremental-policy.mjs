// SQL 等效：本轮已验证收藏前缀 LEFT ANTI JOIN 上次成功同步的 item_id。
// 锚点只用于缩小读取范围；账号和收藏夹成员始终由当次平台响应证明。
export const auditIntervalMs = 7 * 24 * 60 * 60 * 1000;
export const folderSignature = folders => JSON.stringify(folders.map(f => [f.id, f.name]).sort());

export function incrementalReady(checkpoint, accountId, folders, now = new Date()) {
  return checkpoint?.version === 1 && checkpoint.accountId === accountId &&
    Array.isArray(checkpoint.knownIds) && checkpoint.knownIds.every(id => typeof id === "string" && id) &&
    Array.isArray(checkpoint.headIds) && checkpoint.headIds.length >= 5 &&
    checkpoint.headIds.every(id => checkpoint.knownIds.includes(id)) &&
    checkpoint.folderSignature === folderSignature(folders) &&
    Number.isFinite(Date.parse(checkpoint.lastFullAt)) &&
    now - new Date(checkpoint.lastFullAt) >= 0 &&
    now - new Date(checkpoint.lastFullAt) < auditIntervalMs;
}

export function findBoundary(items, checkpoint) {
  if (!checkpoint?.headIds || !checkpoint?.knownIds) return null;
  const ids = items.map(i => i.id);
  const known = new Set(checkpoint.knownIds);
  // 单个旧视频可能被置顶或重新收藏，至少连续五个且顺序一致才作为边界。
  for (let anchor = 0; anchor <= Math.min(20, checkpoint.headIds.length) - 5; anchor++) {
    const anchorIds = checkpoint.headIds.slice(anchor, anchor + 5);
    const start = ids.indexOf(anchorIds[0]);
    if (start < 0 || !anchorIds.every((id, offset) => ids[start + offset] === id)) continue;
    // 同页边界之后出现未知内容，说明排序假设不成立，必须继续完整读取。
    if (ids.slice(start).some(id => !known.has(id))) return null;
    return { start, anchorIds };
  }
  return null;
}

export function newCandidates(items, checkpoint) {
  const known = new Set(checkpoint.knownIds);
  return items.filter(i => !known.has(i.id));
}

export function nextCheckpoint(previous, snapshot, pending, now = new Date()) {
  if (!snapshot.complete && snapshot.scope !== "incremental_favorites") throw new Error("checkpoint_scope_invalid");
  const ids = snapshot.favorites.map(i => i.id);
  return {
    version: 1, accountId: snapshot.account.id, at: now.toISOString(),
    lastFullAt: snapshot.complete ? snapshot.at : previous.lastFullAt,
    folderSignature: folderSignature(snapshot.folders),
    headIds: ids.slice(0, 20),
    knownIds: snapshot.complete ? ids : [...new Set([...previous.knownIds, ...ids])],
    pending
  };
}

export function mergePending(previous, snapshot, plan, state) {
  const finished = new Set(Object.entries(state?.entries ?? {}).filter(([, entry]) =>
    ["verified", "already_filed_elsewhere"].includes(entry.status)).map(([id]) => id));
  const pending = new Map((snapshot.complete ? [] : previous?.pending ?? []).map(i => [i.id, i]));
  for (const item of snapshot.unclassified) if (!finished.has(item.id)) pending.set(item.id, item);
  for (const item of plan.unresolved) pending.set(item.id, item);
  for (const id of finished) pending.delete(id);
  return [...pending.values()];
}
