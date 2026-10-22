import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Shared by interactive login, background scans and media acquisition. Call only
// after a current, trusted platform response; saved configs are not login proof.
export async function recordAccountLogin(dataDir, account, expectedAccountId) {
  if (!account?.id || String(account.id) === "0") throw new Error("account_not_logged_in");
  if (!expectedAccountId || String(account.id) !== String(expectedAccountId)) throw new Error("account_changed");
  return save(dataDir, { status: "verified", accountId: String(account.id),
    nickname: typeof account.nickname === "string" ? account.nickname : "",
    checkedAt: new Date().toISOString() });
}
export async function recordAccountFailure(dataDir, error) {
  const code = error.code || error.message || "";
  if (!/^(account_not_logged_in|logged_in_account_required|account_changed|account_scope_mismatch|final_account_mismatch|platform_forbidden|platform_read_failed|platform_response_invalid|self_page_ready_timeout)(?::|$)/.test(code))
    return;
  return save(dataDir, { status: "unverified", checkedAt: new Date().toISOString() });
}
async function save(dataDir, status) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, "account-status.json"), temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(status, null, 2), { mode: 0o600 });
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
  return status;
}
