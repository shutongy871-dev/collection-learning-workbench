import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { watch, readFolderMembers, proveMemberPages, proveFolderMembers } from "../scripts/local-scan.mjs";
import { buildDailyPlan } from "../scripts/daily-policy.mjs";

const folder = { id: "9000000000000000010", name: "AI", owner: "account", total: 0 };
const eight = Array.from({ length: 8 }, (_, n) => ({ aweme_id: `video-${n}`, desc: "AI" }));
const memberData = (items = eight, more = 0, cursor = 0) => ({
  status_code: 0, aweme_list: items, has_more: more, cursor
});
const record = (items = [], extra = {}) => ({
  path: "/aweme/v1/web/collects/video/list/", status: 200, code: 0, hasMore: 0, cursor: 0,
  query: { cursor: "0", collects_id: folder.id }, body: {}, items, itemsType: "null", ...extra
});
class FolderPage extends EventEmitter {
  closed = false;
  inside = false;
  clicks = 0;
  scrolls = 0;
  constructor(context, config = {}) {
    super();
    this.ctx = context;
    this.config = config;
    this.mouse = { move: async () => {}, wheel: async () => {
      this.scrolls++;
      const next = this.config.nextPages?.[this.scrolls - 1];
      this.respond("member", next?.data ?? this.config.nextData, { cursor: next?.cursor ?? "10" });
    } };
  }
  context() { return this.ctx; }
  setDefaultTimeout() {}
  request() {
    const request = { method: () => "GET", postData: () => "" };
    this.emit("request", request);
    return request;
  }
  respond(kind, data, options = {}) {
    const path = kind === "account" ? "/user/profile/self/" :
      kind === "folders" ? "/collects/list/" : "/collects/video/list/";
    const query = new URLSearchParams({ cursor: options.cursor ?? "0",
      ...(kind === "member" ? { collects_id: options.folderId ?? folder.id, count: this.config.count ?? "10" } : {}) });
    const request = options.request ?? this.request();
    const response = {
      url: () => `https://www.douyin.com/aweme/v1/web${path}?${query}`,
      request: () => request, status: () => options.status ?? 200,
      json: async () => {
        if (options.invalid) throw new Error("bad_json");
        return data;
      }
    };
    this.emit("response", response);
  }
  async goto(url) {
    if (url === "about:blank") return;
    this.respond("account", { status_code: 0, user: { uid: this.config.accountId ?? "account" } });
    const folders = this.config.folders ?? [{ ...folder, ...this.config.folder }];
    this.respond("folders", { status_code: 0, cursor: 0, has_more: 0,
      collects_list: folders.map(f => ({ collects_id_str: f.id, collects_name: f.name,
        total_number: f.total, user_id_str: f.owner })) });
    this.config.onNavigate?.(this);
  }
  locator(selector) {
    if (selector === "p") return { getByText: () => ({ click: async () => {
      this.clicks++;
      this.inside = true;
      if (this.config.clickError) throw new Error(this.config.clickError);
      if (this.config.onClick) this.config.onClick(this);
      else this.respond("member", this.config.data ?? memberData(), this.config.response);
    } }) };
    if (selector.startsWith("li:visible a[")) return {
      evaluateAll: async () => this.config.visibleItemIds ?? eight.map(i => i.aweme_id)
    };
    if (selector.startsWith("a[")) return { first: () => ({ waitFor: async () => {} }) };
    if (selector === "li:visible") {
      const cards = { count: async () => this.config.visibleItems ?? (this.config.emptyText ? 0 : 8),
        scrollIntoViewIfNeeded: async () => {}, last: () => cards, filter: () => cards };
      return cards;
    }
    throw new Error(`unexpected_selector:${selector}`);
  }
  getByText(text) {
    if (text === "返回") return {
      waitFor: async () => { assert.ok(this.inside); },
      isVisible: async () => this.inside,
      click: async () => { this.inside = false; }
    };
    const empty = {
      filter: () => empty, first: () => empty,
      waitFor: async () => { if (!this.config.emptyText) throw new Error("empty_state_missing"); },
      innerText: async () => this.config.emptyText
    };
    return empty;
  }
  waitForResponse(predicate, { timeout }) {
    return new Promise((resolve, reject) => {
      const listener = r => {
        if (predicate(r)) { clearTimeout(timer); this.off("response", listener); resolve(r); }
      };
      const timer = setTimeout(() => { this.off("response", listener); reject(new Error("response_timeout")); }, timeout);
      this.on("response", listener);
    });
  }
  async close() { this.closed = true; this.emit("close"); }
}
function harness(configs = [{}], initial = [record()], mainConfig = {}) {
  const pages = [], saved = [];
  const context = { newPage: async () => {
    assert.ok(pages.length < configs.length, "恢复超过预期次数");
    const page = new FolderPage(context, configs[pages.length]);
    pages.push(page);
    return page;
  } };
  const page = new FolderPage(context, mainConfig);
  const capture = watch(page);
  capture.records.push(...initial);
  return { page, capture, pages, saved,
    read: () => readFolderMembers({ page, capture, folder, accountId: "account", responseTimeout: 15,
      readinessTimeout: 30, onRecovery: async r => saved.push(structuredClone(r)) }),
    stop() {
      capture.stop();
      for (const p of [page, ...pages]) {
        for (const event of ["request", "response", "close"]) assert.equal(p.listenerCount(event), 0);
      }
      assert.ok(pages.every(p => p.closed));
      assert.equal(page.closed, false, "不能关闭调用方页面");
    }
  };
}

test("watch保留null、[]、缺失和错误正文，不把四者折叠成同一空夹", async () => {
  const p = new FolderPage({});
  const capture = watch(p);
  p.respond("member", memberData(null));
  p.respond("member", memberData([]));
  p.respond("member", { status_code: 0, has_more: 0 });
  p.respond("member", memberData(), { invalid: true });
  await capture.flush();
  assert.deepEqual(capture.records.map(r => r.itemsType), ["null", "array", "missing", undefined]);
  assert.equal(capture.records[2].items, undefined);
  assert.equal(capture.records[3].error, "response_not_json");
  capture.stop();
});
test("原始null/空数组/缺字段/错误正文都触发独立重读并恢复8条", async t => {
  for (const extra of [{}, { itemsType: "array" }, { itemsType: "missing", items: undefined },
    { error: "response_not_json" }]) await t.test(JSON.stringify(extra), async () => {
    const h = harness([{}], [record([], extra)]);
    const result = await h.read();
    assert.equal(result.readable, 8);
    assert.equal(result.memberSource, "recovered");
    assert.equal(h.pages.length, 1);
    assert.equal(h.page.clicks, 0);
    assert.equal(h.saved[0].attempts[0].status, "recovered");
    assert.ok(result.pages.every(p => p.requestSeq > result.recovery.attempts[0].clickMark));
    h.stop();
  });
});
test("完整非空预加载走快路径，目录错误零计数不会抹掉真实成员", async () => {
  const h = harness([], [record([{ id: "existing" }], { itemsType: "array" })]);
  assert.equal((await h.read()).memberSource, "prefetch");
  assert.equal(h.page.clicks, 0);
  h.stop();
});
test("普通未预加载夹在当前页完整翻页，返回目录并保留两页成员", async () => {
  const h = harness([], [], { data: memberData(eight.slice(0, 4), 1, 10),
    nextData: memberData(eight.slice(4)) });
  const result = await h.read();
  assert.equal(result.memberSource, "clicked");
  assert.equal(result.readable, 8);
  assert.equal(result.pages.length, 2);
  assert.equal(h.page.scrolls, 1);
  assert.equal(h.page.inside, false);
  h.stop();
});
test("点击前发出且点击后才返回的旧预加载不能覆盖新成员页", async () => {
  let oldRequest;
  const h = harness([{ onNavigate: p => { oldRequest = p.request(); }, onClick: p => {
    p.respond("member", memberData());
    p.respond("member", memberData(null), { request: oldRequest });
  } }]);
  const result = await h.read();
  assert.equal(result.readable, 8);
  assert.equal(result.pages.length, 1);
  assert.equal(result.recovery.attempts[0].records.filter(r => r.itemsType === "null").length, 1);
  h.stop();
});
test("独立文档非空预加载在账号就绪前完成，点击复用缓存也能逐ID确认恢复", async () => {
  const h = harness([{ onNavigate: p => p.respond("member", memberData()), onClick: () => {} }]);
  const result = await h.read();
  assert.equal(result.readable, 8);
  const attempt = result.recovery.attempts[0];
  assert.ok(result.pages[0].requestSeq <= attempt.clickMark);
  assert.deepEqual(attempt.visibleItemIds, eight.map(i => i.aweme_id));
  assert.equal(attempt.seedPages.length, 1);
  h.stop();
});
test("冻结非空缓存后迟到的空预加载不能覆盖它，页面ID不符时仍拒绝恢复", async () => {
  const config = { onNavigate: p => {
    p.respond("member", memberData());
    p.oldRequest = p.request();
  }, onClick: p => p.respond("member", memberData(null), { request: p.oldRequest }) };
  const h = harness([config]);
  assert.equal((await h.read()).readable, 8);
  h.stop();
  const mismatch = { ...config, visibleItemIds: ["wrong"] };
  const bad = harness([mismatch, mismatch]);
  await assert.rejects(bad.read(), /folder_members_unverified/);
  assert.ok(bad.saved.at(-1).attempts.every(a => a.error === "member_view_mismatch"));
  bad.stop();
});
test("当前文档非空预加载不发新的首页请求时，仍能点击核对并接续完整分页", async () => {
  const h = harness([], [record(eight.slice(0, 4).map(i => ({ id: i.aweme_id })),
    { itemsType: "array", hasMore: 1, cursor: 10, requestSeq: 0 })],
  { onClick: () => {}, nextData: memberData(eight.slice(4)) });
  const result = await h.read();
  assert.equal(result.memberSource, "clicked");
  assert.equal(result.readable, 8);
  assert.equal(h.page.scrolls, 1);
  h.stop();
});
test("只有旧响应或别的夹响应，无本次首请求时两次后停止", async () => {
  const stale = { onNavigate: p => { p.oldRequest = p.request(); }, onClick: p => {
    p.respond("member", memberData(), { request: p.oldRequest });
    p.respond("member", memberData(), { folderId: "other" });
  } };
  const h = harness([stale, stale]);
  await assert.rejects(h.read(), /folder_members_unverified/);
  assert.equal(h.saved.length, 2);
  assert.ok(h.saved.at(-1).attempts.every(a => a.error === "member_response_timeout"));
  h.stop();
});
test("真空夹必须目录零计数、可见空提示、零卡片与点击后完整新响应共同证明", async t => {
  for (const items of [[], null]) await t.test(JSON.stringify(items), async () => {
    const h = harness([{ data: memberData(items), emptyText: "暂无收藏作品" }]);
    const result = await h.read();
    assert.equal(result.memberSource, "confirmed_empty");
    assert.equal(result.readable, 0);
    assert.equal(proveFolderMembers(result).length, 1);
    assert.throws(() => proveFolderMembers({ ...result, owner: "other" }), /scope_mismatch/);
    h.stop();
  });
});
test("重复null、正文缺失、缺少空提示、数量冲突和残留卡片都不能冒充真空", async t => {
  const cases = [
    { data: memberData(null) },
    { data: { status_code: 0, has_more: 0 }, emptyText: "暂无收藏作品" },
    { data: memberData([]), folder: { total: 8 }, emptyText: "暂无收藏作品" },
    { data: memberData([]), emptyText: "暂无收藏作品", visibleItems: 1 }
  ];
  for (const config of cases) await t.test(JSON.stringify(config), async () => {
    const h = harness([config, config]);
    await assert.rejects(h.read(), error => {
      assert.equal(error.recovery.attempts.length, 2);
      return /folder_members_unverified/.test(error.message);
    });
    assert.equal(h.saved.at(-1).attempts[1].status, "failed");
    h.stop();
  });
});
test("首次重读仍空时第二次可恢复；恢复中完整分页不漏后四条", async () => {
  const h = harness([{ data: memberData(null) }, {
    data: memberData(eight.slice(0, 4), 1, 10), nextData: memberData(eight.slice(4))
  }]);
  const result = await h.read();
  assert.equal(result.readable, 8);
  assert.equal(result.pages.length, 2);
  assert.deepEqual(h.saved.at(-1).attempts.map(a => a.status), ["failed", "recovered"]);
  h.stop();
});
const middlePage = short => ({
  count: "4", data: memberData(eight.slice(0, 4), 1, 10),
  nextPages: [{ cursor: "10", data: memberData(eight.slice(4, short ? 6 : 8), 1, 20) },
    { cursor: "20", data: memberData([{ aweme_id: "last" }]) }]
});
const brokenMiddle = () => [
  record(eight.slice(0, 4).map(i => ({ id: i.aweme_id })), { itemsType: "array", cursor: 10, hasMore: 1 }),
  record([], { query: { cursor: "10", count: "4", collects_id: folder.id }, cursor: 20, hasMore: 1 })
];
test("异常中间页从null变成短页仍需第二次恢复，避免把少返回的成员放进差集", async () => {
  const h = harness([middlePage(true), middlePage(false)], brokenMiddle());
  const result = await h.read();
  assert.equal(result.readable, 9);
  assert.equal(result.recovery.attempts[0].error, "member_recovery_short_page:10");
  assert.equal(result.recovery.attempts[1].status, "recovered");
  h.stop();
});
test("异常页连续重读仍是短页时停止；旧版完整快照也不能绕过计划校验", async () => {
  const h = harness([middlePage(true), middlePage(true)], brokenMiddle());
  let recovery;
  await assert.rejects(h.read(), error => {
    recovery = error.recovery;
    return /folder_members_unverified/.test(error.message);
  });
  assert.throws(() => proveFolderMembers({ ...folder,
    pages: recovery.attempts.at(-1).pages, recovery }), /member_recovery_short_page:10/);
  h.stop();
});
test("账号切换、目录消失/owner变化、403立即停止且释放页面和监听", async t => {
  for (const [config, expected] of [
    [{ accountId: "other" }, /account_changed/],
    [{ folders: [] }, /destination_disappeared/],
    [{ folder: { owner: "other" } }, /account_scope_mismatch/],
    [{ response: { status: 403 } }, /platform_forbidden/]
  ]) await t.test(expected.source, async () => {
    const h = harness([config]);
    await assert.rejects(h.read(), expected);
    assert.equal(h.pages.length, 1);
    assert.equal(h.saved.length, 1);
    h.stop();
  });
});
test("预加载已经403时不启动重读", async () => {
  const h = harness([], [record([], { status: 403 })]);
  await assert.rejects(h.read(), /platform_forbidden/);
  assert.equal(h.pages.length, 0);
  h.stop();
});
test("点击失败立即取消等待，连续失败有证据且不残留监听", async () => {
  const h = harness([{ clickError: "element_missing" }, { clickError: "element_missing" }], [],
    { clickError: "element_missing" });
  await assert.rejects(h.read(), /folder_members_unverified/);
  assert.equal(h.saved.at(-1).currentRead.error, "element_missing");
  h.stop();
});
test("空夹证据必须来自本轮目标请求，缺末页或伪造范围不能放行", () => {
  const evidence = { folderId: folder.id, accountId: folder.owner,
    folderTotal: 0, clickMark: 10, emptyText: "暂无收藏作品", visibleItems: 0 };
  assert.throws(() => proveMemberPages([record([], { requestSeq: 9 })], evidence), /unverified/);
  assert.throws(() => proveMemberPages([record([], { requestSeq: 11, hasMore: undefined })], evidence), /missing_has_more/);
  assert.throws(() => proveMemberPages([record([], { requestSeq: 11, query: { cursor: "0", collects_id: "other" } })],
    evidence), /unverified/);
});
test("恢复后的成员用于计划差集，原误增的8条不会进入待分类", async () => {
  const h = harness([{}]);
  const restored = await h.read();
  const favorites = [...restored.items, { id: "truly-unclassified", title: "AI" }];
  const page = { query: { cursor: "0" }, code: 0, status: 200, hasMore: 0 };
  const snapshot = { complete: true, account: { id: "account" },
    folderPages: [{ ...page, folders: [folder] }], folders: [restored],
    favoritePages: [{ ...page, items: favorites }], unclassified: favorites.slice(8) };
  const plan = buildDailyPlan(snapshot, [], "account");
  assert.equal(plan.total, 1);
  assert.deepEqual(plan.unresolved.map(i => i.id), ["truly-unclassified"]);
  h.stop();
});
