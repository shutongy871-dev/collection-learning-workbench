import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserEndpoint, connectBrowser } from "./browser-session.mjs";
import { recordAccountLogin, recordAccountFailure } from "./account-status.mjs";

export const browserDir = fileURLToPath(new URL("../.data/local-browser/", import.meta.url));
// 每日运行独立存证，连接和登录目录固定；保留原始人工验收证据。
export const dir = process.env.COLLECTION_RUN_DIR ? resolve(process.env.COLLECTION_RUN_DIR) + "/" : browserDir;
export async function save(name, data) {
  const path = resolve(dir, name);
  await writeFile(`${path}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
export async function connect({ background = true } = {}) {
  const endpoint = await browserEndpoint(browserDir);
  const browser = await connectBrowser(endpoint, { background });
  const context = browser.contexts()[0];
  if (!context) { await browser.close(); throw new Error("browser_context_missing"); }
  // Chrome可能仍在后台，但所有页面已被关闭；复用专用配置并新建执行页。
  const page = context.pages().find(p => p.url().startsWith("https://www.douyin.com/")) ??
    context.pages().find(p => p.url() === "about:blank") ?? await context.newPage();
  page.setDefaultTimeout(12_000);
  return { browser, page };
}
const allowed = new Set(["cursor", "max_cursor", "min_cursor", "count", "collects_id", "collects_ids"]);
const params = (input) => Object.fromEntries([...input].filter(([key]) => allowed.has(key)));
export function watch(page, onRecord = () => {}, { currentRequestsOnly = false, bodyTimeout = 30_000 } = {}) {
  const records = [];
  const inflight = new Set();
  const requests = new WeakMap();
  const waiters = new Set();
  let sequence = 0;
  const requested = request => requests.set(request, ++sequence);
  const listener = (r) => {
    if (currentRequestsOnly && !requests.has(r.request())) return;
    const url = new URL(r.url());
    if (!["www.douyin.com", "www-hj.douyin.com"].includes(url.hostname) ||
        !/\/(collects\/(?:video\/)?list|aweme\/listcollection|user\/profile\/self)\/?$/.test(url.pathname)) return;
    const job = (async () => {
      const entry = { at: new Date().toISOString(), path: url.pathname, status: r.status(),
        requestSeq: requests.get(r.request()),
        method: r.request().method(), query: params(url.searchParams),
        body: params(new URLSearchParams(r.request().postData() ?? "")) };
      let bodyTimer;
      try {
        const d = await Promise.race([r.json(), new Promise((_, reject) => {
          bodyTimer = setTimeout(() => reject(new Error("response_body_timeout")), bodyTimeout);
        })]);
        entry.keys = Object.keys(d);
        entry.code = d.status_code;
        entry.cursor = d.cursor;
        entry.hasMore = d.has_more;
        entry.total = d.total_number;
        entry.invalid = d.invalid_item_count;
        if (d.user) entry.account = {
          id: typeof d.user.uid === "string" ? d.user.uid : Number.isSafeInteger(d.user.uid) ? String(d.user.uid) : null,
          nickname: d.user.nickname ?? ""
        };
        if (d.collects_list) entry.folders = d.collects_list.map(f => ({
          id: f.collects_id_str, name: f.collects_name, total: f.total_number, owner: f.user_id_str
        }));
        entry.itemsType = !("aweme_list" in d) ? "missing" : d.aweme_list === null ? "null" :
          Array.isArray(d.aweme_list) ? "array" : typeof d.aweme_list;
        if (Array.isArray(d.aweme_list)) entry.items = d.aweme_list.map(a => ({
          id: a.aweme_id, title: a.desc ?? "", author: a.author?.nickname ?? "",
          hashtags: (a.text_extra ?? []).map(t => t.hashtag_name).filter(Boolean)
        }));
        else if (d.aweme_list === null) entry.items = [];
        if (process.env.DEBUG_EMPTY_PREFETCH && entry.path.endsWith("/collects/video/list/")) void readFile(new URL("../.dbg/empty-folder-prefetch.env", import.meta.url), "utf8").then(e => fetch(e.match(/DEBUG_SERVER_URL=(.+)/)[1], { method: "POST", signal: AbortSignal.timeout(1000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "empty-folder-prefetch", runId: process.env.DEBUG_EMPTY_PREFETCH, hypothesisId: "A", location: "local-scan:watch", msg: "[DEBUG] member payload normalized", data: { folderId: entry.query.collects_id, cursor: entry.query.cursor, rawType: d.aweme_list === null ? "null" : Array.isArray(d.aweme_list) ? "array" : typeof d.aweme_list, items: entry.items?.length, code: entry.code, hasMore: entry.hasMore }, ts: Date.now() }) })).catch(() => {});
      } catch (error) { entry.error = error.message === "response_body_timeout" ? error.message : "response_not_json"; }
      finally { clearTimeout(bodyTimer); }
      records.push(entry);
      if (process.env.DEBUG_RUN_ID && entry.path.endsWith("/user/profile/self/")) void readFile(new URL("../.dbg/account-response-timeout.env", import.meta.url), "utf8").then(e => fetch(e.match(/DEBUG_SERVER_URL=(.+)/)[1], { method: "POST", signal: AbortSignal.timeout(1000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "account-response-timeout", runId: process.env.DEBUG_RUN_ID, hypothesisId: "C", location: "local-scan:watch", msg: "[DEBUG] account parsed", data: { at: entry.at, status: entry.status, code: entry.code, hasId: Boolean(entry.account?.id), error: entry.error }, ts: Date.now() }) })).catch(() => {});
      onRecord(entry);
      for (const waiter of waiters) if (waiter.predicate(entry)) waiter.finish(null, entry);
    })();
    inflight.add(job);
    job.finally(() => inflight.delete(job));
  };
  page.on("request", requested);
  page.on("response", listener);
  return { records, mark: () => sequence, flush: () => Promise.all([...inflight]),
    expectRecord(predicate, timeout = 12_000) {
      let timer, resolveRecord, rejectRecord;
      const result = new Promise((resolve, reject) => { resolveRecord = resolve; rejectRecord = reject; });
      result.catch(() => {});
      const waiter = { predicate, finish(error, entry) {
        clearTimeout(timer);
        waiters.delete(waiter);
        if (error) rejectRecord(error); else resolveRecord(entry);
      } };
      waiters.add(waiter);
      timer = setTimeout(() => waiter.finish(new Error("member_response_timeout")), timeout);
      return { result, cancel: () => waiter.finish(new Error("capture_cancelled")) };
    },
    stop: () => {
    page.off("response", listener);
    page.off("request", requested);
    for (const waiter of waiters) waiter.finish(new Error("capture_stopped"));
  } };
}
// 先离开旧文档，防止旧页面的在途响应满足新一轮账号校验。
// 页面导航和业务就绪分别计时；只有当次成功解析的账号响应才能证明身份。
export async function openSelfPage(page, {
  folders = true, expectedAccountId, navigationTimeout = 30_000, readinessTimeout = 30_000
} = {}) {
  await page.goto("about:blank", { waitUntil: "commit", timeout: navigationTimeout });
  let account, timer, settled = false, resolveReady, rejectReady;
  const missing = new Set(["account", ...(folders ? ["folders"] : [])]);
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {}); // 导航尚未结束时，业务失败也已有拒绝处理器。
  const fail = error => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectReady(error);
  };
  const capture = watch(page, entry => {
    if (settled) return;
    const kind = entry.path.endsWith("/user/profile/self/") ? "account" :
      entry.path.endsWith("/collects/list/") ? "folders" : null;
    if (!missing.has(kind)) return;
    try {
      if (entry.status === 403) throw new Error("platform_forbidden");
      if (entry.status !== 200) throw new Error(`platform_read_failed:${kind}:${entry.status}`);
      if (entry.error) throw new Error(`platform_response_invalid:${kind}:${entry.error}`);
      if (entry.code !== 0) throw new Error(`platform_read_failed:${kind}:200:${entry.code}`);
      if (kind === "account") {
        account = entry.account;
        if (!account?.id || account.id === "0") throw new Error("account_not_logged_in");
        if (expectedAccountId != null && account.id !== String(expectedAccountId)) throw new Error("account_changed");
      } else if (!Array.isArray(entry.folders)) throw new Error("platform_response_invalid:folders");
      missing.delete(kind);
      if (!missing.size) { settled = true; clearTimeout(timer); resolveReady(); }
    } catch (error) { fail(error); }
  }, { currentRequestsOnly: true, bodyTimeout: readinessTimeout });
  const closed = () => fail(new Error("self_page_closed"));
  page.on("close", closed);
  try {
    await page.goto(`https://www.douyin.com/user/self?showTab=favorite_collection${folders ? "&showSubTab=favorite_folder" : ""}`,
      { waitUntil: "domcontentloaded", timeout: navigationTimeout });
    if (!settled) timer = setTimeout(() => fail(new Error(`self_page_ready_timeout:${[...missing].join(",")}`)),
      readinessTimeout);
    await ready;
    return { capture, account };
  } catch (error) {
    fail(error);
    capture.stop();
    error.capture = capture; // 失败时仍保留本次真实响应，供扫描检查点存证。
    throw error;
  } finally {
    clearTimeout(timer);
    page.off("close", closed);
  }
}
export const matchPath = (path) => (r) => new URL(r.url()).pathname.endsWith(path);
export async function trigger(page, path, action) {
  const pending = page.waitForResponse(typeof path === "function" ? path : matchPath(path), { timeout: 12_000 });
  pending.catch(() => {}); // 点击失败时，响应超时也不能产生未处理的拒绝。
  await action();
  const r = await pending;
  if (r.status() === 403) throw new Error("platform_forbidden");
  const d = await r.json();
  if (r.status() !== 200 || d.status_code !== 0) throw new Error(`platform_read_failed:${r.status()}:${d.status_code}`);
  return d;
}
// 用真实页面滚动触发分页，不构造带签名的私有 API 请求。
export async function scrollNext(page, path) {
  return trigger(page, path, () => scrollPage(page));
}
async function scrollPage(page) {
  const last = page.locator("li:visible").filter({ has: page.locator("a[href*='/video/']:visible, a[href*='/note/']:visible") }).last();
  if (await last.count()) await last.scrollIntoViewIfNeeded();
  await page.mouse.move(1100, 450);
  await page.mouse.wheel(0, 650);
}
export function collect(records, path) {
  return records.filter(r => r.path.endsWith(path));
}
export function unique(pages, field) {
  return [...new Map(pages.flatMap(p => p[field] ?? []).map(x => [x.id, x])).values()];
}
function paginationState(pages) {
  const byCursor = new Map(pages.map(p => [String(p.query.cursor ?? p.body.cursor), p]));
  const chain = [];
  let cursor = "0";
  const seen = new Set();
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const page = byCursor.get(cursor);
    if (!page) return { chain, next: cursor };
    if (page.status !== 200 || page.code !== 0 || page.error) {
      throw new Error(`incomplete_page:${cursor}`);
    }
    chain.push(page);
    if (page.hasMore === 0 || page.hasMore === false) return { chain, next: null };
    if (page.hasMore !== 1 && page.hasMore !== true) throw new Error("missing_has_more");
    if (page.cursor == null) throw new Error("incomplete_page:missing_next_cursor");
    cursor = String(page.cursor);
  }
  throw new Error("pagination_cycle");
}
export function provePages(pages) {
  const { chain, next } = paginationState(pages);
  if (next !== null) throw new Error(`incomplete_page:${next}`);
  return chain;
}
const memberPages = (records, id) => collect(records, "/collects/video/list/")
  .filter(r => (r.query.collects_id ?? r.body.collects_id) === id);
export async function finishPages(page, capture, path, select, { responseTimeout = 12_000 } = {}) {
  for (;;) {
    await capture.flush();
    const pages = select();
    if (pages.some(p => p.status === 403)) throw new Error("platform_forbidden");
    // 响应可能乱序或自动预取；只推进从0开始的已验证链，不能取最后到达的响应。
    const { chain, next } = paginationState(pages);
    if (next === null) return chain;
    if (!chain.length) throw new Error("incomplete_page:0");
    const previous = chain.at(-1);
    const folder = previous.query.collects_id ?? previous.body.collects_id;
    const lastItem = previous.items?.at(-1);
    // 在任何DOM等待前订阅正文完成事件。select仍保留点击轮次/收藏夹的隔离约束。
    const matches = r => r.path.endsWith(path) &&
      String(r.query.cursor ?? r.body.cursor) === next &&
      (!folder || (r.query.collects_id ?? r.body.collects_id) === folder);
    const pending = capture.expectRecord(r => matches(r) && select().includes(r), responseTimeout);
    try {
      if (lastItem) await page.locator(`a[href*="/${lastItem.id}"]:visible`).first().waitFor({ timeout: responseTimeout });
      // DOM就绪前已完成的预取直接复用；在此后到达的响应由pending接住。
      await capture.flush();
      if (!select().some(matches)) {
        await scrollPage(page);
        await pending.result;
      }
    } finally { pending.cancel(); }
  }
}

// 分页终止只能证明请求链结束，不能单独证明收藏夹为空。
export function proveMemberPages(pages, emptyEvidence) {
  const chain = provePages(pages);
  const items = unique(chain, "items");
  const validArrays = chain.every(p => (p.itemsType === undefined || p.itemsType === "array") &&
    Array.isArray(p.items) && p.items.every(i => typeof i.id === "string" && i.id));
  if (items.length && validArrays) return chain;
  if (!items.length && chain.length === 1 && emptyEvidence?.folderTotal === 0 &&
      emptyEvidence.emptyText && emptyEvidence.visibleItems === 0 &&
      Number.isInteger(emptyEvidence.clickMark) && chain.every(p =>
        p.requestSeq > emptyEvidence.clickMark &&
        (p.query.collects_id ?? p.body.collects_id) === emptyEvidence.folderId &&
        ["null", "array"].includes(p.itemsType) && Array.isArray(p.items))) return chain;
  throw new Error(items.length ? "member_payload_invalid" : "empty_members_unverified");
}
export function proveFolderMembers(folder) {
  if (folder.emptyEvidence && (folder.emptyEvidence.folderId !== folder.id ||
      folder.emptyEvidence.accountId !== folder.owner)) throw new Error("empty_evidence_scope_mismatch");
  const chain = proveMemberPages(folder.pages, folder.emptyEvidence);
  if (folder.recovery) assertRecoveredPages(folder.recovery, chain);
  return chain;
}
function assertRecoveredPages(recovery, chain) {
  // 曾返回空/异常的非末页，重读成短页仍不足以确认恢复；不能把少返回的成员变成未分类。
  // 这是针对已发生异常页的保守重试条件，普通短页可能含失效视频，仍沿用原分页口径。
  const suspect = new Set([...(recovery.initialPages ?? []), ...(recovery.currentRead?.pages ?? [])]
    .filter(p => (p.hasMore === 1 || p.hasMore === true) &&
      (p.error || p.itemsType === "null" || !Array.isArray(p.items) || !p.items.length))
    .map(p => String(p.query.cursor ?? p.body.cursor)));
  for (const p of chain) {
    const cursor = String(p.query.cursor ?? p.body.cursor);
    const requested = Number(p.query.count ?? p.body.count);
    if (suspect.has(cursor) && (p.hasMore === 1 || p.hasMore === true) &&
        Number.isInteger(requested) && requested > 0 && p.items.length < requested) {
      throw new Error(`member_recovery_short_page:${cursor}`);
    }
  }
}
function assertMemberScope(records, accountId) {
  if (records.some(r => r.status === 403)) throw new Error("platform_forbidden");
  for (const r of collect(records, "/user/profile/self/")) {
    if (r.status !== 200 || r.code !== 0 || !r.account?.id || r.account.id === "0") {
      throw new Error("account_not_logged_in");
    }
    if (r.account.id !== accountId) throw new Error("account_changed");
  }
}
async function clickedMembers(page, capture, folder, evidence, timeout) {
  await capture.flush();
  const before = memberPages(capture.records, folder.id);
  // 页面可能直接使用已经收到的非空缓存。冻结这批证据，并逐ID核对实际详情卡片。
  // 空缓存和点击前仍在途的响应不能走此分支；恢复页的缓存仅来自本次独立文档。
  const seed = before.length && before.every(p => p.status === 200 && p.code === 0 && !p.error &&
    p.itemsType === "array" && p.items?.length) ? [...before] : [];
  evidence.seedPages = seed;
  // mark 在 UI 点击前建立；响应晚到不能改变请求所属的读取轮次。
  evidence.clickMark = capture.mark();
  const select = () => [...seed, ...memberPages(capture.records, folder.id).filter(r => r.requestSeq > evidence.clickMark)];
  const pending = !seed.length ? capture.expectRecord(r => select().includes(r) &&
    String(r.query.cursor ?? r.body.cursor) === "0", timeout) : null;
  try {
    await page.locator("p").getByText(folder.name, { exact: true }).click();
    if (pending) await pending.result;
    await page.getByText("返回", { exact: true }).waitFor();
    if (seed.length) {
      const first = seed.findLast(p => String(p.query.cursor ?? p.body.cursor) === "0");
      if (!first) throw new Error("incomplete_page:0");
      await page.locator(`a[href*="/${first.items[0].id}"]:visible`).first().waitFor({ timeout });
      const visibleItemIds = await page.locator("li:visible a[href*='/video/']:visible, li:visible a[href*='/note/']:visible")
        .evaluateAll(links => [...new Set(links.map(a => a.href.match(/\/(?:video|note)\/([^/?#]+)/)?.[1]).filter(Boolean))]);
      evidence.visibleItemIds = visibleItemIds;
      if (!first.items.every(i => visibleItemIds.includes(i.id))) throw new Error("member_view_mismatch");
    }
    return await finishPages(page, capture, "/collects/video/list/", select, { responseTimeout: timeout });
  } finally {
    pending?.cancel();
    evidence.pages = select();
  }
}
async function emptyFolderView(page, timeout) {
  // 只认收藏夹详情页的明确空状态；登录提示、加载中和无卡片均不能单独作为证据。
  const empty = page.getByText(/^(暂无收藏作品|暂无收藏视频|暂无作品|还没有收藏作品|还没有收藏视频)$/).filter({ visible: true });
  await empty.first().waitFor({ timeout });
  const visibleItems = await page.locator("li:visible").filter({
    has: page.locator("a[href*='/video/']:visible, a[href*='/note/']:visible")
  }).count();
  return { emptyText: await empty.first().innerText(), visibleItems };
}
const fatalMemberError = error => /^(platform_forbidden|account_changed|account_not_logged_in|account_scope_mismatch|destination_disappeared|destination_ambiguous|invalid_folder_ids)/.test(error.message);

// 扫描、执行前排重、写后读回都使用同一恢复边界。恢复只新建读取页，不操作平台成员。
export async function readFolderMembers({ page, capture, folder, accountId,
  onRecovery = async () => {}, responseTimeout = 12_000, readinessTimeout = 30_000 }) {
  if (!folder.id) throw new Error("invalid_folder_ids");
  if (!accountId || folder.owner !== accountId) throw new Error("account_scope_mismatch");
  await capture.flush();
  assertMemberScope(capture.records, accountId);
  const initialPages = memberPages(capture.records, folder.id);
  const result = (pages, source, extra = {}) => {
    const items = unique(pages, "items");
    return { ...folder, pages, items, readable: items.length, memberSource: source, ...extra };
  };
  let reason;
  try { return result(proveMemberPages(initialPages), "prefetch"); }
  catch (error) { reason = error.message; }
  const recovery = { folderId: folder.id, reason, initialPages, attempts: [] };
  // 普通未预加载/非空未翻完先在当前目录内读取，避免每个大夹都重建页面。
  if (!initialPages.length || initialPages.every(p => p.status === 200 && p.code === 0 &&
      !p.error && p.itemsType === "array" && p.items?.length)) {
    const reading = { mode: "current_page" };
    try {
      const chain = await clickedMembers(page, capture, folder, reading, responseTimeout);
      assertMemberScope(capture.records, accountId);
      const proven = proveMemberPages(chain);
      await page.getByText("返回", { exact: true }).click();
      return result(proven, "clicked");
    } catch (error) {
      if (fatalMemberError(error)) throw error;
      reading.error = error.message;
      recovery.currentRead = reading;
      if (await page.getByText("返回", { exact: true }).isVisible()) {
        await page.getByText("返回", { exact: true }).click();
      }
    }
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const evidence = { attempt, at: new Date().toISOString() };
    recovery.attempts.push(evidence);
    let freshPage, freshCapture, restored, failure;
    try {
      freshPage = await page.context().newPage();
      freshPage.setDefaultTimeout(responseTimeout);
      const opened = await openSelfPage(freshPage, { expectedAccountId: accountId, readinessTimeout });
      freshCapture = opened.capture;
      evidence.account = opened.account;
      evidence.folderPages = await finishPages(freshPage, freshCapture, "/collects/list/",
        () => collect(freshCapture.records, "/collects/list/"));
      const folders = unique(evidence.folderPages, "folders");
      if (folders.some(f => !f.id)) throw new Error("invalid_folder_ids");
      if (folders.some(f => f.owner !== accountId)) throw new Error("account_scope_mismatch");
      const freshFolder = folders.find(f => f.id === folder.id);
      if (!freshFolder) throw new Error("destination_disappeared");
      if (folders.filter(f => f.name === freshFolder.name).length !== 1) throw new Error("destination_ambiguous");
      evidence.folder = freshFolder;
      const chain = await clickedMembers(freshPage, freshCapture, freshFolder, evidence, responseTimeout);
      let emptyEvidence;
      if (!unique(chain, "items").length && freshFolder.total === 0) {
        evidence.view = await emptyFolderView(freshPage, responseTimeout);
        emptyEvidence = { ...evidence.view, clickMark: evidence.clickMark, folderId: folder.id,
          accountId, folderTotal: freshFolder.total };
      }
      const proven = proveMemberPages(chain, emptyEvidence);
      assertRecoveredPages(recovery, proven);
      assertMemberScope(freshCapture.records, accountId);
      evidence.status = emptyEvidence ? "confirmed_empty" : "recovered";
      restored = result(proven, evidence.status, { recovery, ...(emptyEvidence ? { emptyEvidence } : {}) });
    } catch (error) {
      freshCapture ??= error.capture;
      evidence.status = "failed";
      evidence.error = error.message;
      failure = error;
    } finally {
      freshCapture?.stop();
      await freshPage?.close();
      await freshCapture?.flush();
      evidence.records = freshCapture?.records ?? [];
      try { assertMemberScope(evidence.records, accountId); } catch (error) {
        evidence.status = "failed";
        evidence.error = error.message;
        failure = error;
        restored = undefined;
      }
      await onRecovery(recovery);
    }
    if (restored) return restored;
    if (fatalMemberError(failure)) { failure.recovery = recovery; throw failure; }
  }
  const error = new Error(`folder_members_unverified:${folder.id}`);
  error.recovery = recovery;
  throw error;
}

async function main() {
  const output = process.argv[2] ?? "snapshot.json";
  if (!/^[a-zA-Z0-9_-]+\.json$/.test(output)) throw new Error("invalid_output_filename");
  const { page } = await connect();
  let capture, account;
  try {
    ({ capture, account } = await openSelfPage(page, { expectedAccountId: process.env.COLLECTION_ACCOUNT_ID }));
    if (process.env.COLLECTION_DATA_DIR)
      await recordAccountLogin(process.env.COLLECTION_DATA_DIR, account, process.env.COLLECTION_ACCOUNT_ID);
    await page.getByRole("tab", { name: "收藏夹", exact: true }).waitFor();
    await capture.flush();
    const pages = await finishPages(page, capture, "/collects/list/",
      () => collect(capture.records, "/collects/list/"));
    const folders = unique(pages, "folders");
    if (folders.some(f => !f.id)) throw new Error("invalid_folder_ids");
    if (folders.some(f => f.owner !== account.id)) throw new Error("account_scope_mismatch");
    await save("folder-snapshot.json", { at: new Date().toISOString(), folders, pages });
    console.log(JSON.stringify({ phase: "folders", folders }));
    const members = [];
    const recoveries = {};
    for (const folder of folders) {
      const member = await readFolderMembers({ page, capture, folder, accountId: account.id,
        onRecovery: async recovery => {
          recoveries[folder.id] = recovery;
          await save("member-recovery.json", { at: new Date().toISOString(), recoveries });
        } });
      members.push(member);
      console.log(JSON.stringify({ phase: "members", folder: folder.name, readable: member.readable,
        displayed: folder.total, source: member.memberSource }));
      await save("member-snapshot.json", { at: new Date().toISOString(), members, complete: members.length === folders.length });
    }
    await trigger(page, "/aweme/listcollection/", () => page.getByRole("tab", { name: "视频", exact: true }).click());
    const favoritePages = await finishPages(page, capture, "/aweme/listcollection/",
      () => collect(capture.records, "/aweme/listcollection/"));
    const favorites = unique(favoritePages, "items");
    const filed = new Set(members.flatMap(f => f.items.map(i => i.id)));
    const unclassified = favorites.filter(i => !filed.has(i.id));
    const snapshot = { at: new Date().toISOString(), account,
      scope: "all_readable_favorites", complete: true, folderPages: pages, folders: members,
      favoritePages, favorites, unclassified,
      invalidCount: favoritePages.reduce((sum, p) => sum + (p.invalid ?? 0), 0) };
    if (!snapshot.account?.id || folders.some(f => f.owner !== snapshot.account.id)) throw new Error("account_scope_mismatch");
    await save(output, snapshot);
    console.log(JSON.stringify({ phase: "complete", favorites: favorites.length, filed: favorites.length - unclassified.length,
      unclassified: unclassified.length, pages: favoritePages.length }));
  } catch (error) {
    capture ??= error.capture;
    if (process.env.COLLECTION_DATA_DIR) await recordAccountFailure(process.env.COLLECTION_DATA_DIR, error);
    throw error;
  } finally {
    await capture?.flush();
    await save("scan-checkpoint.json", { at: new Date().toISOString(), records: capture?.records ?? [] });
    capture?.stop();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
}
