/**
 * classify.mjs —— L1 关键词规则分类器（纯函数 Selector，无副作用，可单测）
 *
 * 【口径文档 · SQL 等效表达】
 *   -- 对单条收藏 item，在全部文件夹关键词规则中取命中得分最高者
 *   WITH hit AS (
 *     SELECT rule.folder_id,
 *            MAX(CASE WHEN lower(item.author) = lower(rule.author) THEN 1000
 *                     ELSE rule.weight END) AS score
 *     FROM folder_keyword_rule rule
 *     WHERE lower(item.author) = lower(rule.author)                         -- 作者精确匹配
 *        OR lower(item.title || item.desc || item.hashtags)
 *           LIKE '%' || lower(rule.keyword) || '%'                          -- 文案包含匹配
 *     GROUP BY rule.folder_id
 *   )
 *   SELECT folder_id FROM hit ORDER BY score DESC LIMIT 1;
 *
 * 置信度口径：作者命中给 0.95；关键词命中按规则 weight 映射，封顶 0.9。
 * 未命中返回 decision=unknown，由上层进入 L2 多模态大模型。
 */

const normalize = (s) => (s ?? "").toString().toLowerCase().trim();

/**
 * 关键词命中口径：
 *  - 含非 ASCII（中文等）：子串包含，如 "宏观经济" 命中 "宏观经济形势"
 *  - 纯 ASCII：要求词边界，避免 "ai" 命中拼音/单词（如 "白菜"、"said"、"chatgpt" 中的片段）
 */
function keywordHit(keyword, haystack) {
  const k = normalize(keyword);
  if (!k) return false;
  if (/[^\x00-\x7f]/.test(k)) return haystack.includes(k);
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack);
}

export function classifyByKeyword(item, rules) {
  const textHaystack = normalize([
    item.title,
    item.desc,
    ...(Array.isArray(item.hashtags) ? item.hashtags : [])
  ].join(" "));
  const authorHaystack = normalize(item.author);

  let best = null;
  for (const rule of rules ?? []) {
    const hitAuthor = (rule.authors ?? []).some((a) => a && authorHaystack === normalize(a));
    const hitKeyword = !hitAuthor && (rule.keywords ?? []).some((k) => keywordHit(k, textHaystack));
    if (!hitAuthor && !hitKeyword) continue;

    const score = hitAuthor ? 1000 : (rule.weight ?? 100);
    if (!best || score > best.score) {
      best = {
        folderId: rule.folderId,
        folderName: rule.folderName,
        score,
        matchedBy: hitAuthor ? "author" : "keyword"
      };
    }
  }

  if (!best) return { decision: "unknown", reason: "no_keyword_hit" };

  const confidence = best.matchedBy === "author" ? 0.95 : Math.min(0.5 + best.score / 250, 0.9);
  return { decision: "folder", ...best, confidence };
}
