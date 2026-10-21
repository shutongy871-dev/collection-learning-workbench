import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dir, save, provePages, proveFolderMembers, unique } from "./local-scan.mjs";

const snapshot = JSON.parse(await readFile(dir + "snapshot.json"));
const review = JSON.parse(await readFile(dir + "review-groups.json"));
const snapshotHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
if (review.snapshotHash !== snapshotHash) throw new Error("review_snapshot_mismatch:请针对新快照重新分类");
if (!snapshot.complete || !snapshot.account?.id) throw new Error("unverified_snapshot");
provePages(snapshot.favoritePages);
for (const folder of snapshot.folders) proveFolderMembers(folder);
const filed = new Set(snapshot.folders.flatMap(f => unique(f.pages, "items").map(i => i.id)));
const unclassified = unique(snapshot.favoritePages, "items").filter(i => !filed.has(i.id));
if (JSON.stringify(unclassified.map(i => i.id)) !== JSON.stringify(snapshot.unclassified.map(i => i.id))) {
  throw new Error("unclassified_scope_mismatch");
}
const decisions = new Map();
for (const [name, indices] of Object.entries(review.groups)) {
  const folder = snapshot.folders.find(f => f.name === name);
  if (!folder?.id) throw new Error(`unknown_folder:${name}`);
  for (const index of indices) {
    const item = snapshot.unclassified[index];
    if (!item || decisions.has(item.id)) throw new Error(`duplicate_or_invalid_review:${index}`);
    decisions.set(item.id, { itemId: item.id, folderId: folder.id, folderName: folder.name,
      title: item.title, reason: review.basis, source: "assistant_review",
      visualEvidence: review.visualIndices?.includes(index) ? `review/${index}.png` : undefined });
  }
}
const plan = {
  createdAt: new Date().toISOString(), account: snapshot.account,
  snapshotAt: snapshot.at,
  snapshotHash,
  total: unclassified.length, decisions: [...decisions.values()],
  unresolved: unclassified.filter(i => !decisions.has(i.id))
};
await save("classification-plan.json", plan);
console.log(JSON.stringify({ total: plan.total, decided: plan.decisions.length, unresolved: plan.unresolved.length,
  distribution: Object.fromEntries(Object.entries(review.groups).map(([k,v]) => [k,v.length])) }));
