import { connect, trigger, openSelfPage, collect, unique, finishPages, save } from "./local-scan.mjs";
import { defaultFolders, defaultFolderName } from "./default-folders.mjs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dir } from "./local-scan.mjs";
import { fileURLToPath } from "node:url";
import { buildDailyPlan } from "./daily-policy.mjs";

// 仅完整扫描证明无收藏夹，或本账号存在未完成的默认创建记录时才能进入。
export async function ensureDefaultFolders(snapshot, accountId, adapter, checkpoint = null) {
  buildDailyPlan(snapshot, [], accountId);
  if (checkpoint && checkpoint.accountId !== accountId) throw new Error("default_checkpoint_account_mismatch");
  if (snapshot.folders.length && !checkpoint) return { skipped: true, reason: "existing_user_folders" };
  const state = structuredClone(checkpoint ?? { accountId, status: "creating", entries: [] });
  const checkLive = live => {
    if (live.accountId !== accountId) throw new Error("default_account_changed");
    // 扫描后用户新建目录，或恢复期间发现其他目录时停止，不混入默认体系。
    if (live.folders.some(f => !state.entries.some(e => e.name === f.name &&
        (!e.id || e.id === f.id)))) throw new Error("user_folders_changed_during_default_setup");
  };
  state.status = "creating";
  for (const template of defaultFolders) {
    const name = defaultFolderName(template);
    const live = await adapter.list();
    checkLive(live);
    const existing = live.folders.filter(f => f.name === name);
    if (existing.length > 1) throw new Error("duplicate_default_destination");
    let entry = state.entries.find(e => e.name === name);
    if (!existing.length) {
      if (!entry) { entry = { name }; state.entries.push(entry); }
      entry.status = "submitting";
      delete entry.id;
      await adapter.persist(state);
      await adapter.create(name);
      // 创建后重新读取真实ID，不把按钮点击当成功。
      const verified = await adapter.list();
      checkLive(verified);
      const matches = verified.folders.filter(f => f.name === name);
      if (matches.length !== 1) throw new Error("default_folder_readback_missing");
      entry.status = "verified";
      entry.id = matches[0].id;
    } else {
      entry.status = "verified";
      entry.id = existing[0].id;
    }
    await adapter.persist(state);
  }
  state.status = "completed";
  await adapter.persist(state);
  return state;
}

async function main() {
  const snapshot = JSON.parse(await readFile(resolve(dir, "snapshot.json"), "utf8"));
  const accountId = process.env.COLLECTION_ACCOUNT_ID;
  const config = JSON.parse(await readFile(new URL("../.data/daily/config.json", import.meta.url), "utf8"));
  const checkpoint = config.defaultFoldersSetup?.accountId === accountId ? config.defaultFoldersSetup : null;
  const { page } = await connect();
  const adapter = {
    async list() {
      const { capture, account } = await openSelfPage(page, { expectedAccountId: accountId });
      try {
        await page.getByRole("tab", { name: "收藏夹", exact: true }).waitFor();
        const pages = await finishPages(page, capture, "/collects/list/", () => collect(capture.records, "/collects/list/"));
        const folders = unique(pages, "folders");
        if (folders.some(f => f.owner !== account.id)) throw new Error("account_scope_mismatch");
        return { accountId: account.id, folders };
      } finally { capture.stop(); }
    },
    async create(name) {
      await page.getByText("新建收藏夹", { exact: true }).filter({ visible: true }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByPlaceholder("请输入收藏夹的名称（15个字以内）").fill(name);
      const publicOption = dialog.locator("input[type=checkbox]");
      if (await publicOption.count() && await publicOption.isChecked()) await publicOption.uncheck();
      await trigger(page, r => new URL(r.url()).pathname.includes("/collects/") &&
        r.request().method() === "POST", () => dialog.getByRole("button", { name: "确认", exact: true }).click());
      await dialog.waitFor({ state: "hidden" });
    },
    async persist(state) { await save("default-folders-setup.json", state); }
  };
  try { await ensureDefaultFolders(snapshot, accountId, adapter, checkpoint); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => process.exit(process.exitCode ?? 0));
}
