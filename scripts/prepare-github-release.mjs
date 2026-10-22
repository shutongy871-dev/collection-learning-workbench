import { mkdir, readdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const dest = resolve(root, ".data/github-release");
// New code-only tree; never initialize Git in the directory containing personal data.
try { await lstat(dest); throw new Error("release_already_exists:保留现有发布目录，请先自行移走再生成"); }
catch (e) { if (e.code !== "ENOENT") throw e; }
const allowed = new Set([".mjs", ".js", ".py", ".sh", ".html", ".css", ".json", ".yml"]);
const entries = [];
async function visit(dir) {
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== "__pycache__") await visit(path);
    else if (entry.isFile() && allowed.has(entry.name.slice(entry.name.lastIndexOf("."))) &&
      path !== "scripts/replay-diagnostics.mjs") entries.push(path);
    else if (entry.isSymbolicLink()) throw new Error(`release_symlink:${path}`);
  }
}
for (const dir of ["src", "scripts", "test", ".github"]) await visit(dir);
entries.push("package.json", "package-lock.json", "requirements-content.txt", "requirements-funasr.txt",
  ".env.content.example", ".gitignore", "README.md");

const privateValues = new Set();
async function privateJson(path) {
  try { return JSON.parse(await readFile(join(root, path), "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
const config = await privateJson(".data/daily/config.json");
const account = await privateJson(".data/account-status.json");
const state = await privateJson(".data/learning/state.json");
const models = await privateJson(".data/model-settings.json");
if (typeof models?.apiKey === "string" && models.apiKey.length >= 12) privateValues.add(models.apiKey);
for (const value of [config?.accountId, config?.accountName, account?.accountId, account?.nickname,
  ...(state?.sources ?? []).map(s => s.accountId), ...(state?.items ?? []).map(i => i.id)]) {
  if (typeof value === "string" && value.length >= 6) privateValues.add(value);
}
try {
  const env = await readFile(join(root, ".env.content"), "utf8");
  for (const line of env.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?\w*(?:API_KEY|TOKEN|SECRET)\s*=\s*(.+?)\s*$/);
    if (match && match[1].length >= 12) privateValues.add(match[1].replace(/^["']|["']$/g, ""));
  }
} catch (e) { if (e.code !== "ENOENT") throw e; }
const forbidden = [
  /\/Users\/(?!example(?:[ /]|$))[^/\s]+/,
  /https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-z\d-]{16,}/i,
  /\bsk-[a-z\d_-]{20,}/i,
  /\bMS4wLjAB[a-z\d_-]{20,}/i
];
const files = [];
for (const path of entries.sort()) {
  const original = await readFile(join(root, path), "utf8");
  // Remove temporary outbound debugging instrumentation from the public code.
  const text = original.split("\n").filter(line =>
    !/^\s*if \(process\.env\.DEBUG_(?:RUN_ID|SERVER_URL|EMPTY_PREFETCH|PAGINATION)\)/.test(line) &&
    !/^\s*\/\/ #(?:end)?region/.test(line)).join("\n");
  if (forbidden.some(p => p.test(text)) || [...privateValues].some(v => text.includes(v)))
    throw new Error(`release_privacy_check_failed:${path}`); // Never print matching data.
  files.push({ path, text, sha256: createHash("sha256").update(text).digest("hex") });
}
// All content is validated before any file is copied.
for (const file of files) {
  const target = join(dest, file.path);
  await mkdir(resolve(target, ".."), { recursive: true });
  const mode = (await lstat(join(root, file.path))).mode & 0o777;
  await writeFile(target, file.text, { mode });
}
await writeFile(join(root, ".data/github-release-report.json"), JSON.stringify({
  checkedAt: new Date().toISOString(), files: files.map(({ path, sha256 }) => ({ path, sha256 })),
  personalDataIncluded: false, secretValuesIncluded: false, debugInstrumentationRemoved: true
}, null, 2), { mode: 0o600 });
console.log(`已生成 ${files.length} 个代码文件：${relative(root, dest)}；个人数据和配置未复制。`);
