import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { openSelfPage, provePages, unique, finishPages, watch } from "../scripts/local-scan.mjs";

const page = (cursor, next, hasMore, items = [], extra = {}) => ({
  query: { cursor: String(cursor) }, body: {}, status: 200, code: 0,
  cursor: next, hasMore, items, ...extra
});
test("完整分页按游标链证明，响应乱序和重复第一页不截断存量", () => {
  const first = page(0, 10, 1, [{ id: "9000000000000000001" }]);
  const last = page(10, 0, 0, [{ id: "9000000000000000002" }]);
  const chain = provePages([last, first, first]);
  assert.deepEqual(unique(chain, "items").map(i => i.id), ["9000000000000000001", "9000000000000000002"]);
});
test("缺首、中间页或终止标志都拒绝证明完整", () => {
  assert.throws(() => provePages([page(10, 0, 0)]), /incomplete_page:0/);
  assert.throws(() => provePages([page(0, 10, 1), page(20, 0, 0)]), /incomplete_page:10/);
  assert.throws(() => provePages([page(0, 0, undefined)]), /missing_has_more/);
  assert.throws(() => provePages([]), /incomplete_page/);
});
test("游标循环与失败响应不会变成空夹或成功扫描", () => {
  assert.throws(() => provePages([page(0, 10, 1), page(10, 10, 1)]), /pagination_cycle/);
  assert.throws(() => provePages([page(0, 0, false, [], { status: 403 })]), /incomplete_page/);
  assert.throws(() => provePages([page(0, 0, false, [], { code: 8 })]), /incomplete_page/);
});
test("合法空夹必须有成功首响应和明确末页；POST正文游标同样可验证", () => {
  assert.equal(unique(provePages([page(0, 0, false)]), "items").length, 0);
  const post = page(0, 123456, true, [{ id: "old" }], { query: {}, body: { cursor: "0" } });
  const end = page(123456, 0, 0, [{ id: "older" }], { query: {}, body: { cursor: "123456" } });
  assert.deepEqual(unique(provePages([end, post]), "items").map(i => i.id), ["old", "older"]);
});

const accountData = { status_code: 0, user: { uid: "123", nickname: "当前账号" } };
const foldersData = { status_code: 0, collects_list: [], cursor: 0, has_more: false };
class SelfPage extends EventEmitter {
  navigations = [];
  constructor(navigate = async () => {}) { super(); this.navigate = navigate; }
  async goto(url, options) {
    this.navigations.push({ url, ...options });
    if (url === "about:blank") {
      // 前一页即使此时刚返回，也不能证明即将导航的新页面的账号。
      this.respond("account", { status_code: 0, user: { uid: "old" } });
      return;
    }
    return this.navigate(this);
  }
  respond(kind, data = kind === "account" ? accountData : foldersData, options = {}) {
    const path = kind === "account" ? "/user/profile/self/" : "/collects/list/";
    const request = { method: () => "GET", postData: () => "" };
    if (!options.stale) this.emit("request", request);
    this.emit("response", {
      url: () => `${options.origin ?? "https://www.douyin.com"}/aweme/v1/web${path}`,
      status: () => options.status ?? 200,
      request: () => request,
      json: async () => {
        if (options.invalid) throw new SyntaxError("invalid JSON");
        return options.json ? options.json() : data;
      }
    });
  }
}
function assertStopped(p) {
  assert.equal(p.listenerCount("request"), 0);
  assert.equal(p.listenerCount("response"), 0);
  assert.equal(p.listenerCount("close"), 0);
}
test("页面加载不占用业务就绪时间；旧页账号不会混入本次采集", async () => {
  let loaded;
  const p = new SelfPage(() => new Promise(resolve => { loaded = resolve; }));
  const opening = openSelfPage(p, { readinessTimeout: 20, expectedAccountId: "123" });
  await delay(60); // 已超过业务预算，但 DOMContentLoaded 尚未返回。
  p.respond("folders");
  loaded();
  p.respond("account");
  const { account, capture } = await opening;
  assert.equal(account.id, "123");
  assert.equal(capture.records.some(r => r.account?.id === "old"), false);
  assert.equal(p.navigations[0].url, "about:blank");
  assert.equal(p.navigations[1].waitUntil, "domcontentloaded");
  capture.stop();
  assertStopped(p);
});
test("响应头到达不等于账号就绪，必须等 JSON 正文解析完成", async () => {
  let completeBody;
  const p = new SelfPage(p => {
    p.respond("folders");
    p.respond("account", undefined, { json: () => new Promise(resolve => { completeBody = resolve; }) });
  });
  let finished = false;
  const opening = openSelfPage(p).then(result => { finished = true; return result; });
  await delay(5);
  assert.equal(finished, false);
  completeBody(accountData);
  const { capture, account } = await opening;
  assert.equal(account.id, "123");
  capture.stop();
  assertStopped(p);
});
test("旧文档在监听建立后才到达的响应也不能满足当前身份校验", async () => {
  const p = new SelfPage(p => {
    p.respond("account", { status_code: 0, user: { uid: "old" } }, { stale: true });
    p.respond("account");
    p.respond("folders");
  });
  const { account, capture } = await openSelfPage(p, { expectedAccountId: "123" });
  assert.equal(account.id, "123");
  assert.equal(capture.records.filter(r => r.account).length, 1);
  capture.stop();
  assertStopped(p);
});
test("正文一直不结束时检查点 flush 也能有界完成", async () => {
  const p = new SelfPage(p => {
    p.respond("folders");
    p.respond("account", undefined, { json: () => new Promise(() => {}) });
  });
  let failure;
  await assert.rejects(openSelfPage(p, { readinessTimeout: 10 }), error => {
    failure = error;
    return /response_body_timeout|self_page_ready_timeout:account/.test(error.message);
  });
  await failure.capture.flush();
  assert.equal(failure.capture.records.find(r => r.path.endsWith("/user/profile/self/")).error, "response_body_timeout");
  assertStopped(p);
});
test("账号绑定只要求当前账号；可信子域及安全整数 ID 正规化", async () => {
  const p = new SelfPage(p => p.respond("account", { status_code: 0, user: { uid: 123 } },
    { origin: "https://www-hj.douyin.com" }));
  const { account, capture } = await openSelfPage(p, { folders: false });
  assert.deepEqual(account, { id: "123", nickname: "" });
  capture.stop();
  assertStopped(p);
});
test("账号失败响应、缺身份、精度丢失或切换账号均停止且释放监听", async t => {
  const cases = [
    ["403", accountData, { status: 403 }, /platform_forbidden/],
    ["http", accountData, { status: 503 }, /platform_read_failed:account:503/],
    ["code", { ...accountData, status_code: 8 }, {}, /platform_read_failed:account:200:8/],
    ["json", accountData, { invalid: true }, /platform_response_invalid:account/],
    ["missing", { status_code: 0 }, {}, /account_not_logged_in/],
    ["anonymous", { status_code: 0, user: { uid: "0" } }, {}, /account_not_logged_in/],
    ["unsafe", { status_code: 0, user: { uid: Number.MAX_SAFE_INTEGER + 1 } }, {}, /account_not_logged_in/],
    ["changed", { status_code: 0, user: { uid: "456" } }, {}, /account_changed/]
  ];
  for (const [name, data, options, error] of cases) await t.test(name, async () => {
    const p = new SelfPage(p => p.respond("account", data, options));
    await assert.rejects(openSelfPage(p, { expectedAccountId: "123" }), error);
    assertStopped(p);
  });
});
test("账号和收藏夹缺失分别报就绪超时；伪同路径响应不能证明登录", async () => {
  const p = new SelfPage(p => {
    p.respond("folders");
    p.respond("account", undefined, { origin: "https://untrusted.example" });
  });
  await assert.rejects(openSelfPage(p, { readinessTimeout: 10 }), /self_page_ready_timeout:account$/);
  assertStopped(p);
  const q = new SelfPage(p => p.respond("account"));
  await assert.rejects(openSelfPage(q, { readinessTimeout: 10 }), /self_page_ready_timeout:folders$/);
  assertStopped(q);
});
test("收藏夹失败不能当成合法空夹，账号就绪也不会放行", async () => {
  const p = new SelfPage(p => { p.respond("account"); p.respond("folders", { status_code: 0 }); });
  await assert.rejects(openSelfPage(p), /platform_response_invalid:folders/);
  assertStopped(p);
});
test("导航失败与关闭页面不会残留响应监听或未处理拒绝", async () => {
  const p = new SelfPage(() => { throw new Error("navigation_failed"); });
  await assert.rejects(openSelfPage(p), /navigation_failed/);
  assertStopped(p);
  const q = new SelfPage(p => p.emit("close"));
  await assert.rejects(openSelfPage(q), /self_page_closed/);
  assertStopped(q);
});

test("DOM就绪等待期间已到达的下一页必须复用，不能再次等待同一响应", async () => {
  const p = new EventEmitter();
  const path = "/collects/video/list/";
  const capture = watch(p);
  const first = page(0, 10, 1, [{ id: "first" }], { path, itemsType: "array" });
  capture.records.push(first);
  let emitted = false, scrolls = 0;
  p.locator = selector => selector.startsWith("a[") ? { first: () => ({ waitFor: async () => {
    if (emitted) return;
    emitted = true;
    const request = { method: () => "GET", postData: () => "" };
    p.emit("request", request);
    p.emit("response", { url: () => `https://www.douyin.com${path}?cursor=10`, request: () => request,
      status: () => 200, json: async () => ({ status_code: 0, aweme_list: [{ aweme_id: "last" }], cursor: 0, has_more: 0 }) });
    await capture.flush();
  } }) } : { filter() { return this; }, last() { return this; },
    count: async () => 0 };
  p.mouse = { move: async () => {}, wheel: async () => { scrolls++; } };
  p.waitForResponse = () => new Promise((_, reject) => setTimeout(() => reject(new Error("missed_response")), 25));
  try {
    const chain = await finishPages(p, capture, path, () => capture.records);
    assert.deepEqual(unique(chain, "items").map(i => i.id), ["first", "last"]);
    assert.equal(scrolls, 0);
  } finally { capture.stop(); }
});

test("重复旧响应和乱序末页不改变缺失游标；POST正文按收藏夹隔离", async () => {
  const p = new EventEmitter(), path = "/collects/video/list/";
  const capture = watch(p);
  const entry = (cursor, next, more, id) => page(cursor, next, more, [{ id }], {
    path, query: {}, body: { cursor: String(cursor), collects_id: "target" }
  });
  const first = entry(0, 10, 1, "first");
  capture.records.push(first, entry(20, 0, 0, "last"), first);
  const waits = [];
  p.locator = selector => selector.startsWith("a[") ? { first: () => ({ waitFor: async () => { waits.push(selector); } }) } :
    { filter() { return this; }, last() { return this; }, count: async () => 0 };
  p.mouse = { move: async () => {}, wheel: async () => {
    for (const folder of ["other", "target"]) {
      const request = { method: () => "POST", postData: () => `cursor=10&collects_id=${folder}` };
      p.emit("request", request);
      p.emit("response", { url: () => `https://www.douyin.com${path}`, request: () => request,
        status: () => 200, json: async () => ({ status_code: 0,
          aweme_list: [{ aweme_id: folder === "target" ? "middle" : "wrong" }], cursor: 20, has_more: 1 }) });
    }
  } };
  try {
    const chain = await finishPages(p, capture, path,
      () => capture.records.filter(r => r.body.collects_id === "target"), { responseTimeout: 100 });
    assert.deepEqual(unique(chain, "items").map(i => i.id), ["first", "middle", "last"]);
    assert.equal(waits.length, 1);
    assert.ok(waits[0].includes("first"));
  } finally { capture.stop(); }
});

test("分页失败、循环、缺终止字段立即停止；无下一页响应有界退出并释放等待器", async () => {
  for (const pages of [[page(0, 0, 1)], [page(0, 0, undefined)], [page(0, 10, 1, [], { status: 403 })]]) {
    await assert.rejects(finishPages({}, { flush: async () => {} }, "/collects/list/", () => pages),
      /pagination_cycle|missing_has_more|platform_forbidden/);
  }
  const p = new EventEmitter(), capture = watch(p);
  capture.records.push(page(0, 10, 1, [], { path: "/collects/list/" }));
  p.locator = () => ({ filter() { return this; }, last() { return this; }, count: async () => 0 });
  p.mouse = { move: async () => {}, wheel: async () => {} };
  await assert.rejects(finishPages(p, capture, "/collects/list/", () => capture.records,
    { responseTimeout: 15 }), /member_response_timeout/);
  capture.stop();
  assert.equal(p.listenerCount("request"), 0);
  assert.equal(p.listenerCount("response"), 0);
});
