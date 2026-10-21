export const ROUTE_VERSION = "density-v1";
export const routeLabels = { speech: "口播 / 讲解", visual: "视觉 / 技能", mixed: "语音 + 画面", entertainment: "娱乐 / 灵感", undecided: "待判断" };

const patterns = {
  speech: /讲解|讲清楚|解读|科普|口播|访谈|播客|原理|思维模型|经济|商业|语法|单词|口语|英语|知识|为什么|是什么|区别|逻辑/giu,
  visual: /化妆|仿妆|妆容|眼妆|修容|穿搭|搭配示范|构图|拍照|摄影|修图|剪辑|绘画|画画|手工|折纸|做菜|菜谱|烹饪|操作演示|屏幕演示|代码演示|舞蹈教学|动作教学|健身动作/giu,
  entertainment: /搞笑|段子|整活|萌宠|可爱猫咪|可爱狗狗|风景欣赏|纯音乐|音乐欣赏|颜值欣赏|搞笑合集|娱乐日常/giu,
  learning: /教程|教学|讲解|科普|原理|步骤|技巧|知识|学习|示范|解析/giu
};

/** 可审计的语音密度代理，不等同于“知识价值”。
 * SQL: coverage = union_duration(asr_segments) / duration_ms;
 * units_per_second = (CJK_chars + non_CJK_words) / (duration_ms / 1000).
 * 重叠时间取并集，避免多个 segment 重复累计。 */
export function speechDensity(segments, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Array.isArray(segments)) return null;
  const ranges = segments.filter(s => typeof s.text === "string" && s.text.trim() &&
    Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.startMs >= 0 &&
    s.endMs > s.startMs && s.endMs <= durationMs).sort((a, b) => a.startMs - b.startMs);
  let speechMs = 0, end = 0;
  for (const s of ranges) { speechMs += Math.max(0, s.endMs - Math.max(end, s.startMs)); end = Math.max(end, s.endMs); }
  const text = ranges.map(s => s.text).join(" ");
  const units = (text.match(/[\u3400-\u9fff]/gu) ?? []).length +
    (text.replace(/[\u3400-\u9fff]/gu, " ").match(/[\p{L}\p{N}]+/gu) ?? []).length;
  return { speechMs, durationMs, coverage: speechMs / durationMs, unitsPerSecond: units / (durationMs / 1000), units };
}

/** SQL 等效：CASE WHEN override ... WHEN visual AND speech THEN mixed ...
 * 信号只来自当前视频文案/话题/实际ASR；收藏夹和评论不参与类型判定。 */
export function routeContent(item, { segments, durationMs, override } = {}) {
  const text = [item.title, item.description, ...(item.hashtags ?? [])].filter(Boolean).join(" ").normalize("NFKC");
  const signals = Object.fromEntries(Object.entries(patterns).map(([k, re]) => [k, [...new Set(text.match(re) ?? [])]]));
  const density = speechDensity(segments, durationMs);
  const denseSpeech = Boolean(density && density.coverage >= .55 && density.unitsPerSecond >= 1.2);
  const reasons = [];
  let route = "undecided", confidence = "low";
  if (override) {
    if (!Object.hasOwn(routeLabels, override.route) || override.route === "undecided" ||
        typeof override.reason !== "string" || !override.reason.trim() || override.reason.length > 500)
      throw new Error("invalid_route_override");
    route = override.route; confidence = "manual"; reasons.push(`人工指定：${override.reason.trim()}`);
  } else if (signals.entertainment.length && !signals.learning.length && !signals.speech.length && !signals.visual.length && !denseSpeech) {
    route = "entertainment"; confidence = "medium"; reasons.push("文案明确指向娱乐，未发现教学或技能信号");
  } else if (signals.visual.length) {
    route = denseSpeech || signals.speech.length ? "mixed" : "visual";
    confidence = density ? "high" : "medium";
    reasons.push(`画面依赖线索：${signals.visual.join("、")}`);
    if (route === "mixed") reasons.push(denseSpeech ? "实际转写显示较高语音密度" : `讲解线索：${signals.speech.join("、")}`);
  } else if (denseSpeech || signals.speech.length || signals.learning.length) {
    // 娱乐与教学共现时，仅元信息不能判定，先保留待判断。
    if (signals.entertainment.length && !denseSpeech) {
      reasons.push("娱乐与教学信号冲突，需要媒体证据或人工指定");
    } else {
      route = "speech"; confidence = denseSpeech ? "high" : "medium";
      reasons.push(denseSpeech ? "实际转写显示较高语音密度" : `讲解线索：${[...signals.speech, ...signals.learning].join("、")}`);
    }
  } else reasons.push("元信息不足；低语音密度或静音本身不能证明是娱乐内容");
  return { version: ROUTE_VERSION, route, confidence, reasons, signals, density,
    provisional: confidence === "medium" || confidence === "low",
    stages: { speech: ["asr"], visual: ["frames", "vision"], mixed: ["asr", "frames", "vision"],
      entertainment: ["metadata", "comments"], undecided: [] }[route],
    generateQuestions: false };
}
