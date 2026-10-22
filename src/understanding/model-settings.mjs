import { readFileSync, lstatSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { contentConfig, questionConfig, loadContentEnv } from "./config.mjs";

export const modelPresets = {
  qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-vl-plus", inputPrice: 0.8, outputPrice: 2 },
  doubao: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "", inputPrice: null, outputPrice: null },
  compatible: { baseUrl: "", model: "", inputPrice: null, outputPrice: null }
};
function validateEndpoint(provider, value) {
  if (!Object.hasOwn(modelPresets, provider)) throw new Error("请选择有效的接口类型");
  if (provider !== "compatible") {
    if (value !== modelPresets[provider].baseUrl) throw new Error("请选择对应供应商的官方接口地址");
    return value;
  }
  let url;
  try {
    if (typeof value !== "string" || value.length > 2048) throw new Error();
    url = new URL(value.trim());
  } catch { throw new Error("请填写有效的 API 地址（Base URL）"); }
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))))
    throw new Error("API 地址需使用 HTTPS；本机 localhost 或 127.0.0.1 可使用 HTTP，地址不能含密钥或查询参数");
  if (/\/chat\/completions\/?$/.test(url.pathname))
    throw new Error("请填写 Base URL，不要包含末尾的 /chat/completions");
  return url.href.replace(/\/+$/, "");
}
const fileFor = dataDir => join(dataDir, "model-settings.json");
function readSettings(dataDir) {
  try {
    const file = fileFor(dataDir);
    if (lstatSync(file).isSymbolicLink()) throw new Error("模型配置文件不能是符号链接");
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
export function configuredModels(dataDir, baseEnv) {
  if (!baseEnv) loadContentEnv();
  const env = { ...(baseEnv || process.env) }, saved = readSettings(dataDir);
  if (saved) {
    const values = { PROVIDER: saved.provider, BASE_URL: saved.baseUrl, MODEL: saved.model,
      API_KEY: saved.apiKey, INPUT_CNY_PER_MILLION: saved.inputPrice,
      OUTPUT_CNY_PER_MILLION: saved.outputPrice, MAX_COST_CNY: saved.requestBudget };
    for (const prefix of ["CONTENT_VISION_", "CONTENT_QUESTION_"])
      for (const [key, value] of Object.entries(values)) env[prefix + key] = String(value);
    env.CONTENT_BUDGET_CNY = String(saved.contentBudget);
    env.CONTENT_VISION_MAX_INPUT_TOKENS = "16000";
    env.CONTENT_VISION_MAX_OUTPUT_TOKENS = "2000";
    env.CONTENT_QUESTION_MAX_INPUT_TOKENS = "12000";
    env.CONTENT_QUESTION_MAX_OUTPUT_TOKENS = "2000";
  }
  return { content: contentConfig(env), question: questionConfig(env) };
}
export function modelSettings(dataDir, baseEnv) {
  let saving = false;
  function status() {
    const { content, question } = configuredModels(dataDir, baseEnv);
    const saved = readSettings(dataDir);
    const provider = saved?.provider || question.provider;
    const preset = modelPresets[provider];
    return { provider, baseUrl: saved?.baseUrl || question.baseUrl,
      model: saved?.model || question.model || preset.model,
      inputPrice: saved?.inputPrice ?? question.inputCnyPerMillion ?? preset.inputPrice,
      outputPrice: saved?.outputPrice ?? question.outputCnyPerMillion ?? preset.outputPrice,
      contentBudget: saved?.contentBudget ?? content.budgetCny,
      credentialPresent: Boolean(question.apiKey),
      configured: Boolean(question.apiKey && question.model &&
        Number.isFinite(question.inputCnyPerMillion) && Number.isFinite(question.outputCnyPerMillion)),
      presets: modelPresets };
  }
  async function save(input) {
    if (saving) throw new Error("模型配置正在保存，请稍后重试");
    saving = true;
    let temporary;
    try {
      const keys = ["provider", "baseUrl", "model", "apiKey", "inputPrice", "outputPrice", "contentBudget"];
      if (!input || Object.keys(input).some(k => !keys.includes(k))) throw new Error("模型配置字段无效");
      const { provider, model } = input;
      const baseUrl = validateEndpoint(provider, input.baseUrl);
      if (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model))
        throw new Error("请填写有效模型名称或接入点 ID");
      const previous = configuredModels(dataDir, baseEnv).question;
      if (typeof input.apiKey !== "string") throw new Error("密钥格式无效");
      const apiKey = input.apiKey.trim() || (previous.provider === provider &&
        previous.baseUrl === baseUrl ? previous.apiKey : "");
      const validKey = provider === "compatible" ? /^[\x21-\x7E]{1,512}$/.test(apiKey) :
        /^[A-Za-z0-9_.-]{16,512}$/.test(apiKey);
      if (!validKey) throw new Error("请填写该供应商的 API Key");
      for (const key of ["inputPrice", "outputPrice", "contentBudget"])
        if (typeof input[key] !== "number" || !Number.isFinite(input[key]) ||
          input[key] <= 0 || input[key] > (key === "contentBudget" ? 10 : 10000))
          throw new Error("请填写大于零的模型单价和预算");
      const requestBudget = Math.ceil((16000 * input.inputPrice + 2000 * input.outputPrice) / 1e6 * 1e6) / 1e6;
      if (input.contentBudget < requestBudget * 2)
        throw new Error(`每条视频预算至少需 ${Math.ceil(requestBudget * 2 * 1000) / 1000} 元，才能覆盖内容理解和出题`);
      readSettings(dataDir); // Reject unsafe existing files before replacing them.
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      temporary = join(dataDir, `.model-settings-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ provider, baseUrl, model, apiKey,
          inputPrice: input.inputPrice, outputPrice: input.outputPrice,
          contentBudget: input.contentBudget, requestBudget }));
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, fileFor(dataDir));
      temporary = undefined;
      return status();
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      saving = false;
    }
  }
  return { status, save };
}
