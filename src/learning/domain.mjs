import { dailyQuestionRank, lowValueQuestionReason } from "./question-policy.mjs";

export const DAY = 86_400_000;
export const dayKey = value => new Date(new Date(value).getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
// SQL 等效：主题字典只匹配夹名正向部分；“非/不含/不包括/排除”后的词不参与。
// 与每日夹名规则采用同一否定边界；兼容未闭合括号及平台截短的历史名称。
export const categoryName = name => {
  const original = String(name ?? "").trim();
  const positive = original.normalize("NFKC").split(/(?:非|不含|不包括|排除)/u)[0].trim();
  if (/商务口语/.test(positive)) return "商务口语";
  if (/英语/.test(positive) && !/通识|知识\(/.test(positive)) return "英语学习";
  if (/宏观/.test(positive)) return "宏观经济";
  if (/商业|产品思维/.test(positive)) return "商业与产品";
  if (/ai\s*知识/i.test(positive)) return "AI 与工具";
  if (/通识|^(?:[a-d]\s*)?知识/i.test(positive)) return "通识与生活";
  if (/书籍|博客|电影/.test(positive)) return "书影音";
  if (/文字|感悟/.test(positive)) return "文字与感悟";
  if (/化妆/.test(positive)) return "化妆与护肤";
  if (/穿搭/.test(positive)) return "穿搭";
  if (/拍照/.test(positive)) return "摄影与修图";
  if (/购物/.test(positive)) return "购物灵感";
  if (/好吃好玩/.test(positive)) return "吃喝与旅行";
  if (/其他/.test(positive)) return "其他灵感";
  return original || "未分类";
};

export function learningStatus(progress, now = Date.now()) {
  if (!progress) return "new";
  return Date.parse(progress.dueAt) <= +new Date(now) ? "due" : "planned";
}

/** SQL: SELECT DISTINCT item_key FROM items WHERE platform=? AND category IN (...)
 * AND first_seen_day BETWEEN ? AND ?; filter BEFORE aggregating chart data. */
export function filterItems(items, filters = {}, progress = {}, now = Date.now()) {
  const q = (filters.q || "").trim().toLocaleLowerCase();
  return items.filter(item =>
    (!filters.platform || item.platform === filters.platform) &&
    (!filters.category || item.categories.includes(filters.category)) &&
    (!filters.type || item.type === filters.type) &&
    (!filters.status || learningStatus(progress[item.key], now) === filters.status) &&
    (!filters.from || dayKey(item.firstSeenAt) >= filters.from) &&
    (!filters.to || dayKey(item.firstSeenAt) <= filters.to) &&
    (!q || [item.title, item.author, item.description, ...item.categories].join(" ").toLocaleLowerCase().includes(q))
  );
}

/** SQL: GROUP BY first_seen_day; SUM(is_baseline), SUM(NOT is_baseline).
 * cumulative = COUNT(DISTINCT item_key WHERE first_seen_day <= day).
 * Baseline is excluded from "new"; observation time is NOT collection time. */
export function growthSeries(items, from, to) {
  const start = Date.parse(`${from}T00:00:00+08:00`);
  const end = Date.parse(`${to}T00:00:00+08:00`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || (end - start) / DAY > 3660) return [];
  const buckets = new Map();
  let total = items.filter(i => dayKey(i.firstSeenAt) < from).length;
  for (const item of items) {
    const day = dayKey(item.firstSeenAt);
    const b = buckets.get(day) ?? { baseline: 0, added: 0 };
    b[item.baseline ? "baseline" : "added"]++;
    buckets.set(day, b);
  }
  const result = [];
  for (let t = start; t <= end; t += DAY) {
    const date = dayKey(t);
    const b = buckets.get(date) ?? { baseline: 0, added: 0 };
    total += b.baseline + b.added;
    result.push({ date, ...b, total });
  }
  return result;
}

/** SQL: filter current folder membership BEFORE COUNT(DISTINCT item_key) by day.
 * Remove only leading days with cumulative=0; keep all later quiet days.
 * Dates describe first local import, not the platform's collection timestamp. */
export function collectionGrowthSeries(items, from, to, folderKey = "") {
  const selected = folderKey === "unclassified" ? items.filter(i => !(i.folderKeys ?? []).length) :
    folderKey ? items.filter(i => (i.folderKeys ?? []).includes(folderKey)) : items;
  const series = growthSeries(selected, from, to);
  const first = series.findIndex(day => day.total > 0);
  return first < 0 ? [] : series.slice(first);
}

/** SQL: current folders LEFT JOIN memberships GROUP BY folder_key,
 * COUNT(DISTINCT item_key). Multi-folder items count once in EACH folder.
 * A separate unclassified bucket contains items with no current folder. */
export function collectionFolderCounts(items, folders = []) {
  const current = new Set(folders.map(f => f.key));
  const counts = new Map(folders.map(f => [f.key, new Set()]));
  const unclassified = new Set();
  for (const item of items) {
    const keys = [...new Set(item.folderKeys ?? [])].filter(key => current.has(key));
    if (!keys.length) unclassified.add(item.key);
    for (const key of keys) counts.get(key).add(item.key);
  }
  const rows = folders.map(f => ({ key: f.key, name: f.name, count: counts.get(f.key).size }));
  if (unclassified.size) rows.push({ key: "unclassified", name: "未分类", count: unclassified.size });
  return rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
}

export function validateQuestion(question, source) {
  if (!question || typeof question.prompt !== "string" || question.prompt.trim().length < 5 ||
      question.prompt.length > 500 || !Array.isArray(question.options) || question.options.length !== 4 ||
      question.options.some(x => typeof x !== "string" || !x.trim() || x.length > 300) ||
      new Set(question.options.map(x => x.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " "))).size !== 4 ||
      !Number.isInteger(question.answer) || question.answer < 0 || question.answer > 3 ||
      typeof question.evidence !== "string" || question.evidence.trim().length < 8 ||
      question.evidence.length > 3000 || !source.includes(question.evidence.trim()) ||
      typeof question.explanation !== "string" || !question.explanation.trim() || question.explanation.length > 3000) {
    throw new Error("题目需含四个不同选项、正确答案、解析，以及正文中实际存在的原文摘录（至少 8 字）。");
  }
  return question;
}

export function todayQueue(items, progress, questions, now = Date.now()) {
  const ready = new Set(questions.map(q => q.itemKey));
  return items.filter(i => ready.has(i.key) && progress[i.key] && learningStatus(progress[i.key], now) === "due")
    .sort((a, b) => Date.parse(progress[a.key].dueAt) - Date.parse(progress[b.key].dueAt));
}

/** SQL equivalent:
 * WITH completed_today AS (SELECT DISTINCT item_key FROM events WHERE day(at)=:today),
 * due_items AS (SELECT item_key, MIN(due) FROM cards WHERE due<=:now GROUP BY item_key)
 * SELECT eligible due_items in seeded category-weighted order, while completed_today
 * plus selected due item keys stays <= :dailyVideos. Filter product-detail recall questions.
 * The limit is per distinct video, not per question. Completed videos keep their slot for the whole day. */
export function dailyLearningQueue(items, progress, questions, cards, events, dailyVideos, now = Date.now()) {
  const limit = Number.isInteger(dailyVideos) ? Math.max(1, dailyVideos) : 5;
  const today = dayKey(now);
  const completed = new Set(events.filter(e => dayKey(e.at) === today).map(e => e.itemKey));
  const dueByItem = new Map();
  for (const q of questions) {
    if (lowValueQuestionReason(q) || !progress[q.itemKey] || !cards[q.id] ||
      Date.parse(cards[q.id].card.due) > +new Date(now)) continue;
    const due = Date.parse(cards[q.id].card.due);
    if (!dueByItem.has(q.itemKey) || due < dueByItem.get(q.itemKey)) dueByItem.set(q.itemKey, due);
  }
  const ranks = new Map(items.map(item => [item.key, dailyQuestionRank({ id: item.key }, item, today)]));
  const due = items.filter(item => dueByItem.has(item.key))
    .sort((a, b) => ranks.get(a.key) - ranks.get(b.key) || a.key.localeCompare(b.key));
  const selected = new Set(completed);
  for (const item of due) {
    if (selected.has(item.key)) continue;
    if (selected.size >= limit) break;
    selected.add(item.key);
  }
  return due.filter(item => selected.has(item.key));
}

/** SQL equivalent: due questions in today's eligible videos ORDER BY seeded_rank(day,id).
 * Greedily take a different item_key from the preceding question when available.
 * Uses the existing published version's daily video limit; FSRS dates are unchanged. */
export function dailyQuizQueue(items, progress, questions, cards, events, dailyVideos, now = Date.now()) {
  const selected = dailyLearningQueue(items, progress, questions, cards, events, dailyVideos, now);
  const byKey = new Map(selected.map(item => [item.key, item]));
  const ranks = new Map(questions.filter(q => byKey.has(q.itemKey))
    .map(q => [q.id, dailyQuestionRank(q, byKey.get(q.itemKey), dayKey(now))]));
  const remaining = dueQuestions(selected, progress, questions, cards, now)
    .filter(q => !lowValueQuestionReason(q))
    .sort((a, b) => ranks.get(a.id) - ranks.get(b.id) || a.id.localeCompare(b.id));
  let previousKey = events.filter(e => dayKey(e.at) === dayKey(now)).at(-1)?.itemKey;
  const ordered = [];
  while (remaining.length) {
    let index = remaining.findIndex(q => q.itemKey !== previousKey);
    if (index < 0) index = 0;
    const [q] = remaining.splice(index, 1);
    ordered.push(q);
    previousKey = q.itemKey;
  }
  return ordered;
}

/** SQL: SELECT q.* FROM questions q JOIN cards c ON c.question_id=q.id
 * JOIN enrolled e ON e.item_key=q.item_key WHERE c.due<=:now ORDER BY c.due,q.id. */
export function dueQuestions(items, progress, questions, cards, now = Date.now()) {
  const keys = new Set(items.map(i => i.key));
  return questions.filter(q => keys.has(q.itemKey) && progress[q.itemKey] &&
    cards[q.id] && Date.parse(cards[q.id].card.due) <= +new Date(now))
    .sort((a, b) => Date.parse(cards[a.id].card.due) - Date.parse(cards[b.id].card.due) || a.id.localeCompare(b.id));
}
