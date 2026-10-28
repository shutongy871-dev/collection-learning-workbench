// Shared by generation and the daily selector, including already saved questions.
export function lowValueQuestionReason(question) {
  const prompt = String(question.prompt ?? "").normalize("NFKC");
  const product = /包包|包款|包袋|这款包|相机包|这(?:款|件|双|个)(?:商品|产品|衣服|外套|鞋|裙|上衣)/u;
  const recall = /优点|卖点|评价|特点|触感|收纳能力|搭配效果|描述|概括|颜色|价格|品牌/u;
  const application = /如何选择|怎么选|如何搭配|怎么搭配|判断|取舍|适用条件|在什么情况下|为什么|原理/u;
  return product.test(prompt) && recall.test(prompt) && !application.test(prompt)
    ? "product_detail_recall" : null;
}

export function learningWeight(item) {
  const categories = (item.categories ?? []).map(String);
  if (categories.some(category => /穿搭|穿衣|服饰/u.test(category))) return .25;
  if (categories.some(category => /购物/u.test(category))) return .35;
  return 1;
}

// Seeded exponential race: lower weight means fewer slots across daily queues.
// Keep the seed stable for the whole Beijing day, including reloads and restarts.
export function dailyQuestionRank(question, item, day) {
  let hash = 2166136261;
  for (const c of `${day}:${question.id}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  const uniform = ((hash >>> 0) + 1) / 4294967297;
  return -Math.log(uniform) / learningWeight(item);
}
