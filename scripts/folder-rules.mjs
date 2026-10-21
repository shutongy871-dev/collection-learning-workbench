import { classifyByKeyword } from "../src/local-service/classify.mjs";
import { defaultFolders, defaultFolderName } from "./default-folders.mjs";

// 通用主题词库，不含用户收藏夹名称或ID；每日由实时名称选择主题并重新生成映射。
const topics = [
  { aliases: ["文字", "感悟", "句子", "随笔"], keywords: ["文字", "感悟", "手写", "见字如面", "随笔", "文案", "句子", "情感文字", "暖心文字"] },
  { aliases: ["宏观经济", "宏经", "经济形势"], keywords: ["宏观经济", "全球贸易", "贸易数据", "美元", "汇率", "国债", "美联储", "通胀", "通货膨胀", "gdp", "经济形势", "金融危机", "关税", "降息", "加息", "货币政策", "经济衰退"] },
  { aliases: ["英语", "词汇", "语法", "english"], keywords: ["英语", "英语词汇", "英语语法", "背单词", "单词", "四六级", "雅思", "托福", "自然拼读", "字母发音", "英语发音", "英语知识", "英语启蒙", "词汇", "english"] },
  { aliases: ["口语", "商务英语", "spoken english"], keywords: ["商务口语", "商务英语", "职场英语", "英语口语", "看电影学英语", "日常口语", "口语", "外教", "生活英语", "spoken english"] },
  { aliases: ["ai", "人工智能", "大模型"], keywords: ["ai", "人工智能", "大模型", "chatgpt", "gpt", "aigc", "llm", "prompt", "提示词", "智能体", "agent", "ai绘画", "sora", "claude", "gemini", "deepseek", "豆包", "机器学习", "深度学习", "ai工具", "ai教程"] },
  { aliases: ["知识", "科普", "常识"], keywords: ["冷知识", "科普", "知识科普", "常识", "学习方法", "自救", "保命知识", "女性安全", "心理学", "历史知识"] },
  { aliases: ["商业", "产品思维", "产品经理", "营销", "创业"], keywords: ["商业思维", "产品经理", "商业模式", "商业", "产品思维", "营销", "创业", "运营", "品牌", "管理思维", "商业分析", "职场"] },
  { aliases: ["美食", "好吃", "吃喝", "餐饮"], keywords: ["美食", "探店", "好吃", "餐厅", "零食", "小吃", "餐饮"] },
  { aliases: ["旅游", "旅行", "游玩", "好玩"], keywords: ["旅游", "旅行", "旅游攻略", "旅行攻略", "游玩", "景点", "民宿", "酒店攻略"] },
  { aliases: ["拍照", "摄影", "修图"], keywords: ["拍照", "摄影", "构图", "相机", "修图", "拍照技巧", "人像", "胶片", "照片", "手机摄影"] },
  { aliases: ["穿搭", "穿衣", "服饰"], keywords: ["穿搭", "ootd", "穿衣", "服饰", "外套", "皮衣", "显瘦", "穿搭技巧", "上衣"] },
  { aliases: ["化妆", "美妆", "彩妆", "护肤"], keywords: ["化妆", "彩妆", "妆容", "护肤", "美妆", "口红", "粉底", "眼影", "卸妆", "化妆品"] },
  { aliases: ["购物", "购物车", "好物", "种草"], keywords: ["好物", "购物", "平价", "种草", "开箱", "同款", "省钱", "性价比", "购物车", "好物分享", "平价好物"] },
  { aliases: ["书籍", "书单", "博客", "电影", "片单"], keywords: ["书单", "片单", "书籍推荐", "电影推荐", "博客推荐", "书评", "影评"] },
  { aliases: ["健身", "运动", "减脂"], keywords: ["健身", "运动", "减脂", "力量训练", "有氧", "跑步", "增肌"] },
  { aliases: ["烘焙", "烘培"], keywords: ["烘焙", "烘培", "蛋糕", "面包", "饼干", "曲奇", "吐司"] }
];
const normalize = name => name.normalize("NFKC").toLowerCase().trim()
  .replace(/^[a-d](?=[\s\u3400-\u9fff])\s*/u, "")
  .replace(/^\d+[.、_\-\s]+/u, "").trim();
const unique = values => [...new Set(values)];
const generic = /^(?:其他|其它|默认|收藏(?:夹)?\d*|未分类|待整理|待分类|喜欢|杂项|合集|推荐|学习|知识|日常|备用|新建收藏夹\d*)$/u;
const terms = text => text.split(/[\s、,，/&+()（）:：;；|]+/u).map(t => t.trim()).filter(Boolean);
const hit = (text, keywords) => classifyByKeyword({ title: text }, [{ keywords }]).decision === "folder";

/**
 * SQL等效：current_folders LEFT JOIN topic_dictionary ON name_alias_match
 * 每次只根据当前名称重建，不沿用昨天的名称/主题。名称中的“非/不含/排除”生成否定条件。
 * 无词库的明确名称只做字面匹配；“其他/收藏夹1”等含义不明名称不兜底接收。
 */
export function generateFolderRules(folders) {
  const ids = new Set();
  for (const folder of folders) {
    if (typeof folder.id !== "string" || !folder.id || typeof folder.name !== "string" || ids.has(folder.id)) {
      throw new Error("invalid_folder_rule_source");
    }
    ids.add(folder.id);
  }
  return folders.map(folder => {
    const normalized = normalize(folder.name);
    const [positive, ...negative] = normalized.split(/(?:非|不含|不包括|排除)/u);
    const found = topics.filter(t => hit(positive, t.aliases));
    // “AI知识/商业知识”中的“知识”是修饰词，不能引入整个通识词库。
    const included = found.filter(t => found.length === 1 || !t.aliases.includes("知识"));
    const excluded = topics.filter(t => negative.some(n => hit(n, t.aliases)));
    const literals = terms(positive).filter(t => t.length >= 2 && !generic.test(t) && !/^\d+$/u.test(t));
    const excludeKeywords = unique([...negative.flatMap(terms), ...excluded.flatMap(t => t.keywords)]);
    const keywords = unique([...included.flatMap(t => t.keywords), ...literals])
      .filter(k => !excludeKeywords.includes(k));
    const duplicate = folders.filter(f => normalize(f.name) === normalized).length > 1;
    const disabledReason = duplicate ? "ambiguous_folder_name" : !keywords.length ? "unclear_folder_name" : null;
    return { folderId: folder.id, folderName: folder.name, keywords, excludeKeywords, authors: [],
      enabled: !disabledReason, disabledReason, source: "current_folder_name",
      method: included.length ? "name_and_topic_dictionary" : "literal_name",
      positiveName: positive.trim(), excludedNameParts: negative.map(n => n.trim()) };
  });
}

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const stopWords = new Set(["视频", "抖音", "推荐", "热门", "分享", "教程", "今天", "真的", "一个",
  "这个", "我们", "你们", "可以", "就是", "自己", "大家", "喜欢", "收藏", "关注", "点赞", "作品", "知识"]);
function contentTerms(item) {
  const text = [item.title ?? "", ...(item.hashtags ?? [])].join(" ").normalize("NFKC").toLowerCase();
  const segments = [...segmenter.segment(text)];
  const tokens = segments.filter(t => t.isWordLike).map(t => t.segment);
  // ICU可能把“攀岩”等领域词拆为单字；仅保留完整的2–4单字串，
  // 不截取“见字如面”中的“字如”等片段，也不跨标点或空格。
  for (let i = 0; i < segments.length; i++) {
    let phrase = "";
    while (i < segments.length && /^[\u3400-\u9fff]$/u.test(segments[i].segment)) {
      phrase += segments[i].segment;
      i++;
    }
    if (phrase.length >= 2 && phrase.length <= 4) tokens.push(phrase);
  }
  // 标签保留完整短语；同一视频重复出现一个词只算一个样本。
  return new Set([...tokens, ...(item.hashtags ?? []).map(t => t.normalize("NFKC").toLowerCase().trim())]
    .filter(t => t.length >= 2 && t.length <= 24 && !stopWords.has(t) && !/^\d+$/u.test(t)));
}

/**
 * SQL口径：COUNT(DISTINCT video_id) GROUP BY folder_id, token。
 * 至少3个不同视频支持；该词>=80%的支持视频在目标夹，且目标夹出现率>=其他夹最高出现率的2倍。
 * 同视频同时位于多个夹不作为训练样本，作者名不参与；每夹最多保留50个区分词。
 */
export function learnFolderRules(folders, { useDefaults = false } = {}) {
  const rules = generateFolderRules(folders);
  const membership = new Map();
  for (const f of folders) for (const item of f.items ?? []) {
    if (!membership.has(item.id)) membership.set(item.id, new Set());
    membership.get(item.id).add(f.id);
  }
  const counts = folders.map(f => {
    const items = [...new Map((f.items ?? []).map(i => [i.id, i])).values()]
      .filter(i => membership.get(i.id)?.size === 1);
    const tokens = new Map();
    for (const item of items) for (const term of contentTerms(item)) tokens.set(term, (tokens.get(term) ?? 0) + 1);
    return { items: items.length, tokens };
  });
  return rules.map((rule, index) => {
    const template = useDefaults ? defaultFolders.find(t => t.name === rule.folderName || defaultFolderName(t) === rule.folderName) : null;
    const templateRule = template ? generateFolderRules([{ id: rule.folderId, name: template.name }])[0] : null;
    const excluded = unique([...(rule.excludeKeywords ?? []), ...(template?.excludeKeywords ?? []),
      ...(templateRule?.excludeKeywords ?? [])]);
    const learned = [...counts[index].tokens].flatMap(([keyword, support]) => {
      const other = counts.filter((_, i) => i !== index);
      const outside = other.reduce((sum, c) => sum + (c.tokens.get(keyword) ?? 0), 0);
      const precision = support / (support + outside);
      const frequency = support / Math.max(counts[index].items, 1);
      const outsideFrequency = Math.max(0, ...other.map(c => (c.tokens.get(keyword) ?? 0) / Math.max(c.items, 1)));
      const excludedHit = classifyByKeyword({ title: keyword }, [{ keywords: excluded }]).decision === "folder";
      return support >= 3 && precision >= .8 && frequency >= 2 * outsideFrequency && !excludedHit
        ? [{ keyword, support, outsideSupport: outside, precision, frequency }] : [];
    }).sort((a, b) => b.precision - a.precision || b.support - a.support || a.keyword.localeCompare(b.keyword)).slice(0, 50);
    const keywords = unique([...rule.keywords, ...(templateRule?.keywords ?? []),
      ...(template?.keywords ?? []), ...learned.map(k => k.keyword)]);
    const duplicate = rule.disabledReason === "ambiguous_folder_name";
    const enabled = !duplicate && keywords.length > 0;
    return { ...rule, keywords, excludeKeywords: excluded, enabled,
      disabledReason: duplicate ? rule.disabledReason : enabled ? null : rule.disabledReason,
      source: "current_folder_name_and_members", method: "name_with_member_statistics",
      defaultTemplateApplied: Boolean(template), trainingVideos: counts[index].items, learnedKeywords: learned };
  });
}

export function matchesFolderRule(item, rule) {
  if (rule.enabled === false) return false;
  if (rule.excludeKeywords?.length && classifyByKeyword(item, [{ keywords: rule.excludeKeywords }]).decision === "folder") {
    return false;
  }
  return classifyByKeyword(item, [rule]).decision === "folder";
}

export function diffFolderRules(previous, current) {
  const matched = new Set();
  const changes = [];
  for (const rule of current) {
    const before = previous.find(p => p.folderId === rule.folderId) ??
      previous.find(p => !p.folderId && p.folderName === rule.folderName);
    if (before) matched.add(before);
    const type = !before ? "added" : before.folderName !== rule.folderName ? "renamed" :
      JSON.stringify(before) !== JSON.stringify(rule) ? "updated" : null;
    if (type) changes.push({ type, folderId: rule.folderId, folderName: rule.folderName,
      ...(before ? { previousName: before.folderName } : {}) });
  }
  for (const old of previous) {
    if (!matched.has(old)) changes.push({ type: "removed", folderId: old.folderId, folderName: old.folderName });
  }
  return changes;
}
