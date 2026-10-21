import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { acquireLock } from "./daily.mjs";
import { connect, watch, trigger, openSelfPage, finishPages, collect, readFolderMembers, proveFolderMembers, unique, save, dir } from "./local-scan.mjs";

async function main() {
const plan = JSON.parse(await readFile(dir + "classification-plan.json"));
const snapshot = JSON.parse(await readFile(dir + "snapshot.json"));
if (plan.snapshotHash !== createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") ||
    !snapshot.complete || !plan.account?.id) throw new Error("plan_snapshot_mismatch");
for (const folder of snapshot.folders) proveFolderMembers(folder);
const batchSize = 20; // UI 操作批次，不是总量上限；遍历全部 decisions。
const lock = await acquireLock(dir + "execution.lock");
if (!lock) throw new Error("another_local_run_or_lock_recovery");
let verifier;
try {
let state;
try { state = JSON.parse(await readFile(dir + "run-state.json")); }
catch (e) { if (e.code !== "ENOENT") throw e; }
if (state && state.snapshotHash !== plan.snapshotHash) throw new Error("run_plan_mismatch");
state ??= { snapshotHash: plan.snapshotHash, account: plan.account, startedAt: new Date().toISOString(), entries: {}, batches: [] };
const { browser, page } = await connect();
verifier = await browser.contexts()[0].newPage();
verifier.setDefaultTimeout(12_000);
const persist = () => save("run-state.json", state);
const log = (data) => console.log(JSON.stringify(data));

async function freshFolders() {
  const { capture, account } = await openSelfPage(verifier, { expectedAccountId: plan.account.id });
  try {
    const chain = await finishPages(verifier, capture, "/collects/list/",
      () => collect(capture.records, "/collects/list/"));
    await capture.flush();
    if (unique(chain, "folders").some(f => f.owner !== account.id)) throw new Error("account_scope_mismatch");
    return { capture, folders: unique(chain, "folders"), account };
  } catch (e) { capture.stop(); throw e; }
}
const memberRecoveries = [];
const folderMembers = (capture, folder) => readFolderMembers({
  page: verifier, capture, folder, accountId: plan.account.id,
  onRecovery: async recovery => {
    if (!memberRecoveries.includes(recovery)) memberRecoveries.push(recovery);
    await save("run-member-recovery.json", { at: new Date().toISOString(), recoveries: memberRecoveries });
  }
});
async function verifyBatch(batch) {
  const { capture, folders } = await freshFolders();
  try {
    const folder = folders.find(f => f.id === batch.folderId);
    if (!folder) throw new Error("destination_disappeared");
    const evidence = await folderMembers(capture, folder);
    const ids = new Set(evidence.items.map(i => i.id));
    const evidenceFile = `verified-batch-${batch.id}.json`;
    await save(evidenceFile, { at: new Date().toISOString(), account: plan.account, batch, evidence });
    for (const id of batch.itemIds) {
      state.entries[id] = { folderId: batch.folderId, status: ids.has(id) ? "verified" : "verification_failed",
        verifiedAt: new Date().toISOString(), evidenceFile };
    }
    batch.status = batch.itemIds.every(id => ids.has(id)) ? "verified" : "verification_failed";
    await persist();
    if (batch.status !== "verified") throw new Error("destination_readback_missing");
  } finally { capture.stop(); }
}
async function checkItem(itemId) {
  const card = page.locator("li:visible").filter({ has: page.locator(`a[href*="/${itemId}"]`) });
  if (await card.count() !== 1) throw new Error(`item_card_missing:${itemId}`);
  const input = card.locator("input[type=checkbox]");
  if (await input.isChecked()) throw new Error(`unexpected_selection:${itemId}`);
  await card.scrollIntoViewIfNeeded();
  const mark = card.locator(".semi-checkbox-inner-display");
  const box = await mark.boundingBox();
  if (box?.y < 220) {
    await page.mouse.move(1100, 450);
    await page.mouse.wheel(0, -500);
    await page.waitForFunction(el => el.getBoundingClientRect().top >= 220, await mark.elementHandle());
  }
  await mark.click({ timeout: 4_000 });
  if (!await input.isChecked()) throw new Error(`selection_failed:${itemId}`);
}
async function applyBatch(folder, decisions) {
  if (await page.getByText("批量管理", { exact: true }).isVisible()) {
    await page.getByText("批量管理", { exact: true }).click();
  }
  if (await page.locator("li:visible input:checked").count()) throw new Error("preexisting_selection");
  for (const decision of decisions) await checkItem(decision.itemId);
  if (await page.locator("li:visible input:checked").count() !== decisions.length) throw new Error("selection_count_mismatch");
  await page.getByText("加入收藏夹", { exact: true }).click();
  const name = page.getByText(folder.name, { exact: true });
  await name.waitFor();
  const row = name.locator("..").locator("..");
  if (await row.locator("input").isChecked()) throw new Error("preselected_destination");
  await row.locator(".semi-checkbox-inner-display").click();
  if (!await row.locator("input").isChecked() ||
      await row.locator("..").locator("input:checked").count() !== 1) throw new Error("destination_selection_mismatch");
  const batch = { id: state.batches.length + 1, folderId: folder.id, folderName: folder.name,
    itemIds: decisions.map(d => d.itemId), submittedAt: new Date().toISOString(), status: "submitting" };
  state.batches.push(batch);
  for (const id of batch.itemIds) state.entries[id] = { folderId: folder.id, status: "submitting", batchId: batch.id };
  await persist();
  const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith("/collects/video/move/"),
    { timeout: 15_000 });
  response.catch(() => {}); // 点击失败时，等待响应的超时不能产生未处理拒绝。
  await page.getByRole("button", { name: "确定", exact: true }).click();
  const r = await response;
  const result = await r.json();
  batch.write = { status: r.status(), code: result.status_code };
  batch.status = "submitted_unverified";
  await persist();
  if (r.status() !== 200 || result.status_code !== 0) throw new Error("write_rejected");
  await page.getByRole("button", { name: "确定", exact: true }).waitFor({ state: "hidden" });
  await verifyBatch(batch);
  log({ phase: "verified", batch: batch.id, folder: folder.name, count: decisions.length,
    verified: Object.values(state.entries).filter(e => e.status === "verified").length, total: plan.total });
  // 页面保存后会退出或保留管理模式；只清理仍存在的勾选，不反复点击已提交按钮。
  if (await page.getByText("退出管理", { exact: true }).last().isVisible()) {
    await page.getByText("退出管理", { exact: true }).last().click();
  }
}

try {
  state.status = "preflight";
  await persist();
  const { capture, folders } = await freshFolders();
  const memberships = [];
  try {
    for (const folder of folders) memberships.push(await folderMembers(capture, folder));
  } finally { capture.stop(); }
  if (plan.decisions.some(d => !folders.some(f => f.id === d.folderId))) throw new Error("planned_destination_disappeared");
  await save("preflight-memberships.json", { at: new Date().toISOString(), account: plan.account, memberships });
  const actual = new Map(memberships.flatMap(f => f.items.map(i => [i.id, f.id])));
  // 对中断前已提交但未读回的条目，先依据平台当前成员恢复，不盲目重复提交。
  for (const decision of plan.decisions) {
    const folderId = actual.get(decision.itemId);
    if (folderId) {
      state.entries[decision.itemId] = { status: folderId === decision.folderId ? "verified" : "already_filed_elsewhere",
        folderId, verifiedAt: new Date().toISOString(), evidenceFile: "preflight-memberships.json" };
    } else if (state.entries[decision.itemId]?.status === "submitting" ||
               state.entries[decision.itemId]?.status === "submitted_unverified") {
      throw new Error(`ambiguous_previous_write:${decision.itemId}`);
    } else delete state.entries[decision.itemId];
  }
  await persist();
  const captureMain = watch(page);
  let mainPages;
  try {
    await trigger(page, "/aweme/listcollection/", () => page.goto(
      "https://www.douyin.com/user/self?showTab=favorite_collection&showSubTab=video",
      { waitUntil: "domcontentloaded" }));
    mainPages = await finishPages(page, captureMain, "/aweme/listcollection/",
      () => collect(captureMain.records, "/aweme/listcollection/"));
  } finally { captureMain.stop(); }
  const available = new Set(unique(mainPages, "items").map(i => i.id));
  state.status = "running";
  await persist();
  for (const folder of folders) {
    const pending = plan.decisions.filter(d => d.folderId === folder.id && !state.entries[d.itemId] && available.has(d.itemId));
    for (let start = 0; start < pending.length; start += batchSize) {
      await applyBatch(folder, pending.slice(start, start + batchSize));
    }
  }
  state.unavailable = plan.decisions.filter(d => !available.has(d.itemId) && !state.entries[d.itemId]);
  state.unresolved = plan.unresolved;
  state.unfinished = plan.decisions.filter(d => !["verified", "already_filed_elsewhere"].includes(state.entries[d.itemId]?.status));
  state.status = plan.unresolved.length || state.unfinished.length ? "partial" : "completed";
  state.finishedAt = new Date().toISOString();
  await persist();
  log({ phase: state.status, entries: Object.keys(state.entries).length, unresolved: plan.unresolved.length,
    unavailable: state.unavailable.length });
} catch (error) {
  state.status = "blocked";
  state.error = error.message;
  await persist();
  console.error(error.message);
  process.exitCode = 1;
}
} finally {
  // 连接失败或状态读取失败也必须释放执行锁。
  try { await verifier?.close(); }
  finally { await lock.release(); }
}
}
main().then(() => process.exit(process.exitCode ?? 0))
  .catch(error => { console.error(error.message); process.exit(1); });
