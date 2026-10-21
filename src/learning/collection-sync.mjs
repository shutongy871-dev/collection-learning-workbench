import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { acquireLock, readJson, putJson } from "../../scripts/daily.mjs";
import { runtimeEnvironment } from "../../scripts/runtime-config.mjs";
import { importCollections } from "./import.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
};

export async function runClassification({ dataDir, onChild, logPath }) {
  const config = await readJson(join(dataDir, "daily", "config.json"), null);
  if (!config?.accountId) throw new Error("account_not_bound");
  const log = await open(logPath, "a", 0o600);
  let output = "";
  try {
    const child = spawn(process.execPath, [resolve(root, "scripts/daily.mjs"), "--run-now", "--classification-only"], {
      cwd: root, env: { ...runtimeEnvironment(), COLLECTION_DATA_DIR: resolve(dataDir),
        COLLECTION_BROWSER_DIR: resolve(dataDir, "local-browser") },
      stdio: ["ignore", "pipe", log.fd]
    });
    const exited = new Promise((done, fail) => {
      child.once("error", fail);
      child.stdout.on("data", chunk => {
        output = (output + chunk).slice(-32000);
        void log.write(chunk).catch(() => {});
      });
      child.once("exit", code => {
        const line = output.trim().split("\n").at(-1);
        let result;
        try { result = JSON.parse(line); } catch {}
        if (result?.status === "skipped") return done({ status: "blocked", error: "collection_busy" });
        if (result?.status === "blocked") return done({ status: "blocked", error: result.error });
        if (code !== 0 || !["completed", "partial"].includes(result?.status))
          return fail(new Error("classification_failed"));
        done(result);
      });
    });
    await onChild(child.pid);
    return await exited;
  } finally { await log.close(); }
}

// A persisted job and cross-process lock keep reloads and duplicate clicks from launching another run.
export function collectionSync({ dataDir, store, runner = runClassification, onComplete = () => {} }) {
  const directory = join(dataDir, "collection-sync"), file = join(directory, "latest.json");
  async function status() {
    const job = await readJson(file, null);
    if (!job) return { status: "idle" };
    if (job.status === "running" && ![job.pid, job.childPid].some(alive))
      return { ...job, status: "interrupted", error: "sync_interrupted" };
    return job;
  }
  async function start() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = await acquireLock(join(directory, "execution.lock"));
    if (!lock) return { ...await status(), active: true };
    const job = { id: randomUUID(), status: "running", pid: process.pid, startedAt: new Date().toISOString() };
    try { await putJson(file, job); }
    catch (e) { await lock.release(); throw e; }
    void (async () => {
      try {
        const initial = await store.read();
        const config = await readJson(join(dataDir, "daily", "config.json"), null);
        const account = initial.sources.find(source => source.platform === "douyin")?.accountId;
        if (config?.accountId && account && String(config.accountId) !== String(account))
          throw new Error("account_changed");
        const before = new Set(initial.items.map(i => i.key));
        const result = await runner({ dataDir, logPath: join(directory, `${job.id}.log`),
          onChild: async pid => { await lock.child(pid); job.childPid = pid; await putJson(file, job); } });
        if (!["completed", "partial"].includes(result.status)) {
          job.status = "blocked"; job.error = result.error || "classification_failed";
        } else {
          await store.mutate(async s => Object.assign(s, await importCollections(dataDir, s)));
          const state = await store.read();
          Object.assign(job, { status: result.status, scanned: result.scanned ?? 0, classified: result.verified ?? 0,
            pending: result.pending ?? 0, imported: state.items.filter(i => !before.has(i.key)).length });
          await onComplete();
        }
      } catch (e) { job.status = "blocked"; job.error = e.message; }
      finally {
        job.finishedAt = new Date().toISOString();
        try { await putJson(file, job); } finally { await lock.release(); }
      }
    })().catch(e => console.error("collection_sync_failed", e.code || "sync_failed"));
    return { ...job, active: true };
  }
  return { start, status };
}
