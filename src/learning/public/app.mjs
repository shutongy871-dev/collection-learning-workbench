import { dayKey, growthSeries, learningStatus, dueQuestions, DAY } from "/domain.mjs";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const number = n => Number(n).toLocaleString("zh-CN");
const sourceName = p => ({ douyin: "抖音" })[p] ?? "未知来源";
const dateText = value => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const labels = { today: "今日学习" };
let state, range = 30, chartMode = "total";
let detailKey = null, quizItem = null, quizQuestion = null, choice = null, attemptId = null, feedback = null, quizFinished = false;
let detailDirty = false, busy = false, toastTimer;
const dirtyForms = new Set();
const view = () => labels[location.hash.slice(1)] ? location.hash.slice(1) : "today";
const byKey = key => state.items.find(i => i.key === key);
const itemQuestions = key => state.questions.filter(q => q.itemKey === key);
const todayItems = () => (state.today?.itemKeys ?? []).map(byKey).filter(Boolean);

async function api(path, data) {
  const res = await fetch(`/api/${path}`, data === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
  });
  const result = await res.json();
  if (!res.ok) throw new Error(questionErrors[result.error] || result.error || "保存失败，请重试");
  return result;
}
function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 4200);
}
async function reload() { state = await api("state"); render(); }
function platformBadge(item) {
  return `<span class="platform ${item.platform}"><b>♪</b>${sourceName(item.platform)} · ${item.type === "image" ? "图文" : "视频"}</span>`;
}
const empty = (title, desc, action = "") => `<div class="empty"><div class="empty-symbol">✧</div><h3>${title}</h3><p>${desc}</p>${action}</div>`;
function stats(items = state.items) {
  const keys = new Set(items.map(i => i.key)), events = state.events.filter(e => keys.has(e.itemKey));
  const today = events.filter(e => dayKey(e.at) === dayKey(Date.now())).length;
  const learned = new Set(events.map(e => e.itemKey)).size;
  const due = Math.max(0, state.learningConfig.dailyVideos - (state.today?.completedVideos ?? 0));
  return `<section class="stats" aria-label="学习概览">${[
    ["入库收藏",items.length,"条","▧"],
    ["今日待学习",due,"条","◷"],
    ["累计学过",learned,"条","✧"],
    ["今日已复习",today,"次","✓"]
  ].map(([label,value,unit,icon])=>`<div class="stat"><div class="stat-top"><span>${label}</span><span aria-hidden="true">${icon}</span></div><div class="stat-value">${number(value)}<small>${unit}</small></div></div>`).join("")}</section>`;
}
function chart(items, compact = false) {
  const to = dayKey(Date.now());
  const first = items.reduce((min, i) => dayKey(i.firstSeenAt) < min ? dayKey(i.firstSeenAt) : min, to);
  const from = range === 0 ? first : dayKey(Date.parse(`${to}T12:00:00+08:00`) - (range - 1) * DAY);
  const series = growthSeries(items, from, to);
  if (!series.length) return empty("这个时间范围没有数据", "请调整起止日期后再查看。");
  const mode = compact ? "total" : chartMode;
  const values = series.map(s => mode === "total" ? s.total : s.added + s.baseline);
  const max = Math.max(...values, 1);
  const mainWidth = $("#main").clientWidth - (innerWidth <= 620 ? 36 : innerWidth <= 1150 ? 50 : 84);
  const plotWidth = compact && innerWidth > 900 ? (mainWidth - 20) * .62 - 44 : mainWidth - 44;
  const width = Math.max(260, Math.min(650, plotWidth)), height = compact ? 185 : 230, left = 47, right = 12, top = 15, bottom = 32;
  const pw = width - left - right, ph = height - top - bottom;
  const x = idx => left + (series.length === 1 ? pw / 2 : idx * pw / (series.length - 1));
  const y = n => top + ph - n / max * ph;
  const points = series.map((_, i) => `${x(i)},${y(values[i])}`).join(" ");
  const tickIds = [...new Set([0, Math.floor((series.length - 1) / 3), Math.floor((series.length - 1) * 2 / 3), series.length - 1])];
  const markWidth = Math.max(1, Math.min(16, pw / series.length * .65));
  const lines = [0,.5,1].map(r=>`<line class="grid" x1="${left}" y1="${y(max*r)}" x2="${width-right}" y2="${y(max*r)}"/><text x="${left-9}" y="${y(max*r)+4}" text-anchor="end">${number(Math.round(max*r))}</text>`).join("");
  const ticks = tickIds.map(i=>`<text x="${x(i)}" y="${height-6}" text-anchor="${i===0?"start":i===series.length-1?"end":"middle"}">${series[i].date.slice(5).replace("-","/")}</text>`).join("");
  const path = mode === "total" ? `<polygon class="area" points="${left},${top+ph} ${points} ${x(series.length-1)},${top+ph}"/><polyline class="line" points="${points}"/>` : "";
  const marks = series.map((s,i)=>{
    const label = `${s.date}，累计入库 ${s.total} 条，历史导入 ${s.baseline} 条，首次发现新增 ${s.added} 条`;
    return `<g aria-label="${esc(label)}"><title>${label}</title>${mode==="total"?
      `<circle class="dot" cx="${x(i)}" cy="${y(s.total)}" r="${series.length>90?2:3}"/>`:
      `<rect class="baseline" x="${x(i)-markWidth/2}" y="${y(s.baseline)}" width="${markWidth}" height="${ph*s.baseline/max}" rx="2"/><rect class="bar" x="${x(i)-markWidth/2}" y="${y(s.baseline+s.added)}" width="${markWidth}" height="${Math.max(2,ph*s.added/max)}" rx="2"/>`}</g>`;
  }).join("");
  const latest = series.at(-1);
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="${mode==="total"?"累计入库趋势":"历史导入与首次发现新增趋势"}">${lines}${path}${marks}${ticks}</svg>
    <div class="chart-legend"><span><i></i>${mode==="total"?"累计入库":"首次发现新增"}</span>${mode==="added"?'<span><i class="base"></i>历史导入</span>':""}<span>按北京时间统计</span></div>
    <div class="chart-readout" aria-live="polite">累计入库 ${number(latest.total)} 条 · 今日新入库 ${number(latest.added)} 条</div>`;
}
function heroArt() {
  return `<div class="hero-art" aria-hidden="true"><svg viewBox="0 0 200 180" fill="none"><ellipse cx="105" cy="93" rx="80" ry="61" stroke="#c9bdd7" stroke-dasharray="4 5"/><path d="M52 60l47-10 49 14v76l-48-13-48 11V60Z" fill="#faf8fd" stroke="#b8a5cb" stroke-width="1.5"/><path d="M99 50v77M64 77l23-5m-23 17 23-5m-23 17 23-5m26-20 24 6m-24 6 24 6m-24 6 17 4" stroke="#c7b9d6" stroke-width="2"/><circle cx="157" cy="45" r="19" fill="#dfe8be"/><path d="m150 45 5 5 9-10" stroke="#8c9b65" stroke-width="2"/><path d="m38 124 4 10 11 4-11 4-4 11-4-11-11-4 11-4Z" fill="#b7a2cf"/><circle cx="60" cy="29" r="4" fill="#c4b3d5"/><circle cx="170" cy="130" r="4" fill="#c4b3d5"/></svg></div>`;
}
function todayPage() {
  const items = state.items;
  const limit = state.learningConfig.dailyVideos;
  return `<div class="page-head"><h1>让收藏，成为你的收获。</h1></div>
    <section class="hero"><div class="hero-copy">
    <div class="hero-actions"><button class="primary" data-action="start-today">开始学习 <span>↗</span></button>
    <form id="learning-form" class="daily-goal"><label>每天学习 <input aria-label="每天学习视频数" name="dailyVideos" type="number" min="1" max="50" value="${limit}" required> 条视频</label><button class="secondary" type="submit">保存</button></form></div></div>${heroArt()}</section>
    ${stats(items)}
    <div class="split"><section class="panel"><div class="panel-title"><h2>你的收藏，正在生长</h2></div>${chart(items,true)}</section>
    <section class="panel"><div class="panel-title"><h2>把喜欢，变成自己的</h2><small>学习足迹</small></div>${learningFootprint(items)}</section></div>`;
}
function learningFootprint(items) {
  const total = items.length;
  const learned = new Set(state.events.map(e=>e.itemKey));
  return [["已生成题目",items.filter(i=>state.progress[i.key]).length],["完成学习",items.filter(i=>learned.has(i.key)).length]].map(([l,n])=>
    `<div class="progress-row"><span>${l}</span><div class="bar-track"><i style="width:${total?n/total*100:0}%"></i></div><strong>${number(n)}</strong></div>`).join("");
}
function render() {
  if (!state) return;
  const active = view();
  $("title").textContent = `${labels[active]} · 拾光`;
  $("#today-date").textContent = new Date().toLocaleDateString("zh-CN",{timeZone:"Asia/Shanghai",month:"long",day:"numeric",weekday:"long"});
  $("#main").innerHTML = todayPage();
  if(active === "today") void loadBatch();
}
const contentRoutes = { speech: "口播 / 讲解", visual: "视觉 / 技能", mixed: "语音 + 画面", entertainment: "娱乐 / 灵感", undecided: "待判断" };
const contentStatuses = { completed: "处理完成", needs_review: "需要核对", needs_media: "等待视频文件",
  needs_configuration: "等待处理服务配置", budget_exceeded: "已达到处理预算", needs_reconciliation: "等待核对调用结果",
  blocked: "处理暂停", running: "正在处理", partial: "部分完成", skipped: "已跳过", interrupted: "中断，等待手动恢复" };
const contentErrors = { media_required: "还没有取得这条视频的媒体文件。", vision_not_configured: "视觉模型尚未配置。",
  visible_browser_in_use: "抖音登录程序还未退出，同步未开始。请在右上角「我」点击「检查登录」，然后再次同步。",
  browser_busy: "另一项收藏任务正在运行，请稍后恢复。",
  browser_background_unverified: "无法确认浏览器能静默运行，已暂停，请检查运行日志。",
  browser_audio_not_muted: "旧浏览器尚未启用静音，退出专用浏览器后再恢复任务。",
  account_not_logged_in: "登录已失效。方便时运行 npm run browser 重新登录，完成后退出专用浏览器再恢复。",
  account_changed: "当前登录账号与任务账号不同，请确认账号后再恢复。",
  platform_forbidden: "平台暂时限制访问，本批已暂停，请稍后手动处理。",
  platform_read_failed: "平台读取失败，本批已暂停，请查看运行日志后再恢复。",
  self_page_ready_timeout: "平台未返回完整登录信息。请稍后检查登录或验证状态，再恢复任务。",
  vision_pricing_missing: "视觉模型的计费信息尚未配置。", asr_dependency_missing: "语音转写环境尚未就绪。",
  route_evidence_missing: "现有内容不足以确定处理方式。", no_audio_track: "视频中没有可用音轨。",
  budget_exceeded: "已停止后续模型调用，已完成的内容会保留。", call_outcome_unknown: "上次调用结果未知，已暂停自动重试。" };
const timecode = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
let batchTimer, batchObservedActive = false;
async function loadBatch() {
  clearTimeout(batchTimer);
  try {
    const b = await api("batch");
    if(b.active || b.latest?.status === "running") {
      batchObservedActive = true;
      batchTimer=setTimeout(()=>void loadBatch(),4000);
    } else if (batchObservedActive) {
      batchObservedActive = false;
      state = await api("state");
      render();
    }
  } catch { batchTimer=setTimeout(()=>void loadBatch(),4000); }
}
const questionErrors = { question_not_configured: "请在本机模型配置中填写出题模型和凭证。",
  question_pricing_missing: "请补全出题模型单价与调用预留额。", question_evidence_missing: "暂无足够证据。先处理视频或补充原文摘录。",
  draft_source_changed: "原文已变化，请根据最新原文重新生成草稿。",
  question_call_outcome_unknown: "上次调用结果未知，需先核对供应商记录。",
  question_output_incomplete: "模型返回未完成，草稿未发布。", invalid_question_evidence: "模型引用未通过原文校验，草稿未发布。" };
async function loadDrafts(key) {
  const target=$("#draft-result");
  try {
    const data=await api(`drafts?itemKey=${encodeURIComponent(key)}`);
    if(!target?.isConnected||detailKey!==key)return;
    const pending=data.drafts.filter(d=>d.status==="pending");
    target.innerHTML=`${data.generation?`<p>${esc(contentStatuses[data.generation.status]||"等待出题")} ${data.generation.error?`· ${esc(questionErrors[data.generation.error]||contentErrors[data.generation.error]||"请检查模型配置与处理记录，修复后手动重试。")}`:""}</p>`:""}
      <p class="tiny-note">自动题已经过结构与逐字证据校验。机器转写与画面观察仍可能有误，可在这里检查或拒绝异常题目。</p>
      ${pending.length?pending.map(d=>`<article class="draft-card"><h4>${esc(d.prompt)}</h4><ol type="A">${d.options.map((o,i)=>`<li>${esc(o)}${i===d.answer?" ✓ 正确答案":""}</li>`).join("")}</ol>
      <blockquote>${esc(d.evidence)}</blockquote><p>${esc(d.explanation)}</p>
      <p class="tiny-note">${d.sourceSpans.map(s=>`${s.kind==="transcript"?"语音转写":s.kind==="observation"?"采样画面":"正文 / 摘录"}${Number.isFinite(s.startMs)?` ${timecode(s.startMs)}–${timecode(s.endMs)}`:""}`).join(" · ")}</p>
      <div class="btn-row"><button class="primary" data-draft="${d.id}" data-decision="approve">核对通过，加入题库</button><button class="secondary" data-draft="${d.id}" data-decision="reject">拒绝这道题</button></div></article>`).join(""):"<p>目前没有待核对草稿。</p>"}
      <p class="tiny-note">已通过 ${data.drafts.filter(d=>d.status==="approved").length} 道 · 已拒绝 ${data.drafts.filter(d=>d.status==="rejected").length} 道</p>`;
  }catch(err){if(target?.isConnected)target.textContent=err.message;}
}
async function loadContent(key) {
  const target = $("#content-result");
  try {
    const { suggestion, result } = await api(`content?itemKey=${encodeURIComponent(key)}`);
    if (detailKey !== key || !target.isConnected) return;
    const route = result?.route || suggestion;
    let text = `<p><strong>${esc(contentRoutes[route.route])}</strong> · ${esc(result ? contentStatuses[result.status] || "等待处理" : "建议路线，尚未处理")}</p>
      <p class="tiny-note">${esc(route.reasons.join("；"))}</p>`;
    if (result?.error) text += `<p>${esc(contentErrors[result.error] || "处理未完成，已保留当前结果。")}</p>`;
    if (result?.quality === "metadata_only") text += `<p>已保存元信息${result.comments.length ? `和 ${result.comments.length} 条评论` : "；尚无评论数据"}，不生成知识测试。</p>`;
    if (result?.segments?.length) text += `<details><summary>语音转写 · ${result.segments.length} 段，待核对</summary>
      ${result.segments.map(s => `<p><strong>${timecode(s.startMs)}–${timecode(s.endMs)}</strong> ${esc(s.text)}</p>`).join("")}</details>`;
    if (result?.observations?.length) text += `<details><summary>画面观察 · 仅覆盖采样时刻</summary>
      ${result.observations.map(o => `<p><strong>${timecode(o.timestampMs)}</strong> ${esc(o.text)}</p>`).join("")}</details>`;
    if (result?.claims?.length) text += `<details><summary>内容要点 · 待核对</summary>${result.claims.map(c =>
      `<p>${esc(c.text)}</p>`).join("")}</details>`;
    if (result?.comments?.length) text += `<details><summary>评论参考 · 不作为视频原文证据</summary>
      ${result.comments.map(c => `<p>${esc(c.text)}</p>`).join("")}</details>`;
    if (result?.costs) text += `<p class="tiny-note">已计费或预留 ¥${result.costs.chargedOrReservedCny.toFixed(4)}
      ${result.costs.accountingComplete ? "（按配置单价核算）" : " · 成本尚未完整核算"}</p>`;
    target.innerHTML = text;
  } catch {
    if (detailKey === key && target.isConnected) target.textContent = "暂时无法读取内容处理状态，重新打开详情可重试。";
  }
}
function openDetail(key) {
  const item = byKey(key);
  if(!item)return;
  detailKey=key;detailDirty=false;dirtyForms.clear();
  const p=state.progress[key],qs=itemQuestions(key);
  $("#detail").innerHTML=`<div class="dialog-inner"><div class="dialog-top"><span>${esc(item.categories.join(" / "))} · ${esc(item.categoryBasis)}</span><button class="close" data-action="close-detail" aria-label="关闭收藏详情">×</button></div><h2 id="detail-title">${esc(item.title)}</h2>
    <div class="detail-meta">${platformBadge(item)}<span>${esc(item.author)}</span><span>${item.baseline?"历史导入":"首次发现"} ${dayKey(item.firstSeenAt)}</span></div>
    <div class="detail-actions"><a class="secondary" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">查看原收藏 ↗</a>
    ${qs.length&&p&&learningStatus(p)==="due"?'<button class="primary" data-action="quiz-detail">开始学习 ↗</button>':
      `<span class="head-tag">${qs.length&&p?`下次复习 ${dateText(p.dueAt)}`:"等待系统自动生成题目"}</span>`}</div>
    <h3 style="margin-bottom:10px">收藏正文</h3><div class="source-body">${item.description?esc(item.description):"暂未提取到完整正文。可打开原收藏阅读，把想学习的内容补充到下方摘录中。"}</div>
    <section class="form-section" aria-label="内容理解"><h3>内容理解</h3><div id="content-result" class="source-body content-result" aria-live="polite">正在读取处理状态…</div></section>
    <section class="form-section" aria-label="自动出题"><h3>自动出题 · 当前 ${qs.length} 道</h3>
      <div class="btn-row"><button class="primary" data-action="generate">立即生成题目</button><button class="secondary" data-action="generate-retry">恢复失败的出题</button></div>
      <div id="draft-result" aria-live="polite">正在读取草稿…</div></section>
    <details class="form-section"><summary>补充学习摘录 ${state.excerpts[key]?"· 已保存":""}</summary><p class="tiny-note" style="margin-top:10px">把原收藏中值得学习的文字放在这里，供题卡引用。请保留原意。</p><form id="excerpt-form"><label for="excerpt">原文摘录</label><textarea id="excerpt" name="excerpt" maxlength="30000">${esc(state.excerpts[key]||"")}</textarea><div class="btn-row"><button class="secondary" type="submit">保存摘录</button></div><div class="inline-result" id="excerpt-result" role="status"></div></form></details>
    <details class="form-section"><summary>自建答题卡 · 当前 ${qs.length} 道题</summary><p class="tiny-note" style="margin-top:10px">问题应能从正文或已保存摘录中回答。每道题单独记录记忆状态与复习时间。</p>
    <form id="question-form"><label for="prompt">问题</label><input id="prompt" name="prompt" required minlength="5" maxlength="500" placeholder="关于这条内容，你希望记住什么？">
    <label>四个选项（勾选正确答案）</label>${["A","B","C","D"].map((l,i)=>`<div class="option-input"><input type="radio" name="answer" value="${i}" aria-label="将 ${l} 设为正确答案" ${i===0?"checked":""}><label for="option-${i}">${l}</label><input id="option-${i}" name="option${i}" required maxlength="300" aria-label="选项 ${l}"></div>`).join("")}
    <label for="evidence">原文依据（从上方正文或已保存摘录中复制，至少 8 字）</label><textarea id="evidence" name="evidence" required minlength="8" maxlength="3000"></textarea>
    <label for="explanation">答案解析</label><textarea id="explanation" name="explanation" required maxlength="3000" placeholder="为什么选它？"></textarea><div class="btn-row"><button class="primary" type="submit">保存题卡</button></div><div class="inline-result" id="question-result" role="status"></div></form></details></div>`;
  if(!$("#detail").open)$("#detail").showModal();
  void loadContent(key);
  void loadDrafts(key);
}
function canCloseDetail() {
  return !detailDirty || confirm("还有未保存的编辑，确定离开吗？");
}
function startQuiz(key) {
  const item=byKey(key),qs=itemQuestions(key),p=state.progress[key];
  if(!qs.length){toast("这条视频的题目尚未准备好");return;}
  if(!p||learningStatus(p)!=="due"){toast("这条视频还未到复习时间");return;}
  if($("#detail").open){if(!canCloseDetail())return;$("#detail").close();}
  const due=dueQuestions([item],state.progress,qs,state.cards);
  if(!due.length){toast("这条收藏的题目尚未到期");return;}
  quizItem=item;quizQuestion=due[0];choice=null;feedback=null;quizFinished=false;attemptId=crypto.randomUUID();
  renderQuiz();$("#quiz").showModal();
}
function renderQuiz() {
  const q=quizQuestion,item=quizItem;
  if(quizFinished){
    const p={dueAt:state.cards[q.id].card.due};
    $("#quiz").innerHTML=`<div class="dialog-inner"><div class="dialog-top"><span>ONE SMALL STEP FORWARD</span><button class="close" data-action="close-quiz" aria-label="关闭答题">×</button></div><div class="completion"><div class="big-check">✓</div><h2 id="quiz-title">本题完成。</h2><p>复习记录已保存 · 下次复习 ${dateText(p.dueAt)}</p><button type="button" class="primary" data-action="next-quiz">继续学习 →</button></div></div>`;
    return;
  }
  const p={reviews:state.cards[q.id].card.reps};
  const delayLabel=result=>{
    const minutes=Math.max(1,Math.round((Date.parse(result.card.due)-Date.parse(feedback.at))/60000));
    return minutes<60?`${minutes} 分钟后重学`:minutes<1440?`${Math.round(minutes/60)} 小时后复习`:`${Math.round(minutes/1440)} 天后复习`;
  };
  $("#quiz").innerHTML=`<div class="dialog-inner"><div class="dialog-top"><span>RECALL BEFORE REVEAL · ${q.origin==="generated"?"自动生成题":"我的自建题"}</span><button class="close" data-action="close-quiz" aria-label="关闭答题">×</button></div><div class="quiz-progress"><i style="width:${feedback?75:35}%"></i></div>
    <div class="eyebrow">${esc(item.categories[0])} / 第 ${(p.reviews??0)+1} 次学习</div><h2 id="quiz-title">${esc(q.prompt)}</h2><p class="quiz-intro">${feedback?"先看依据，再告诉自己：这次真的记住了吗？":"先在心里回忆一下，再选择答案。"}</p>
    <div class="quiz-options">${q.options.map((o,i)=>`<button class="quiz-option ${choice===i?"selected":""} ${feedback?(i===feedback.answer?"correct":i===feedback.choice?"incorrect":""):""}" data-choice="${i}" aria-pressed="${choice===i}" ${feedback?"disabled":""}><span>${"ABCD"[i]}</span>${esc(o)}</button>`).join("")}</div>
    ${!feedback?`<button class="primary" data-action="submit-answer" ${choice===null?"disabled":""}>提交答案，查看解析 →</button>`:
    `<section class="answer-panel"><h3>${feedback.correct?"✓ 答对了":"再看一眼，帮助记住"} · 正确答案 ${"ABCD"[feedback.answer]}</h3><p>${esc(feedback.explanation)}</p><blockquote>${esc(feedback.evidence)}</blockquote></section>
    <p class="tiny-note">FSRS 按这道题的记忆记录计算间隔。${feedback.correct?"请按回忆的难易程度选择。":"答错会记为「还没记住」。"}</p>
    <div class="confidence">${Object.entries(feedback.previews).map(([rating,result])=>`<button data-rating="${rating}">${({again:"还没记住",hard:"吃力想起",good:"记住了",easy:"很轻松"})[rating]}<small>${delayLabel(result)}</small></button>`).join("")}</div>`}</div>`;
}
let preparationTimer, preparationWatch = 0, startingLearning = false, learnAfterConfiguration = false;
const preparationMessages = {
  daily_completed: "今天的学习目标已完成。",
  empty_library: "学习库还没有收藏，请先点击「同步并分类」。",
  no_due_questions: "现有题目还未到复习时间，到期后可继续学习。",
  no_learning_content: "目前没有可出题的学习内容，试试同步新的知识类收藏。",
  daily_budget_limit: "今日出题预算已用完，明天会继续准备。",
  daily_item_limit: "今日处理数量已达上限，明天会继续准备。",
  question_not_configured: "请先配置自己的模型，保存后会自动准备题目。",
  asr_dependency_missing: "视频语音转写尚未安装，请按使用说明完成语音环境安装。",
  call_outcome_unknown: "上次模型调用结果尚未核对，出题已暂停。",
  explicit_retry_required: "上次出题中断，请重新点击「开始学习」恢复。"
};
function stopPreparationWatch() {
  clearTimeout(preparationTimer);
  preparationWatch++;
}
$("#preparing-close").addEventListener("click", () => $("#preparing-dialog").close());
$("#preparing-dialog").addEventListener("close", stopPreparationWatch);
async function showPreparation(result, watch) {
  if (watch !== preparationWatch) return;
  if (result.status === "ready") {
    stopPreparationWatch();
    $("#preparing-dialog").close();
    await reload();
    const due = todayItems();
    if (due.length) startQuiz(due[0].key);
    return;
  }
  if (result.status === "needs_configuration") {
    $("#preparing-dialog").close();
    learnAfterConfiguration = true;
    await openModelConfiguration();
    $("#model-status").textContent = preparationMessages[result.error] || questionErrors[result.error] ||
      "模型配置尚未完成，保存后会继续准备题目。";
    return;
  }
  if (result.status !== "preparing") {
    stopPreparationWatch();
    $("#preparing-title").textContent = "题目暂未准备好";
    $("#preparing-status").textContent = preparationMessages[result.error] || preparationMessages[result.status] ||
      questionErrors[result.error] || contentErrors[result.error] || "出题未完成，请稍后重新点击「开始学习」。";
    $("#preparing-note").textContent = "";
    return;
  }
  $("#preparing-title").textContent = "正在准备题目";
  $("#preparing-status").textContent = result.stage === "syncing" ? "正在同步分类，完成后会自动准备题目。" :
    `正在读取视频内容并出题 · 今日已准备 ${result.preparedVideos ?? 0} 条`;
  $("#preparing-note").textContent = "准备好后会自动开始学习。关闭窗口后，后台任务会继续。";
  preparationTimer = setTimeout(async () => {
    try { await showPreparation(await api("learning/preparation"), watch); }
    catch {
      if (watch !== preparationWatch) return;
      stopPreparationWatch();
      $("#preparing-title").textContent = "暂时无法读取出题进度";
      $("#preparing-status").textContent = "请确认本地服务正在运行，再重新点击「开始学习」。";
      $("#preparing-note").textContent = "";
    }
  }, 1500);
}
async function startToday() {
  if (startingLearning) return;
  startingLearning = true;
  stopPreparationWatch();
  const watch = preparationWatch;
  try {
    const result = await api("learning/start", {});
    if (!["ready", "needs_configuration"].includes(result.status) && !$("#preparing-dialog").open)
      $("#preparing-dialog").showModal();
    await showPreparation(result, watch);
  } finally { startingLearning = false; }
}

document.addEventListener("click",async e=>{
  const el=e.target.closest("button");if(!el||el.disabled)return;
  try{
    if(el.dataset.open){openDetail(el.dataset.open);return;}
    if(el.hasAttribute("data-range")){range=Number(el.dataset.range);render();return;}
    if(el.dataset.mode){chartMode=el.dataset.mode;render();return;}
    if(el.hasAttribute("data-choice")){choice=Number(el.dataset.choice);renderQuiz();$(`#quiz [data-choice="${choice}"]`).focus();return;}
    if(el.dataset.action==="start-today"){await startToday();return;}
    if(busy)return;
    busy=true;
    if(el.dataset.draft){
      if(!canCloseDetail())return;
      el.disabled=true;
      await api("draft",{itemKey:detailKey,draftId:el.dataset.draft,decision:el.dataset.decision});
      await reload();openDetail(detailKey);
    }
    if(el.dataset.rating){
      el.disabled=true;
      await api("review",{itemKey:quizItem.key,attemptId:feedback.attemptId,rating:el.dataset.rating});
      state=await api("state");quizFinished=true;renderQuiz();render();
    }
    switch(el.dataset.action){
      case "batch-refresh":await loadBatch();break;
      case "generate":case "generate-retry":{
        el.disabled=true;el.textContent="正在生成…";
        const result=await api("generate",{itemKey:detailKey,retry:el.dataset.action==="generate-retry"});
        await reload();await loadDrafts(detailKey);
        toast(result.status==="completed"?"题目已生成，可以直接开始学习":questionErrors[result.error]||contentErrors[result.error]||"出题已暂停，请查看处理状态");
        el.disabled=false;el.textContent=el.dataset.action==="generate"?"立即生成题目":"恢复失败的出题";break;
      }
      case "close-detail":if(canCloseDetail())$("#detail").close();break;
      case "quiz-detail":startQuiz(detailKey);break;
      case "close-quiz":$("#quiz").close();break;
      case "submit-answer":
        el.disabled=true;feedback=await api("answer",{itemKey:quizItem.key,questionId:quizQuestion.id,choice,attemptId});choice=feedback.choice;renderQuiz();
        $("#quiz .answer-panel").setAttribute("tabindex","-1");$("#quiz .answer-panel").focus();$("#quiz .answer-panel").scrollIntoView({block:"start"});break;
      case "next-quiz":{
        el.disabled=true;$("#quiz").close();const due=todayItems();
        if(due.length)startQuiz(due[0].key);else toast("当前学习清单已完成，休息一下吧");break;
      }
    }
  }catch(err){
    toast(err.message);
    if(el.isConnected){
      el.disabled=false;
      if(el.dataset.action==="generate")el.textContent="立即生成题目";
      if(el.dataset.action==="generate-retry")el.textContent="恢复失败的出题";
    }
  }finally{busy=false;}
});
$("#detail").addEventListener("input",e=>{dirtyForms.add(e.target.closest("form")?.id);detailDirty=true;});
$("#detail").addEventListener("cancel",e=>{if(!canCloseDetail())e.preventDefault();});
$("#quiz").addEventListener("cancel",()=>$("#quiz").close());
document.addEventListener("submit",async e=>{
  if(e.target.id==="learning-form"){
    e.preventDefault();if(busy)return;busy=true;
    const data=new FormData(e.target), button=e.target.querySelector("button[type=submit]");button.disabled=true;
    try{
      state=await api("learning/config",{dailyVideos:Number(data.get("dailyVideos"))});
      render();toast("每日学习视频数已保存，后台会按这个数量准备题目");
    }catch(err){toast(err.message);}finally{busy=false;if(button.isConnected)button.disabled=false;}
    return;
  }
  if(e.target.id==="batch-form"){
    e.preventDefault();if(busy)return;busy=true;
    const data=new FormData(e.target);
    try{await api("batch/config",{enabled:true,maxItemsPerDay:state.learningConfig.dailyVideos,budgetCnyPerDay:Number(data.get("budget"))});await loadBatch();toast("处理预算已保存");}
    catch(err){toast(err.message);}finally{busy=false;}
    return;
  }
  if(!["excerpt-form","question-form"].includes(e.target.id))return;
  e.preventDefault();if(busy)return;busy=true;
  const form=e.target,b=new FormData(form),button=form.querySelector("button[type=submit]");button.disabled=true;
  try{
    if(form.id==="excerpt-form"){
      await api("excerpt",{itemKey:detailKey,text:b.get("excerpt")});$("#excerpt-result").textContent="✓ 摘录已保存，可以用它创建题卡";detailDirty=false;
    }else if(form.id==="question-form"){
      await api("question",{itemKey:detailKey,question:{prompt:b.get("prompt"),options:[0,1,2,3].map(i=>b.get(`option${i}`)),answer:Number(b.get("answer")),evidence:b.get("evidence"),explanation:b.get("explanation")}});
      $("#question-result").textContent="✓ 题卡已保存，关闭详情后重新打开即可开始学习";form.reset();detailDirty=false;
    }
    dirtyForms.delete(form.id);detailDirty=dirtyForms.size>0;
    await reload();toast("已保存到本机");
  }catch(err){toast(err.message);}finally{busy=false;button.disabled=false;}
});
let syncTimer, syncObservedActive = false;
function syncError(code = "") {
  if (/account_check_busy/.test(code)) return "正在检查抖音登录，请稍等几秒后再同步。";
  if (/logged_in_account_required|account_not_logged_in|self_page_ready_timeout|login_browser_required/.test(code))
    return "暂时无法确认抖音登录。请在右上角「我」重新登录，再点击同步。";
  if (/another_run|collection_busy|ELOCKED/.test(code)) return "其他收藏任务正在运行，请稍后重试。";
  if (/account_not_bound/.test(code)) return "请先完成本机账号绑定，再同步分类。";
  if (/account_changed|account_mismatch/.test(code)) return "账号与已绑定账号不一致，请先核对账号。";
  if (/visible_browser/.test(code)) return contentErrors.visible_browser_in_use;
  return contentErrors[code] || "同步分类已暂停，请查看本机任务日志；如需登录或验证，完成后可再次点击。";
}
function renderSync(job) {
  const active = job.status === "running" || job.active === true;
  $("#refresh").disabled = active;
  $("#refresh").textContent = active ? "↻ 正在同步分类…" : "↻ 同步并分类";
}
async function loadSync() {
  clearTimeout(syncTimer);
  try {
    const job = await api("collection-sync");
    renderSync(job);
    if (job.status === "running") {
      syncObservedActive = true;
      syncTimer = setTimeout(() => void loadSync(), 2000);
    } else if (syncObservedActive) {
      syncObservedActive = false;
      await reload();
      toast(["completed", "partial"].includes(job.status) ? "收藏已同步并分类，学习库已更新" : syncError(job.error));
    }
  } catch {
    syncTimer = setTimeout(() => void loadSync(), 4000);
  }
}
$("#refresh").addEventListener("click",async()=>{
  if($("#refresh").disabled)return;
  $("#refresh").disabled=true;
  try {
    const job = await api("collection-sync", {});
    renderSync(job);syncObservedActive = job.status === "running" || job.active === true;
    void loadSync();
  } catch(err) { $("#refresh").disabled=false;toast(syncError(err.message)); }
});
void loadSync();
function renderAccount(account) {
  const verified = account.status === "verified";
  $("#account-state").textContent = verified ?
    `${account.nickname || "抖音账号"} · 登录已核验（${dateText(account.checkedAt)}）` :
    account.status === "login_pending" ? "请在专用窗口扫码，完成后点击检查登录。" : "登录状态待核验";
  $(".account-menu summary").textContent = verified ? (account.nickname || "我").slice(0, 1) : "我";
  $(".account-menu summary").title = $("#account-state").textContent;
}
async function accountAction(path) {
  $("#account-login").disabled = $("#account-check").disabled = true;
  try { renderAccount(await api(path, {})); }
  catch {
    renderAccount(await api("account").catch(() => ({ status: "unverified" })));
    toast("无法完成账号操作，请确认专用登录窗口已就绪，且没有其他收藏任务正在运行。");
  }
  finally { $("#account-login").disabled = $("#account-check").disabled = false; }
}
$("#account-login").addEventListener("click", () => void accountAction("account/login"));
$("#account-check").addEventListener("click", () => void accountAction("account/check"));
api("account").then(renderAccount).catch(() => {});
const modelButton = document.createElement("button");
modelButton.type = "button";
modelButton.className = "secondary";
modelButton.id = "model-open";
modelButton.textContent = "模型配置";
$(".account-panel").append(modelButton);
let modelConfiguration;
function fillModelFields(settings) {
  const form = $("#model-form");
  for (const key of ["provider", "model", "inputPrice", "outputPrice", "contentBudget"])
    form.elements[key].value = settings[key] ?? "";
  form.elements.apiKey.value = "";
  form.elements.apiKey.placeholder = settings.credentialPresent ? "已保存，留空保留原密钥" : "填写自己的 API Key";
  $("#model-status").textContent = settings.credentialPresent ? "本机已保存密钥；保存配置可恢复出题。" : "尚未配置自己的模型。";
}
async function openModelConfiguration() {
  try {
    modelConfiguration = await api("model-settings");
    fillModelFields(modelConfiguration);
    $("#model-error").textContent = "";
    $(".account-menu").open = false;
    if (!$("#model-dialog").open) $("#model-dialog").showModal();
  } catch { toast("暂时无法读取模型配置，请稍后重试。"); }
}
modelButton.addEventListener("click", () => { learnAfterConfiguration = false; void openModelConfiguration(); });
function closeModelDialog() {
  $("#model-form").elements.apiKey.value = "";
  $("#model-dialog").close();
}
$("#model-close").addEventListener("click", closeModelDialog);
$("#model-dialog").addEventListener("close", () => {
  $("#model-form").elements.apiKey.value = "";
  learnAfterConfiguration = false;
});
$("#model-form").elements.provider.addEventListener("change", event => {
  const provider = event.target.value, preset = modelConfiguration.presets[provider];
  fillModelFields(provider === modelConfiguration.provider ? modelConfiguration :
    { provider, ...preset, contentBudget: 0.05, credentialPresent: false });
  $("#model-form details").open = provider === "doubao";
});
$("#model-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget, submit = form.querySelector("[type=submit]");
  submit.disabled = true;
  $("#model-error").textContent = "";
  try {
    const provider = form.elements.provider.value;
    await api("model-settings", { provider, baseUrl: modelConfiguration.presets[provider].baseUrl,
      model: form.elements.model.value.trim(), apiKey: form.elements.apiKey.value.trim(),
      inputPrice: Number(form.elements.inputPrice.value), outputPrice: Number(form.elements.outputPrice.value),
      contentBudget: Number(form.elements.contentBudget.value) });
    const continueLearning = learnAfterConfiguration;
    closeModelDialog();
    toast("模型配置已保存，正在后台准备题目。");
    void loadBatch();
    if (continueLearning) await startToday();
  } catch (e) { $("#model-error").textContent = e.message; }
  finally { submit.disabled = false; }
});
window.addEventListener("hashchange",()=>{window.scrollTo(0,0);void reload();});
let resizeTimer;
window.addEventListener("resize",()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(!$("#detail").open&&!$("#quiz").open)render();},180);});
window.addEventListener("beforeunload",e=>{if(detailDirty&&$("#detail").open)e.preventDefault();});
reload().catch(err=>{$("#main").innerHTML=`<div class="error-box"><h2>暂时无法打开收藏空间</h2><p>${esc(err.message)}</p><p>请确认本地学习服务正在运行，然后刷新页面。</p></div>`;});
