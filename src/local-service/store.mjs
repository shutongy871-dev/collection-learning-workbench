/**
 * store.mjs —— 控制面状态持久化（单文件 JSON，零依赖）
 * 状态分三域：config（配置）/ tasks（任务队列）/ devices（设备注册表）
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.COLLECTION_AGENT_DATA_DIR ?? join(__dirname, "..", "..", ".data");
const STATE_FILE = join(DATA_DIR, "state.json");

const DEFAULT_STATE = {
  config: {
    platform: "douyin",
    feishuWebhook: "",
    // L2 多模态大模型配置；Key 仅存本机，不出设备
    llm: { provider: "", apiKey: "", model: "", endpoint: "" },
    schedule: { enabled: false, time: "09:00", timezone: "Asia/Shanghai" },
    // 文件夹画像：{ id, name, count }
    folders: [],
    // L1 关键词规则：{ folderId, folderName, keywords: [], authors: [], weight }
    rules: []
  },
  tasks: [],
  devices: []
};

export async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      config: { ...DEFAULT_STATE.config, ...parsed.config, llm: { ...DEFAULT_STATE.config.llm, ...(parsed.config?.llm ?? {}) }, schedule: { ...DEFAULT_STATE.config.schedule, ...(parsed.config?.schedule ?? {}) } },
      tasks: parsed.tasks ?? [],
      devices: parsed.devices ?? []
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error; // 不把损坏的历史状态默默覆盖为空状态
    return structuredClone(DEFAULT_STATE);
  }
}

let writeQueue = Promise.resolve();
export function saveState(state) {
  const serialized = JSON.stringify(state, null, 2);
  const write = writeQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(`${STATE_FILE}.tmp`, serialized, { encoding: "utf-8", mode: 0o600 });
    await rename(`${STATE_FILE}.tmp`, STATE_FILE);
  });
  writeQueue = write.catch(() => {});
  return write;
}

export const nowIso = () => new Date().toISOString();

export function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
