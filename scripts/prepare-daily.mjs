import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { acquireLock, initializeDaily } from "./daily.mjs";
import { macLaunchAgent, macLaunchLogPath } from "./runtime-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = resolve(root, ".data/daily");
await mkdir(base, { recursive: true, mode: 0o700 });
const lock = await acquireLock(resolve(base, "execution.lock"));
if (!lock) throw new Error("another_run_in_progress");
let config;
try { config = await initializeDaily(base); }
finally { await lock.release(); }
let plist;
if (process.platform === "darwin") {
  plist = resolve(base, "com.collection-tidy-agent.daily.plist");
  await writeFile(plist, macLaunchAgent(root, process.execPath, process.env), { mode: 0o600 });
}
console.log(JSON.stringify({ prepared: true, firstRun: config.startsAt,
  timezone: config.timezone, setupRequired: !config.accountId, plist,
  ...(plist ? { launchLog: macLaunchLogPath() } : {}),
  ...(config.accountId ? {} : { next: "运行 npm run browser 登录，再在另一终端运行 npm run setup" }) }));
