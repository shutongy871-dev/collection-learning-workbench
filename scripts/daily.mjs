import { mkdir, readFile, writeFile, rename, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dailyDue, buildDailyPlan } from "./daily-policy.mjs";
import { learnFolderRules, diffFolderRules } from "./folder-rules.mjs";
import { defaultDailyConfig, dailyLedgerKey, runtimeEnvironment } from "./runtime-config.mjs";
import { unique, provePages } from "./local-scan.mjs";
import { reuseBackgroundBrowser, closeBrowserChild } from "./browser-session.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const collectionDataDir = resolve(process.env.COLLECTION_DATA_DIR || resolve(root, ".data"));
const base = resolve(collectionDataDir, "daily");
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (e) { if (e.code === "ENOENT" && fallback !== undefined) return fallback; throw e; }
}
export async function putJson(path, data) {
  await writeFile(`${path}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

// 调用方持有每日执行锁；新电脑无需原账号的任何验收快照。
export async function initializeDaily(dataDir, now = new Date()) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = resolve(dataDir, "config.json");
  const existing = await readJson(file, null);
  if (existing) return existing;
  const config = defaultDailyConfig(now);
  await putJson(file, config);
  return config;
}

export async function refreshDailyClassification(snapshot, accountId, dataDir, runDir, options = {}) {
  // 从证明完整的成员页训练，不能信任未校验的缓存items。
  buildDailyPlan(snapshot, [], accountId);
  const rules = learnFolderRules(snapshot.folders.map(f => ({ ...f,
    items: unique(provePages(f.pages), "items") })), options);
  // 先验证账号、全量分页、未分类差集；失败时不发布新规则，也不回退旧规则执行。
  const plan = buildDailyPlan(snapshot, rules, accountId);
  const previous = await readJson(resolve(dataDir, "rules.json"), []);
  const report = { at: new Date().toISOString(), accountId, snapshotAt: snapshot.at,
    snapshotHash: plan.snapshotHash, rulesHash: plan.rulesHash,
    changes: diffFolderRules(previous, rules),
    enabled: rules.filter(r => r.enabled).length,
    disabled: rules.filter(r => !r.enabled).map(r => ({ folderId: r.folderId, folderName: r.folderName,
      reason: r.disabledReason })), rules };
  // 保留首轮迁移前的人工规则；rules.json今后是每天生成的输出。
  if (previous.length && !(await readJson(resolve(dataDir, "rules-before-name-sync.json"), null))) {
    await putJson(resolve(dataDir, "rules-before-name-sync.json"), previous);
  }
  await putJson(resolve(runDir, "rules-update.json"), report);
  await putJson(resolve(runDir, "classification-plan.json"), plan);
  await putJson(resolve(dataDir, "rules.json"), rules);
  await putJson(resolve(dataDir, "rules-update.json"), report);
  return { plan, report };
}

const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
};
export async function acquireLock(path) {
  // 恢复检查也加锁，避免两个进程同时清理过期锁并开始操作浏览器。
  let guard;
  try { guard = await open(`${path}.guard`, "wx", 0o600); }
  catch (e) { if (e.code === "EEXIST") return null; throw e; }
  try {
    const previous = await readJson(path, null);
    if (previous && [previous.pid, ...(previous.children ?? [])].some(alive)) return null;
    if (previous) await unlink(path);
    const handle = await open(path, "wx", 0o600);
    const state = { pid: process.pid, children: [], startedAt: new Date().toISOString() };
    const persist = async () => { await handle.truncate(0); await handle.write(JSON.stringify(state), 0); };
    await persist();
    return {
      async child(pid) { state.children.push(pid); await persist(); },
      async release() { await handle.close(); await unlink(path); }
    };
  } finally {
    await guard.close();
    await unlink(`${path}.guard`);
  }
}
// 只传必要系统环境，不把 agent 会话的授权信息传给常驻浏览器或写入配置。
const childEnv = runtimeEnvironment();

async function main() {
  const mode = process.argv[2];
  if (!["--tick", "--run-now", "--status"].includes(mode)) throw new Error("usage: --tick | --run-now | --status");
  await mkdir(base, { recursive: true, mode: 0o700 });
  let config = await readJson(resolve(base, "config.json"), defaultDailyConfig());
  let ledger = await readJson(resolve(base, "ledger.json"), {});
  if (mode === "--status") {
    console.log(JSON.stringify({ config, setupRequired: !config.accountId,
      ledger, latest: await readJson(resolve(base, "latest.json"), null) }, null, 2));
    return;
  }
  const lock = await acquireLock(resolve(base, "execution.lock"));
  if (!lock) { console.log('{"status":"skipped","reason":"another_run_or_lock_recovery"}'); return { platformBusy: true }; }
  let browserChild, browserLog, inhibitor, run, due, runDir;
  try {
    config = await initializeDaily(base);
    if (!config.accountId) {
      if (mode === "--tick") return; // 未初始化时不反复唤起浏览器、不消耗每日名额。
      throw new Error("account_not_bound:先运行 npm run browser 登录，再在另一终端运行 npm run setup");
    }
    ledger = await readJson(resolve(base, "ledger.json"), {});
    due = dailyDue(config, ledger);
    if (mode === "--tick" && !due) return;
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    runDir = resolve(base, "runs", id);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    run = { id, accountId: config.accountId, trigger: mode === "--tick" ? "scheduled" : "manual",
      scheduledFor: mode === "--tick" ? due.scheduledFor : undefined,
      startedAt: new Date().toISOString(), status: "running", directory: runDir };
    // 在浏览器动作之前登记，故障/退出不能造成当天自动重放。
    if (run.trigger === "scheduled") {
      ledger[dailyLedgerKey(config, due.scheduleDate)] = run;
      await putJson(resolve(base, "ledger.json"), ledger);
    }
    await putJson(resolve(base, "latest.json"), run);
    if (process.platform === "darwin") {
      inhibitor = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { env: childEnv, stdio: "ignore" });
      inhibitor.on("error", () => {});
    }
    const browserDir = resolve(collectionDataDir, "local-browser");
    let session = await reuseBackgroundBrowser(browserDir, { timeout: 5000 });
    let endpoint = session?.endpoint;
    if (session) await session.browser.close(); // 只断开检测连接。
    else {
      const log = browserLog = await open(resolve(runDir, "browser.log"), "a", 0o600);
      browserChild = spawn(process.execPath, ["scripts/local-browser.mjs", "--headless", "--defer-navigation"], {
        cwd: root, env: { ...childEnv, COLLECTION_BROWSER_DIR: browserDir }, stdio: ["ignore", "pipe", log.fd, "ipc"]
      });
      await lock.child(browserChild.pid);
      await new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error("browser_start_timeout")), 60_000);
        const reject = e => { clearTimeout(timer); fail(e); };
        browserChild.once("error", reject);
        browserChild.once("exit", () => reject(new Error("browser_start_failed")));
        let output = "";
        browserChild.stdout.on("data", data => {
          log.write(data).catch(() => {});
          output = (output + data).slice(-4000);
          if (output.includes("[local-browser] ready")) { clearTimeout(timer); done(); }
        });
      });
      session = await reuseBackgroundBrowser(browserDir, { timeout: 5000 });
      if (!session) throw new Error("browser_start_unverified");
      endpoint = session.endpoint;
      await session.browser.close();
    }
    run.browserMode = "background";
    run.browserMuted = true;
    const step = async (script, ...args) => {
      const output = await open(resolve(runDir, `${script}.log`), "a", 0o600);
      try {
        const child = spawn(process.execPath, [`scripts/${script}.mjs`, ...args], {
          cwd: root, env: { ...childEnv, COLLECTION_RUN_DIR: runDir, COLLECTION_ACCOUNT_ID: config.accountId,
            COLLECTION_BROWSER_ENDPOINT: endpoint },
          stdio: ["ignore", output.fd, output.fd]
        });
        const exited = new Promise((done, fail) => {
          child.once("error", fail);
          child.once("exit", (code, signal) => code === 0 ? done() : fail(new Error(`${script}_failed:${code ?? signal}`)));
        });
        await lock.child(child.pid);
        await exited;
      } finally { await output.close(); }
    };
    await step("local-scan");
    let snapshot = await readJson(resolve(runDir, "snapshot.json"));
    if (String(snapshot.account?.id) !== String(config.accountId)) {
      throw new Error("account_changed:如需改用当前登录账号，请先运行 npm run setup");
    }
    if (!snapshot.folders.length || (config.defaultFoldersSetup?.accountId === config.accountId &&
        config.defaultFoldersSetup.status !== "completed")) {
      // 先保存选择默认体系，确保部分创建失败后能补齐，而不会误当现有用户体系。
      if (config.defaultFoldersSetup?.accountId !== config.accountId) {
        config.defaultFoldersSetup = { accountId: config.accountId, status: "creating", entries: [] };
      }
      await putJson(resolve(base, "config.json"), config);
      try { await step("ensure-default-folders"); }
      finally {
        const checkpoint = await readJson(resolve(runDir, "default-folders-setup.json"), null);
        if (checkpoint) {
          config.defaultFoldersSetup = checkpoint;
          await putJson(resolve(base, "config.json"), config);
        }
      }
      await step("local-scan"); // 创建后完整复扫，使用平台真实ID与最新成员。
      snapshot = await readJson(resolve(runDir, "snapshot.json"));
    }
    const { plan, report } = await refreshDailyClassification(snapshot, config.accountId, base, runDir,
      { useDefaults: config.defaultFoldersSetup?.accountId === config.accountId });
    run.ruleRefresh = { enabled: report.enabled, disabled: report.disabled.length, changes: report.changes.length };
    run.scanned = snapshot.favorites.length;
    run.unclassifiedBefore = plan.total;
    run.pending = plan.unresolved.length;
    run.verified = 0;
    if (plan.decisions.length) {
      await step("local-run");
      const state = await readJson(resolve(runDir, "run-state.json"));
      run.verified = Object.values(state.entries).filter(e => e.status === "verified").length;
      await step("local-scan", "final-snapshot.json");
      const final = await readJson(resolve(runDir, "final-snapshot.json"));
      if (final.account?.id !== snapshot.account.id) throw new Error("final_account_mismatch");
      const locations = new Map(final.folders.map(f => [f.id, new Set(f.items.map(i => i.id))]));
      const missing = plan.decisions.filter(d => !locations.get(d.folderId)?.has(d.itemId));
      if (missing.length) throw new Error("final_destination_readback_missing");
      run.pending = final.unclassified.length;
    }
    run.status = run.pending ? "partial" : "completed";
  } catch (e) {
    if (!run) throw e;
    run.status = "blocked";
    run.error = e.message;
    run.action = e.code === "visible_browser_in_use" ?
      "抖音登录程序还未退出，同步未开始。请在学习网页右上角「我」点击「检查登录」，然后再次同步。" :
      "后台任务已停止，没有弹出网页。查看本次日志；如需登录或验证，方便时运行 npm run browser，完成后退出专用浏览器，再运行 npm run daily。";
    process.exitCode = 1;
    return { platformBusy: true }; // 登录/平台异常时本次也不继续发起内容采集。
  } finally {
    await closeBrowserChild(browserChild);
    inhibitor?.kill();
    await browserLog?.close();
    if (run) {
      run.finishedAt = new Date().toISOString();
      await putJson(resolve(runDir, "result.json"), run);
      await putJson(resolve(base, "latest.json"), run);
      if (run.trigger === "scheduled") {
        ledger[dailyLedgerKey(config, due.scheduleDate)] = run;
        await putJson(resolve(base, "ledger.json"), ledger);
      }
      console.log(JSON.stringify(run));
    }
    await lock.release();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; }).then(async result => {
    // main's finally releases the platform lock first; content acquisition owns its own browser lock.
    if (result?.platformBusy || !["--tick", "--run-now"].includes(process.argv[2])) return;
    try {
      const { learningStore } = await import("../src/learning/store.mjs");
      const { importCollections } = await import("../src/learning/import.mjs");
      const store = learningStore(collectionDataDir);
      await store.mutate(async state => Object.assign(state, await importCollections(collectionDataDir, state)));
      if (process.argv.includes("--classification-only")) return;
      const { runContentBatch } = await import("../src/learning/batch.mjs");
      const result = await runContentBatch({ dataDir: collectionDataDir, scheduled: true });
      if (result.reason !== "disabled" && result.reason !== "before_schedule")
        console.log(JSON.stringify({ contentBatch: result }));
    } catch (e) { console.error("content_batch_failed", e.code || "see_content_batch_status"); process.exitCode = 1; }
  });
}
