import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { atomicJSON, readJSON } from "../understanding/pipeline.mjs";
import { emptyState, importCollections } from "./import.mjs";
import { normalizeLearning } from "./scheduler.mjs";

export function learningStore(dataDir) {
  const directory = join(dataDir, "learning"), file = join(directory, "state.json");
  const read = async () => normalizeLearning(await readJSON(file, emptyState()));
  async function mutate(fn) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let compromised;
    const release = await lockfile.lock(file, { realpath: false, stale: 120000, update: 20000,
      retries: { retries: 100, minTimeout: 20, maxTimeout: 200, factor: 1.2 },
      onCompromised: e => { compromised = e; } });
    try {
      const state = await read();
      const result = await fn(state);
      normalizeLearning(state);
      if (compromised) throw compromised;
      await atomicJSON(file, state);
      return result;
    } finally { await release(); }
  }
  return { read, mutate, initialize: (importOnStart = true) => mutate(async state => {
    if (importOnStart) Object.assign(state, await importCollections(dataDir, state));
  }) };
}
