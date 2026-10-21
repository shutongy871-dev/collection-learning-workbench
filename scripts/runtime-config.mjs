import { dirname, delimiter, resolve } from "node:path";
import { homedir } from "node:os";

export function defaultDailyConfig(now = new Date()) {
  const date = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  let first = new Date(`${date}T09:00:00+08:00`);
  if (first <= now) first = new Date(first.getTime() + 86400_000);
  return { enabled: true, platform: "douyin", time: "09:00", timezone: "Asia/Shanghai",
    startsAt: first.toISOString(), accountId: null };
}

export function bindDailyAccount(config, account, now = new Date()) {
  if (typeof account?.id !== "string" || !account.id.trim() || account.id === "0") {
    throw new Error("logged_in_account_required");
  }
  return { ...config, accountId: account.id, accountName: account.nickname ?? "",
    boundAt: now.toISOString() };
}

export function dailyLedgerKey(config, date) {
  return config.accountId ? `${config.accountId}:${date}` : date;
}

export function migrateDailyLedger(ledger, previousAccountId) {
  const migrated = {};
  for (const [key, record] of Object.entries(ledger)) {
    const accountId = record.accountId ?? previousAccountId;
    if (/^\d{4}-\d{2}-\d{2}$/.test(key) && accountId) {
      migrated[`${accountId}:${key}`] = { ...record, accountId };
    } else migrated[key] = record;
  }
  return migrated;
}

// 白名单保留各平台启动Chrome必需的环境，不传递agent会话凭证。
export function runtimeEnvironment(env = process.env, node = process.execPath) {
  const keys = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "DYLD_LIBRARY_PATH",
    "SystemRoot", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP",
    "HOMEDRIVE", "HOMEPATH", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"];
  return { ...Object.fromEntries(keys.filter(k => env[k]).map(k => [k, env[k]])),
    PATH: [dirname(node), env.PATH].filter(Boolean).join(delimiter) };
}

const xml = value => String(value).replace(/[<>&"']/g,
  c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

export function macLaunchLogPath(env = process.env) {
  // xpcproxy在Node启动前打开标准日志，不能依赖Desktop/Documents的交互式授权。
  return resolve(env.HOME || homedir(), "Library/Logs/collection-tidy-agent/daily.log");
}

export function macLaunchAgent(root, node, env) {
  // 绝对路径在目标电脑安装时生成，代码不绑定用户名、CPU架构或Node安装方式。
  const environment = runtimeEnvironment(env, node);
  const log = macLaunchLogPath(env);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.collection-tidy-agent.daily</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(resolve(root, "scripts/daily.mjs"))}</string><string>--tick</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment)
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("\n")}</dict>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>60</integer>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}
