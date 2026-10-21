import assert from "node:assert/strict";
import { mkdir, readFile, readdir, open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { runtimeEnvironment } from "./runtime-config.mjs";
import { atomicJSON, readJSON } from "../src/understanding/pipeline.mjs";
import { buildDailyPlan } from "./daily-policy.mjs";
import { acquireLock, refreshDailyClassification } from "./daily.mjs";
import { provePages, proveFolderMembers, unique } from "./local-scan.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("npm run verify:nonmodel [-- --live-scan]\n默认：隔离数据，实际ffmpeg/HTTP/Chrome，模拟模型，无平台写入。\n--live-scan：增加只读全量采集；先登录并绑定账号，退出登录浏览器，再运行 npm run browser:background。");
  process.exit(0);
}
if (args.some(a => a !== "--live-scan")) throw new Error("unknown_option:use_--help");
const output = join(root, ".data/readiness/runs", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), status: "running", node: process.version,
  platform: process.platform, output, cloudModelCalls: 0, platformWrites: 0, checks: [],
  scope: "nonmodel_including_question_generation_fsrs_and_content_batch", liveScan: { status: "not_requested" },
  excluded: ["真实云模型质量与计费", "真实平台入夹", "云部署与通知"] };
const reportFile = join(output, "result.json");
const publish = async () => {
  await atomicJSON(reportFile, report);
  await atomicJSON(join(root, ".data/readiness/latest.json"), report);
};
const hash = data => createHash("sha256").update(data).digest("hex");
const protectedPaths = [".data/learning/state.json", ".data/daily/config.json", ".data/daily/ledger.json",
  ".data/daily/rules.json", ".data/daily/latest.json", ".data/local-browser/snapshot.json",
  ".data/local-browser/final-snapshot.json", ".data/local-browser/run-state.json",
  ".data/content-batch/config.json", ".data/content-batch/ledger.json", ".data/content-batch/latest.json"];
async function productionHashes() {
  const result = {};
  for (const p of protectedPaths) {
    try { result[p] = hash(await readFile(join(root, p))); }
    catch (e) { if (e.code !== "ENOENT") throw e; result[p] = null; }
  }
  return result;
}
async function sourceHashes() {
  const result = {};
  async function visit(dir) {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== "__pycache__") await visit(path);
      if (entry.isFile() && /\.(mjs|js|py|sh|html|css|json)$/.test(entry.name))
        result[path] = hash(await readFile(join(root, path)));
    }
  }
  for (const dir of ["src", "scripts", "test"]) await visit(dir);
  for (const name of ["package.json", "package-lock.json"]) result[name] = hash(await readFile(join(root, name)));
  return result;
}
const environment = runtimeEnvironment();
async function step(name, args, extraEnv = {}, timeout = 180000) {
  console.log(`检查：${name}`);
  const log = join(output, `${name}.log`);
  const file = await open(log, "w", 0o600), start = Date.now();
  let exitCode;
  try {
    exitCode = await new Promise((done, fail) => {
      const child = spawn(process.execPath, args, { cwd: root,
        env: { ...environment, ...extraEnv }, stdio: ["ignore", file.fd, file.fd] });
      const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
      child.once("error", e => { clearTimeout(timer); fail(e); });
      child.once("close", (code, signal) => { clearTimeout(timer); done(code ?? signal); });
    });
  } finally { await file.close(); }
  const result = { name, status: exitCode === 0 ? "passed" : "failed", exitCode, elapsedMs: Date.now() - start, log };
  report.checks.push(result);
  await publish();
  if (exitCode !== 0) throw new Error(`${name}_failed:see_${log}`);
  return result;
}

const before = await productionHashes();
await publish();
try {
  report.sources = await sourceHashes();
  const tests = (await readdir(join(root, "test"))).filter(n => n.endsWith(".test.mjs")).sort().map(n => `test/${n}`);
  const unit = await step("regressions", ["--test", "--test-reporter=tap", ...tests]);
  const tap = await readFile(unit.log, "utf8");
  unit.counts = Object.fromEntries([...tap.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm)].map(m => [m[1], Number(m[2])]));
  assert.ok(unit.counts.tests > 0);
  assert.equal(unit.counts.fail, 0);
  assert.equal(unit.counts.skipped, 0, "验收不能跳过缺失的媒体依赖");
  const integrationDir = join(output, "integration");
  await step("integration", ["scripts/check-nonmodel-flow.mjs", integrationDir]);
  report.integration = await readJSON(join(integrationDir, "result.json"));
  const uiDir = join(output, "ui");
  await step("browser", ["scripts/check-learning-ui.mjs"], {
    LEARNING_TEST_DATA_DIR: report.integration.dataDir, LEARNING_TEST_OUTPUT_DIR: uiDir
  });
  report.browser = await readJSON(join(uiDir, "result.json"));
  if (args.includes("--live-scan")) {
    const config = await readJSON(join(root, ".data/daily/config.json"));
    assert.ok(config?.accountId, "先登录专用Chrome并运行 npm run setup");
    // 与定时任务互斥；只读采集也不能和另一个任务抢同一页面。
    const lock = await acquireLock(join(root, ".data/daily/execution.lock"));
    assert.ok(lock, "已有每日任务运行，请等它结束后重试");
    try {
      const dir = join(output, "live-scan");
      await mkdir(dir);
      await step("live-scan", ["scripts/local-scan.mjs"], {
        COLLECTION_RUN_DIR: dir, COLLECTION_ACCOUNT_ID: config.accountId
      }, 600000);
      const snapshot = await readJSON(join(dir, "snapshot.json"));
      const plan = buildDailyPlan(snapshot, [], config.accountId);
      assert.deepEqual(unique(provePages(snapshot.favoritePages), "items").map(i => i.id), snapshot.favorites.map(i => i.id));
      for (const f of snapshot.folders)
        assert.deepEqual(unique(proveFolderMembers(f), "items").map(i => i.id), f.items.map(i => i.id));
      const classificationDir = join(dir, "classification");
      await mkdir(classificationDir);
      const classified = await refreshDailyClassification(snapshot, config.accountId, classificationDir, dir);
      report.liveScan = { status: "passed", at: snapshot.at, snapshot: join(dir, "snapshot.json"),
        favorites: snapshot.favorites.length, folders: snapshot.folders.length,
        pages: snapshot.favoritePages.length, unclassified: plan.total,
        planned: classified.plan.decisions.length, unresolved: classified.plan.unresolved.length,
        platformWrites: 0 };
    } finally { await lock.release(); }
  }
  assert.deepEqual(await productionHashes(), before, "正式学习数据或每日台账在验收期间发生变化");
  assert.deepEqual(await sourceHashes(), report.sources, "验收期间源码发生变化，需要重新运行");
  report.productionUnchanged = true;
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.message;
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await publish();
}
console.log(`${report.status === "passed" ? "通过" : "未通过"}：${reportFile}`);
if (report.error) console.error(report.error);
