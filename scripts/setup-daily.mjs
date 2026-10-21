import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, initializeDaily, readJson, putJson } from "./daily.mjs";
import { bindDailyAccount, migrateDailyLedger } from "./runtime-config.mjs";
import { connect, openSelfPage } from "./local-scan.mjs";

export async function setupDaily(dataDir, readLiveAccount, now = new Date()) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(resolve(dataDir, "execution.lock"));
  if (!lock) throw new Error("another_run_in_progress:请等当前扫描或分类结束后再绑定账号");
  try {
    const config = await initializeDaily(dataDir, now);
    // 只接受当次平台返回的登录账号，不读取旧快照推断身份。
    const account = await readLiveAccount();
    const next = bindDailyAccount(config, account, now);
    const ledger = await readJson(resolve(dataDir, "ledger.json"), {});
    await putJson(resolve(dataDir, "ledger.json"), migrateDailyLedger(ledger, config.accountId));
    await putJson(resolve(dataDir, "config.json"), next);
    const result = { at: now.toISOString(), accountId: next.accountId, accountName: next.accountName,
      previousAccountId: config.accountId, changed: config.accountId !== next.accountId,
      classificationPerformed: false };
    await putJson(resolve(dataDir, "setup-result.json"), result);
    return result;
  } finally { await lock.release(); }
}

async function readLiveAccount() {
  let page;
  try { ({ page } = await connect({ background: false })); } // 用户主动绑定时可读取人工登录窗口。
  catch { throw new Error("login_browser_required:请先运行 npm run browser 并登录，再在另一终端运行 npm run setup"); }
  const { capture, account } = await openSelfPage(page, { folders: false });
  try { return account; }
  finally { capture.stop(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = "用法：npm run setup\n先运行 npm run browser 并登录，再运行本命令绑定当前抖音账号。\n本命令只绑定账号，不执行收藏分类。\n帮助：npm run setup -- --help";
  if (args.length) {
    const help = args.length === 1 && ["--help", "-h"].includes(args[0]);
    console[help ? "log" : "error"](usage);
    process.exitCode = help ? 0 : 1;
  } else {
    const root = fileURLToPath(new URL("../", import.meta.url));
    setupDaily(resolve(root, ".data/daily"), readLiveAccount)
      .then(result => { console.log(JSON.stringify({ ...result, message: "已绑定当前登录账号；请退出专用登录浏览器，再运行 npm run daily 在后台整理。" })); process.exit(0); })
      .catch(error => { console.error(error.message); process.exit(1); });
  }
}
