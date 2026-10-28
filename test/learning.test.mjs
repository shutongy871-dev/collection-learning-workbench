import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { categoryName, dailyLearningQueue, dailyQuizQueue, dayKey, filterItems, growthSeries, validateQuestion } from "../src/learning/domain.mjs";
import { learningWeight, lowValueQuestionReason } from "../src/learning/question-policy.mjs";
import { newCard, previewReview, defaultParameters } from "../src/learning/scheduler.mjs";
import { emptyState, importCollections, retainDouyinState } from "../src/learning/import.mjs";
import { startLearningServer } from "../src/learning/server.mjs";
import { defaultFolders, defaultFolderName } from "../scripts/default-folders.mjs";

const sample = {
  key: "douyin:a:1", id: "1", platform: "douyin", accountId: "a", title: "测试学习", author: "作者",
  categories: ["摄影与修图"], type: "video", description: "这是一段经过阅读的学习原文，足够验证题目的证据。",
  firstSeenAt: "2026-10-10T16:01:00Z", baseline: true
};
const question = { id: "test-q", itemKey: sample.key, prompt: "哪一个选项对应原文？", options: ["选项一","选项二","选项三","选项四"],
  answer: 1, evidence: "这是一段经过阅读的学习原文", explanation: "此处有原文依据。" };

test("夹名展示：14类保持独立，否定条件不被当成主题，兼容缩短名和未闭合括号", () => {
  const expected = ["化妆与护肤","穿搭","购物灵感","摄影与修图","吃喝与旅行","商业与产品","英语学习",
    "宏观经济","通识与生活","书影音","其他灵感","文字与感悟","AI 与工具","商务口语"];
  assert.deepEqual(defaultFolders.map(f => categoryName(f.name)), expected);
  assert.deepEqual(defaultFolders.map(f => categoryName(defaultFolderName(f))), expected);
  for (const name of ["知识（非商业非英语）","知识(非宏观经济非AI知识", "知识 不含商业",
    "知识（不包括商务口语）","知识（排除英语）"]) assert.equal(categoryName(name), "通识与生活");
  assert.equal(categoryName("其他（非英语非商务口语）"), "其他灵感");
  assert.equal(categoryName("b拍照（非化妆）"), "摄影与修图");
  assert.equal(categoryName("a AI 知识"), "AI 与工具");
  assert.equal(categoryName("攀岩（非商业）"), "攀岩（非商业）");
  assert.equal(categoryName(null), "未分类");
});

test("学习趋势：北京时间跨日、历史导入和增量分开，窗口前存量计入累计", () => {
  assert.equal(dayKey("2026-10-10T16:01:00Z"), "2026-10-11");
  const items=[sample,{...sample,key:"2",baseline:false,firstSeenAt:"2026-10-12T03:00:00Z"}];
  assert.deepEqual(growthSeries(items,"2026-10-11","2026-10-13"),[
    {date:"2026-10-11",baseline:1,added:0,total:1},{date:"2026-10-12",baseline:0,added:1,total:2},
    {date:"2026-10-13",baseline:0,added:0,total:2}
  ]);
  assert.equal(growthSeries(items,"2026-10-12","2026-10-13")[0].total,2);
  assert.deepEqual(growthSeries(items,"2026-10-14","2026-10-13"),[]);
});
test("学习筛选：来源/主题/关键词/形式/日期组合，保留同一收藏去重语义", () => {
  const other={...sample,key:"unsupported:b:1",platform:"unsupported",type:"image"};
  assert.deepEqual(filterItems([sample,other],{platform:"douyin",category:"摄影与修图",q:"学习原文",type:"video",from:"2026-10-11",to:"2026-10-11"}),[sample]);
  assert.equal(filterItems([sample],{category:"不存在"}).length,0);
  assert.equal(filterItems([sample],{status:"due"},{[sample.key]:{dueAt:"2026-10-10"}},Date.parse("2026-10-13")).length,1);
});
test("FSRS-6新卡四档预览：Again10分钟、Hard15分钟、Good2天、Easy8天", () => {
  const now=Date.parse("2026-10-13T10:00:00Z");
  const card=newCard(question,now);
  const preview=previewReview(card,defaultParameters(),true,now);
  assert.deepEqual(Object.keys(preview),["again","hard","good","easy"]);
  assert.deepEqual(Object.values(preview).map(p=>(Date.parse(p.card.due)-now)/60000),[10,15,2880,11520]);
  assert.deepEqual(Object.keys(previewReview(card,defaultParameters(),false,now)),["again"]);
  assert.ok(preview.good.card.stability>0);
  assert.equal(card.card.reps,0);
});
test("题卡：拒绝不存在的原文证据与重复选项", () => {
  assert.equal(validateQuestion(question,sample.description),question);
  assert.throws(()=>validateQuestion({...question,evidence:"这是模型自行编造出来的观点"},sample.description));
  assert.throws(()=>validateQuestion({...question,options:["一","一","二","三"]},sample.description));
});
test("每日学习队列按视频限额，已完成视频占用当天名额且不会补入第N+1条", () => {
  const now = new Date("2026-10-20T02:00:00Z");
  const items = Array.from({ length: 3 }, (_, index) => ({ ...sample, key: `douyin:a:${index + 1}` }));
  const questions = items.map((item, index) => ({ ...question, id: `q-${index + 1}`, itemKey: item.key }));
  const progress = Object.fromEntries(items.map(item => [item.key, { dueAt: now.toISOString() }]));
  const cards = Object.fromEntries(questions.map(q => [q.id, { card: { due: now.toISOString() } }]));
  const selected = dailyLearningQueue(items, progress, questions, cards, [], 2, now);
  assert.equal(selected.length, 2);
  assert.deepEqual(dailyLearningQueue(items, progress, questions, cards, [], 2, now), selected);
  cards[questions.find(q => q.itemKey === selected[0].key).id].card.due = "2026-10-21T02:00:00Z";
  const events = [{ itemKey: selected[0].key, at: now.toISOString() }];
  assert.deepEqual(dailyLearningQueue(items, progress, questions, cards, events, 2, now).map(i => i.key),
    [selected[1].key]);
});

test("穿搭降权、商品细节题过滤；保留可复用的搭配判断题", () => {
  assert.equal(learningWeight({ categories: ["穿搭"] }), .25);
  assert.equal(learningWeight(sample), 1);
  for (const prompt of ["说话者对这款包包的评价是什么？", "这款包包在包型设计上有什么特点？",
    "原文中如何描述包包的触感？", "关于包包的收纳能力，原文怎么说？",
    "原文如何评价包包的搭配效果？", "清单把相机包的特点概括成什么？"]) {
    assert.equal(lowValueQuestionReason({ prompt }), "product_detail_recall");
  }
  assert.equal(lowValueQuestionReason({ prompt: "如何选择通勤包包，判断收纳能力要考虑什么？" }), null);
  const now = new Date("2026-10-20T02:00:00Z"), q = { ...question, prompt: "这款包包的优点是什么？" };
  assert.deepEqual(dailyQuizQueue([sample], { [sample.key]: {} }, [q],
    { [q.id]: newCard(q, now) }, [], 5, now), []);
});

test("每日种子跨视频交错，刷新和连续答题保持队列；穿搭降低实际出现频率", () => {
  const now = new Date("2026-10-20T02:00:00Z");
  const items = Array.from({ length: 40 }, (_, n) => ({
    ...sample, key: `video-${n}`, categories: n < 20 ? ["摄影与修图"] : ["穿搭"]
  }));
  const questions = items.flatMap(item => Array.from({ length: 5 }, (_, n) => ({
    ...question, id: `${item.key}-q-${n}`, itemKey: item.key
  })));
  const cards = Object.fromEntries(questions.map(q => [q.id, newCard(q, "2026-01-01")]));
  const progress = Object.fromEntries(items.map(item => [item.key, {}]));
  const queue = dailyQuizQueue(items, progress, questions, cards, [], 5, now);
  assert.equal(queue.length, 25);
  assert.deepEqual(dailyQuizQueue(items, progress, questions, cards, [], 5, now), queue);
  assert.ok(queue.every((q, n) => !n || q.itemKey !== queue[n - 1].itemKey));
  assert.notDeepEqual(dailyQuizQueue(items, progress, questions, cards, [], 5,
    new Date("2026-10-21T02:00:00Z")), queue);
  const [first, ...remaining] = queue;
  cards[first.id].card.due = "2026-10-21T02:00:00Z";
  assert.deepEqual(dailyQuizQueue(items, progress, questions, cards,
    [{ questionId: first.id, itemKey: first.itemKey, at: now.toISOString() }], 5, now), remaining);
  let fashion = 0;
  for (let day = 1; day <= 200; day++) {
    const at = new Date(Date.parse("2026-01-01") + day * 86400000);
    fashion += dailyLearningQueue(items, progress, questions, cards, [], 5, at)
      .filter(item => item.categories.includes("穿搭")).length;
  }
  assert.ok(fashion > 100 && fashion < 350, `fashion slots: ${fashion}/1000`);
});

async function temp(t) {
  await mkdir(resolve(".data"),{recursive:true});
  const dir=await mkdtemp(resolve(".data/learning-test-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return dir;
}
test("重新导入修复旧主题映射，保留条目身份、基线日期和学习记录", async t => {
  const dir=await temp(t);
  const folder=join(dir,"local-browser");
  await mkdir(folder,{recursive:true});
  const raw={id:sample.id,title:sample.title};
  await writeFile(join(folder,"final-snapshot.json"),JSON.stringify({
    account:{id:"a"},at:"2026-10-12T02:00:00Z",complete:true,favorites:[raw],
    folders:[{id:"knowledge",name:"a知识（非AI非商业非宏经非英语",items:[raw]}]
  }));
  const previous={...emptyState(),items:[{...sample,categories:["商业与产品"]}],questions:[question],
    notes:{[sample.key]:{text:"保留心得"}},excerpts:{[sample.key]:"保留摘录"},
    progress:{[sample.key]:{stage:2,dueAt:"2026-10-19"}},
    sources:[{platform:"douyin",accountId:"a"}],baselineCutoffs:{"douyin:a":"2026-10-11T02:00:00Z"},
    events:[{itemKey:sample.key,questionId:question.id}],attempts:{saved:{itemKey:sample.key,questionId:question.id}}};
  const updated=await importCollections(dir,previous);
  assert.deepEqual(updated.items[0].categories,["通识与生活"]);
  assert.equal(updated.items[0].key,sample.key);
  assert.equal(updated.items[0].firstSeenAt,sample.firstSeenAt);
  assert.equal(updated.items[0].baseline,true);
  for(const key of ["notes","excerpts","progress","questions","events","attempts","baselineCutoffs"])
    assert.deepEqual(updated[key],previous[key]);
});
test("导入：部分清单可展示、重复内容不翻倍、后续新增不伪装成历史基线、学习记录不丢失", async t => {
  const dir=await temp(t);
  const folder=join(dir,"local-browser");
  await mkdir(folder,{recursive:true});
  const snapshot={account:{id:"a"},at:"2026-10-12T02:00:00Z",complete:false,expectedFavorites:9,
    favorites:[{id:"1",title:"第一条"}]};
  await writeFile(join(folder,"snapshot.json"),JSON.stringify(snapshot));
  let s=await importCollections(dir);
  assert.equal(s.items.length,1);assert.equal(s.items[0].baseline,true);assert.equal(s.sources[0].complete,false);
  s.notes[s.items[0].key]={text:"个人心得"};
  snapshot.at="2026-10-13T02:00:00Z";snapshot.favorites.push({id:"2",title:"第二条"});
  await writeFile(join(folder,"snapshot.json"),JSON.stringify(snapshot));
  s=await importCollections(dir,s);
  assert.equal(s.items.length,2);assert.equal(s.items.find(i=>i.id==="2").baseline,false);
  assert.equal(s.notes["douyin:a:1"].text,"个人心得");
  assert.equal((await importCollections(dir,s)).items.length,2);
  snapshot.account.id="different-account";
  await writeFile(join(folder,"snapshot.json"),JSON.stringify(snapshot));
  s=await importCollections(dir,s);
  assert.equal(s.items.length,2);assert.equal(s.sources[0].accountId,"a");
  snapshot.platform="unsupported";snapshot.account.id="a";snapshot.favorites.push({id:"3",title:"不支持的来源"});
  await writeFile(join(folder,"snapshot.json"),JSON.stringify(snapshot));
  assert.equal((await importCollections(dir,s)).items.length,2);
});
test("单平台清理：删除旧来源及其关联记录，完整保留抖音学习数据且可重复执行", () => {
  const other={...sample,key:"retired:b:1",platform:"retired"};
  const original={...emptyState(),items:[sample,other],questions:[question,{...question,id:"old-q",itemKey:other.key}],
    sources:[{platform:"douyin",accountId:"a"},{platform:"retired",accountId:"b"}],
    baselineCutoffs:{"douyin:a":"2026-10-11","retired:b":"2026-10-12"}};
  for (const key of ["progress","notes","excerpts"]) original[key]={[sample.key]:{value:"keep"},[other.key]:{value:"remove"}};
  original.events=[{itemKey:sample.key,questionId:question.id},{itemKey:other.key,questionId:"old-q"}];
  original.attempts={keep:original.events[0],remove:original.events[1]};
  const cleaned=retainDouyinState(original);
  assert.deepEqual(cleaned.items,[sample]);assert.deepEqual(cleaned.questions,[question]);
  for (const key of ["progress","notes","excerpts"]) assert.deepEqual(cleaned[key],{[sample.key]:{value:"keep"}});
  assert.deepEqual(cleaned.events,[original.events[0]]);
  assert.deepEqual(cleaned.attempts,{keep:original.events[0]});
  assert.deepEqual(cleaned.sources,[original.sources[0]]);
  assert.deepEqual(cleaned.baselineCutoffs,{"douyin:a":"2026-10-11"});
  assert.deepEqual(retainDouyinState(cleaned),cleaned);
  assert.equal(original.items.length,2);
});
test("学习 HTTP：真实判题、重复提交幂等、提前复习拒绝、重启保存、来源验证与不覆盖摘录", async t => {
  const dir=await temp(t);
  const initial={...emptyState(),items:[sample],questions:[question]};
  await mkdir(join(dir,"learning"),{recursive:true});
  await writeFile(join(dir,"learning/state.json"),JSON.stringify(initial));
  let server=await startLearningServer({dataDir:dir,port:0,importOnStart:false});
  t.after(()=>server.close());
  let origin=`http://127.0.0.1:${server.address().port}`;
  const post=async(path,data,headers={})=>{
    const response=await fetch(`${origin}/api/${path}`,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify({itemKey:sample.key,...data})});
    return {status:response.status,data:await response.json()};
  };
  const visible=await (await fetch(`${origin}/api/state`)).json();
  assert.equal(visible.questions[0].answer,undefined);
  assert.ok(visible.progress[sample.key]);
  assert.equal((await post("enroll",{},{"Origin":"https://untrusted.example"})).status,403);
  await post("note",{text:"刷新和重启后应该留下的心得"});
  const a=await post("answer",{attemptId:"first-attempt",questionId:question.id,choice:0,correct:true});
  assert.equal(a.data.correct,false);assert.equal(a.data.answer,1);
  assert.equal((await post("answer",{attemptId:"first-attempt",questionId:question.id,choice:1})).status,409);
  const other=await post("answer",{attemptId:"second-attempt",questionId:question.id,choice:1});
  assert.equal(other.data.attemptId,"first-attempt");
  await post("review",{attemptId:"first-attempt",confidence:"remembered"});
  await post("review",{attemptId:"first-attempt",confidence:"remembered"});
  assert.equal((await post("answer",{attemptId:"next-attempt",questionId:question.id,choice:1})).status,409);
  let saved=JSON.parse(await readFile(join(dir,"learning/state.json"),"utf8"));
  assert.equal(saved.events.length,1);assert.equal(saved.progress[sample.key].reviews,1);
  assert.ok(Date.parse(saved.progress[sample.key].dueAt)-Date.now()>590_000);
  await post("excerpt",{text:"这是用户补充的一段原文摘录"});
  assert.equal((await post("question",{question:{...question,evidence:"这是用户补充的一段原文摘录"}})).status,200);
  assert.equal((await post("excerpt",{text:""})).status,400);
  await new Promise(resolve=>server.close(resolve));
  server=await startLearningServer({dataDir:dir,port:0,importOnStart:false});
  origin=`http://127.0.0.1:${server.address().port}`;
  saved=await (await fetch(`${origin}/api/state`)).json();
  assert.equal(saved.notes[sample.key].text,"刷新和重启后应该留下的心得");
  assert.equal(saved.events.length,1);
  assert.equal((await fetch(`${origin}/api/export`)).status,200);
});
