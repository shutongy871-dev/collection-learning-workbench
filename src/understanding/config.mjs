import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));
export function loadContentEnv() {
  if (!existsSync(`${root}.env.content`)) return;
  if (typeof process.loadEnvFile !== "function") throw new Error("content_env_requires_node_20_12_or_newer");
  process.loadEnvFile(`${root}.env.content`);
}
function binary(env, name, pkg) {
  if (env[name]) return env[name];
  try { return require(pkg).path; } catch { return name.toLowerCase(); }
}
function number(env, key, fallback, min = 0, max = Infinity) {
  const n = env[key] === undefined || env[key] === "" ? fallback : Number(env[key]);
  if (n !== null && (!Number.isFinite(n) || n < min || n > max)) throw new Error(`invalid_config:${key}`);
  return n;
}
export function providerPython(provider) {
  const local = `${root}${provider === "funasr" ? ".venv-funasr" : ".venv-content"}/bin/python`;
  return existsSync(local) ? local : "python3";
}
export function contentConfig(env = process.env) {
  const asrProvider = env.CONTENT_ASR_PROVIDER || "whisper";
  const visionProvider = env.CONTENT_VISION_PROVIDER || "qwen";
  if (!["whisper", "funasr"].includes(asrProvider) || !["qwen", "doubao"].includes(visionProvider))
    throw new Error("invalid_provider");
  for (const key of ["CONTENT_MAX_FRAMES", "CONTENT_VISION_MAX_INPUT_TOKENS", "CONTENT_VISION_MAX_OUTPUT_TOKENS"])
    if (env[key] && !Number.isInteger(Number(env[key]))) throw new Error(`invalid_config:${key}`);
  return {
    ffmpeg: binary(env, "FFMPEG", "@ffmpeg-installer/ffmpeg"),
    ffprobe: binary(env, "FFPROBE", "@ffprobe-installer/ffprobe"),
    python: env.CONTENT_PYTHON || providerPython(asrProvider),
    asrProvider, asrModel: env.CONTENT_ASR_MODEL || (asrProvider === "whisper" ? "base" : "paraformer-zh"),
    language: env.CONTENT_LANGUAGE || "zh", modelDir: env.CONTENT_MODEL_DIR || `${root}.data/content-models`,
    asrRateCnyPerMinute: number(env, "CONTENT_ASR_CNY_PER_MINUTE", null),
    budgetCny: number(env, "CONTENT_BUDGET_CNY", .05, 0, 10),
    maxDurationMs: number(env, "CONTENT_MAX_DURATION_SECONDS", 900, 1, 7200) * 1000,
    maxMediaBytes: 300 * 1024 * 1024,
    maxFrames: number(env, "CONTENT_MAX_FRAMES", 6, 1, 12),
    frameIntervalMs: number(env, "CONTENT_FRAME_INTERVAL_SECONDS", 15, 1, 300) * 1000,
    visionProvider,
    visionBaseUrl: env.CONTENT_VISION_BASE_URL || (visionProvider === "qwen" ?
      "https://dashscope.aliyuncs.com/compatible-mode/v1" : "https://ark.cn-beijing.volces.com/api/v3"),
    visionModel: env.CONTENT_VISION_MODEL || "",
    // 百炼官方变量仅用于 Qwen，不能把它误发给其他提供方。
    visionApiKey: (env.CONTENT_VISION_API_KEY || (visionProvider === "qwen" ? env.DASHSCOPE_API_KEY : "") || "").trim(),
    // 用调用上限做预留；单价用于收到 usage 后计价。未知价格不能启动付费调用。
    visionMaxCostCny: number(env, "CONTENT_VISION_MAX_COST_CNY", null),
    visionInputCnyPerMillion: number(env, "CONTENT_VISION_INPUT_CNY_PER_MILLION", null),
    visionOutputCnyPerMillion: number(env, "CONTENT_VISION_OUTPUT_CNY_PER_MILLION", null),
    visionMaxInputTokens: number(env, "CONTENT_VISION_MAX_INPUT_TOKENS", 16000, 1000, 128000),
    visionMaxOutputTokens: number(env, "CONTENT_VISION_MAX_OUTPUT_TOKENS", 1500, 128, 8000)
  };
}

export function processingSignature(config) {
  const { asrProvider, asrModel, language, maxFrames, frameIntervalMs, visionProvider, visionModel,
    visionBaseUrl, visionMaxOutputTokens } = config;
  return { asrProvider, asrModel, language, maxFrames, frameIntervalMs, visionProvider, visionModel,
    visionBaseUrl, visionMaxOutputTokens };
}

export function questionConfig(env = process.env) {
  const content = contentConfig(env);
  const provider = env.CONTENT_QUESTION_PROVIDER || content.visionProvider;
  if (!["qwen", "doubao"].includes(provider)) throw new Error("invalid_question_provider");
  const baseUrl = env.CONTENT_QUESTION_BASE_URL || (provider === content.visionProvider ? content.visionBaseUrl :
    provider === "qwen" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : "https://ark.cn-beijing.volces.com/api/v3");
  const sharesVisionEndpoint = provider === content.visionProvider && baseUrl === content.visionBaseUrl;
  const apiKey = (env.CONTENT_QUESTION_API_KEY || (sharesVisionEndpoint ? content.visionApiKey : "") || "").trim();
  for (const key of ["CONTENT_QUESTION_MAX_INPUT_TOKENS", "CONTENT_QUESTION_MAX_OUTPUT_TOKENS"])
    if (env[key] && !Number.isInteger(Number(env[key]))) throw new Error(`invalid_config:${key}`);
  return { provider, baseUrl, apiKey, model: env.CONTENT_QUESTION_MODEL || (sharesVisionEndpoint ? content.visionModel : ""),
    budgetCny: content.budgetCny,
    maxCostCny: number(env, "CONTENT_QUESTION_MAX_COST_CNY", sharesVisionEndpoint ? content.visionMaxCostCny : null),
    inputCnyPerMillion: number(env, "CONTENT_QUESTION_INPUT_CNY_PER_MILLION",
      sharesVisionEndpoint ? content.visionInputCnyPerMillion : null),
    outputCnyPerMillion: number(env, "CONTENT_QUESTION_OUTPUT_CNY_PER_MILLION",
      sharesVisionEndpoint ? content.visionOutputCnyPerMillion : null),
    maxInputTokens: number(env, "CONTENT_QUESTION_MAX_INPUT_TOKENS", 12000, 2000, 64000),
    maxOutputTokens: number(env, "CONTENT_QUESTION_MAX_OUTPUT_TOKENS", 2000, 256, 8000) };
}
