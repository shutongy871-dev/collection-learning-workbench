/**
 * driver.mjs —— 浏览器驾驶大脑（控制面侧，可自主迭代，无需改动/重载插件）
 *
 * 设计原则：
 *  - 插件只做通用执行器（上报 DOM/网络，执行 click/scroll/key），不含平台知识
 *  - "下一步点哪个"全部由本文件的状态机 decide() 决定；出错改这里 + 重启服务即可
 *  - decide 是纯函数：(session, report) -> command，便于用 mock 证据做自动化测试
 *
 * 状态流转：
 *   start -> scan(取网络数据) -> manage(进批量管理)
 *   -> item(勾选→移动→选夹→验证) -> between(真人节奏) -> ... -> finish
 */

import { classifyByKeyword } from "./classify.mjs";
import { nowIso } from "./store.mjs";

const ITEM_GAP_MS = 7000;          // 每条之间最小间隔（真人节奏）

/* ------------------------------ 平台 UI 规则（易变，集中维护） ------------------------------ */

const UI = {
  manage: /批量管理|批量操作|^管理/,
  // 管理模式的“退出/完成”入口（管理专有用词，避免正常页误判）
  cancelManage: /取消管理|完成管理|退出管理|退出批量|完成批量/,
  // 精确的移动入口；bare “移动”不再用于判定，仅在确认勾选后宽松寻找
  moveStrong: /移动到收藏夹|移至收藏夹|归入收藏夹/,
  move: /移动到收藏夹|移至收藏夹|归入收藏夹|移动|移至|归入/,
  subFolderTab: /^收藏夹$/,
  subtabVideo: /^视频$/,
  success: /移动成功|已移动|收藏成功/
};

/** 是否确实处于批量管理模式：以“卡片出现勾选框”为准，管理专有退出按钮为辅 */
function detectManage(report) {
  const cards = report?.dom?.cards ?? [];
  const cbCount = cards.filter((c) => c.hasCheckbox).length;
  const cancel = byLabel(report, UI.cancelManage);
  const mode = cbCount > 0 || Boolean(cancel);
  return { mode, cbCount, cancel };
}

/* ------------------------------ Session ------------------------------ */

export function createSession(task, rules) {
  return {
    taskId: task.id,
    platform: task.platform,
    scope: "all_unclassified",
    rules,
    step: "start",
    subStep: 0,
    items: [],
    cursor: 0,
    done: 0,
    failed: 0,
    needHuman: 0,
    distribution: {},
    writesSeen: 0,
    nextItemAt: 0,
    status: "running",
    log: [],
    lastReport: null
  };
}

const logTo = (s, message) => {
  s.log.push({ at: nowIso(), message });
  if (s.log.length > 100) s.log.shift();
};

/* ------------------------------ 会话持久化（重启不“失忆”） ------------------------------ */

const PERSIST_KEYS = [
  "step", "subStep", "items", "cursor", "done", "failed", "needHuman",
  "distribution", "writesSeen", "status", "manageStuck", "subStepRetry",
  "nextItemAt", "scanTries", "manageClicks", "manageObserve", "manageTried",
  "findScroll", "selectTries", "blockedReason", "verifyAfter", "waitKey", "waitLoops"
];

export function exportSession(s) {
  const out = {};
  for (const k of PERSIST_KEYS) out[k] = s[k];
  return out;
}

export function hydrateSession(s, saved) {
  if (!saved || typeof saved !== "object") return s;
  for (const k of PERSIST_KEYS) {
    if (saved[k] !== undefined) s[k] = saved[k];
  }
  return s;
}

/* ------------------------------ DOM 小工具 ------------------------------ */

const byLabel = (report, re) =>
  report?.dom?.actions?.find((a) => re.test(a.label)) ?? null;

const allByLabel = (report, re) =>
  report?.dom?.actions?.filter((a) => re.test(a.label)) ?? [];

const cardOf = (report, itemId) =>
  report?.dom?.cards?.find((c) => c.itemId === itemId) ?? null;

/* ------------------------------ 主决策（纯函数） ------------------------------ */

/** 该读响应是否含视频列表，返回列表本体（无则 null） */
function awemeListOf(u, data) {
  if (/familiar|follow|feed|hot|recommend/.test(u)) return null; // 非收藏流
  const list = data?.aweme_list ?? data?.awemes;
  return Array.isArray(list) ? list : null;
}

/** 从接口 URL 提取分页 cursor（缺失给大数，排在最后） */
const cursorOf = (u) => {
  const m = /[?&]cursor=(\d+)/.test(u ?? "") ? Number(u.match(/[?&]cursor=(\d+)/)[1]) : Number.MAX_SAFE_INTEGER;
  return m;
};

/** 是否为“主收藏（未分类）列表”接口；夹内视频请求会带 collects_id(s)，需排除 */
const isMainListUrl = (u) => {
  if (/listcollection/i.test(u)) return true;
  if (/collects\/video\/list/.test(u)) return !/[?&]collects_ids?=/.test(u);
  return false;
};

/** 接口短标签（诊断用） */
const apiTag = (u) => (/listcollection/i.test(u) ? "L" : "V");

/** 把单个 aweme 归一化为标准 item */
function toItem(a) {
  return {
    id: String(a.aweme_id ?? a.id),
    title: a.desc ?? "",
    author: a.author?.nickname ?? "",
    hashtags: (a.text_extra ?? []).map((t) => t.hashtag_name).filter(Boolean),
    cover:
      a.video?.cover?.url_list?.[0] ??
      a.video?.origin_cover?.url_list?.[0] ??
      "",
    duration: a.video?.duration ?? 0
  };
}

/** 把插件透传的原始读/写报文，解析成大脑使用的标准 net（平台知识集中处，可自主迭代） */
export function normalizeNet(net) {
  const reads = net?.reads ?? [];
  const writes = net?.writes ?? [];
  let folders = [];
  // 主收藏（未分类）各分页响应；夹内视频响应单独记录，不混入主列表
  const mainPages = [];

  for (const r of reads) {
    const u = r.url ?? "";
    const data = r.data;

    // 收藏夹列表
    if (u.includes("collects/list") && !u.includes("video/list")) {
      const list = data?.collects_list ?? data?.collects ?? [];
      folders = list.map((f) => ({
        id: f.collects_id,
        name: f.name,
        total: f.total ?? f.aweme_count ?? 0
      }));
    }

    const list = awemeListOf(u, data);
    if (!list || !isMainListUrl(u)) continue;
    mainPages.push({ u, tag: apiTag(u), cursor: cursorOf(u), list, hasMore: Boolean(data?.has_more) });
  }

  // 按 cursor 升序合并、按 ID 去重（cursor 小=最新，页面顶部已渲染）
  mainPages.sort((p, q) => p.cursor - q.cursor);
  const items = [];
  const seenId = new Set();
  let hasMore = false;
  for (const p of mainPages) {
    hasMore = hasMore || p.hasMore;
    for (const a of p.list) {
      const item = toItem(a);
      if (seenId.has(item.id)) continue;
      seenId.add(item.id);
      items.push(item);
    }
  }

  // 诊断：每分页接口标签/cursor/条数，以及所有读接口形态
  const pages = mainPages.map((p) => ({
    t: p.tag,
    c: p.cursor === Number.MAX_SAFE_INTEGER ? "-" : p.cursor,
    n: p.list.length
  }));
  const shapes = reads.map((r) => ({
    u: String(r.url ?? "").replace(/^https?:\/\/[^/]+/, "").slice(0, 64),
    v: r.v ?? "",
    keys: r.data && typeof r.data === "object" ? Object.keys(r.data).slice(0, 15) : []
  }));

  return {
    folders,
    items,
    writes,
    // “视频”是全部收藏，不是未分类。必须由完整的收藏夹清单做差集后才允许写入。
    scope: "all_favorites",
    videoListSeen: mainPages.length > 0,
    hasMore,
    reads,
    _diag: { pages, shapes }
  };
}

const isLoginExpired = (report) => {
  const sig = report?.loginSignals;
  if (!sig) return false;
  return Boolean(sig.urlHasLogin) || Boolean(sig.hasLoginPanel && sig.hasQr);
};

export function decide(session, report) {
  if (session.status === "blocked") return { op: "done", reason: session.blockedReason };
  if (session.platform !== "douyin") return block(session, "platform_not_implemented");
  const waitKey = `${session.step}:${session.subStep}:${session.cursor}`;
  session.waitLoops = session.waitKey === waitKey ? (session.waitLoops ?? 0) + 1 : 0;
  session.waitKey = waitKey;
  if (session.waitLoops > 35) return block(session, "step_timeout");
  session.lastReport = {
    url: report?.url,
    loginExpired: isLoginExpired(report),
    nActions: report?.dom?.actions?.length ?? 0,
    nCards: report?.dom?.cards?.length ?? 0,
    netItems: report?.net?.items?.length ?? 0
  };

  // 登录失效：停下并交上层发飞书
  if (isLoginExpired(report)) {
    session.status = "login_expired";
    return { op: "done", reason: "login_expired" };
  }

  // 退出保护：若已进入 item/between 却检测不到管理模式（误判/被关闭），退回 manage 重建
  if ((session.step === "item" || session.step === "between") && !detectManage(report).mode) {
    logTo(session, "检测到已不在批量管理模式，退回 manage 重新进入");
    session.step = "manage";
    session.subStep = 0;
    session.manageObserve = 0;
    session.manageClicks = 0;
    session.manageTried = [];
    session.manageStuck = 0;
    return stepManage(session, report);
  }

  switch (session.step) {
    case "start":
      return stepScan(session, report);

    case "scan":
      return stepScan(session, report);

    case "manage":
      return stepManage(session, report);

    case "item":
      return stepItem(session, report);

    case "between":
      if (Date.now() < session.nextItemAt) return { op: "noop" };
      return stepItem(session, report);

    case "finish":
      return { op: "done", result: summarize(session) };

    default:
      return { op: "done", reason: "unknown_step" };
  }
}

/* ---------- 扫描：拿到未分类视频列表 ---------- */

function stepScan(s, report) {
  s.step = "scan";
  const net = report?.net;

  // 先索要网络缓冲
  if (s.subStep === 0) {
    s.subStep = 1;
    return { op: "replay" };
  }

  // 有数据：固化进 session
  if (net?.videoListSeen && net.items?.length) {
    if (net.scope !== "unclassified_verified") {
      return block(s, "unclassified_scope_unverified");
    }
    // 固化本轮扫描得到的完整待办集合；执行节奏与任务总范围分离。
    // 不按发布时间、收藏日期、上次成功时间或固定条数截断积压。
    s.items = [...net.items];
    s.writesSeen = net.writes?.length ?? 0;
    s.step = "manage";
    s.subStep = 0;
    s.scanTries = 0;
    const pages = (net._diag?.pages ?? []).map((p) => `${p.t}${p.c}:${p.n}`).join(",");
    logTo(s, `扫描到 ${s.items.length} 条待整理（合并分页=[${pages}]，去重后共${net.items.length}）`);
    return decide(s, report);
  }

  // 无数据：切子 tab 强制重发（收藏夹 -> 视频），分步进行
  if (s.subStep === 1) {
    const folderTab = byLabel(report, UI.subFolderTab);
    if (folderTab) {
      s.subStep = 2;
      return { op: "click", id: folderTab.id };
    }
    s.subStep = 3; // 找不到就直接尝试点视频
  }
  if (s.subStep === 2) {
    const videoTab = byLabel(report, UI.subtabVideo);
    if (videoTab) {
      s.subStep = 1;
      return { op: "click", id: videoTab.id };
    }
  }

  // 诊断 + 熔断：长时间拿不到列表，记录原始报文形态并结束（而非静默空转）
  s.scanTries = (s.scanTries ?? 0) + 1;
  if (s.scanTries % 6 === 1) {
    const shapes = net?._diag?.shapes ?? [];
    const desc = shapes
      .map((h) => `${h.u}[${h.keys.join(",")}]`)
      .join(" || ");
    logTo(
      s,
      `扫描无果 videoListSeen=${net?.videoListSeen} reads=${shapes.length} 动作数=${report?.dom?.actions?.length} 报文=${desc || "（无读接口缓冲）"}`
    );
  }
  if (s.scanTries > 30) {
    logTo(s, "扫描熔断：超过重试上限，结束本任务");
    s.step = "finish";
    return block(s, "scan_timeout");
  }

  // 兜底：滚动触发加载
  return { op: "scrollBottom" };
}

/* ---------- 管理：进入批量管理模式（点一次→观察，绝不反复点击） ---------- */

const MANAGE_OBSERVE_LOOPS = 4;
const MANAGE_MAX_CLICKS = 6;

/** 候选“批量管理”入口的稳定指纹（跨轮次 id 会变，用文本+坐标） */
const manageKey = (a) => `${a.label}@${a.x},${a.y}`;

/** 点击后观察页：把能证明“是否进入管理模式”的线索写进日志（含卡片/条目 ID 比对） */
function dumpManageSnapshot(s, report, prefix) {
  const actions = report?.dom?.actions ?? [];
  const relevant = actions
    .filter((a) => /管|批量|整理|移动|取消|完成|全选|删除/.test(a.label))
    .map((a) => `${a.label}(${a.x},${a.y})`);
  const cards = report?.dom?.cards ?? [];
  const cb = cards.filter((c) => c.hasCheckbox).length;
  const target = s.items[s.cursor];
  const cardIds = cards.map((c) => c.itemId).slice(0, 8).join(",");
  logTo(
    s,
    `${prefix} 勾选卡片=${cb}/${cards.length}；目标条目=${target?.id ?? "无"}；渲染卡片ID=[${cardIds}]；管理相关=[${relevant.slice(0, 16).join("|") || "无"}]`
  );
}

function stepManage(s, report) {
  const actions = report?.dom?.actions ?? [];
  const mg = detectManage(report);

  if (mg.mode) {
    logTo(s, `已在批量管理模式（勾选卡片=${mg.cbCount}${mg.cancel ? `，${mg.cancel.label}` : ""}）`);
    s.step = "item";
    s.subStep = 0;
    return decide(s, report);
  }

  s.manageClicks ??= 0;
  s.manageObserve ??= 0;
  s.manageTried ??= [];

  // 刚点过 → 先观察若干轮，不重复点击（避免把管理模式又点关）
  if (s.manageClicks > 0 && s.manageObserve < MANAGE_OBSERVE_LOOPS) {
    s.manageObserve += 1;
    dumpManageSnapshot(s, report, `观察${s.manageObserve}`);
    return { op: "noop" };
  }

  // 枚举可见的管理入口候选（有尺寸），选一个没试过的
  const cands = actions.filter(
    (a) =>
      a.w > 0 &&
      a.h > 0 &&
      (UI.manage.test(a.label) || /批量|管理/.test(a.label)) &&
      !UI.cancelManage.test(a.label)
  );
  // 同指纹去重，优先精确 UI.manage
  const uniq = [];
  const seenKey = new Set();
  for (const a of cands) {
    const k = manageKey(a);
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    uniq.push(a);
  }
  uniq.sort((p, q) => Number(UI.manage.test(q.label)) - Number(UI.manage.test(p.label)));
  const next = uniq.find((a) => !s.manageTried.includes(manageKey(a)));

  if (!next || s.manageClicks >= MANAGE_MAX_CLICKS) {
    s.manageStuck = (s.manageStuck ?? 0) + 1;
    if (s.manageStuck >= 12) return block(s, "manage_entry_exhausted");
    if (s.manageStuck % 3 === 1) {
      dumpManageSnapshot(s, report, "管理入口耗尽");
    }
    return { op: "noop" };
  }

  s.manageTried.push(manageKey(next));
  s.manageClicks += 1;
  s.manageObserve = 0;
  logTo(s, `点击批量管理入口#${s.manageClicks}：${next.label}(${next.x},${next.y})`);
  return { op: "click", id: next.id };
}

/* ---------- 单条：勾选 -> 移动 -> 选夹 -> 验证 ---------- */

function stepItem(s, report) {
  s.step = "item";
  const item = s.items[s.cursor];
  if (!item) return finish(s);

  const target = targetFolder(item, s);
  const card = cardOf(report, item.id);
  if (!target) {
    s.needHuman += 1;
    s.cursor += 1;
    s.subStep = 0;
    logTo(s, "未命中分类规则，保留收藏并等待人工分类");
    return { op: "noop" };
  }

  // 一次性盘点：批量模式下所有“小尺寸可点元素”（找选择圆圈），以及卡片/条目 ID
  if (!s.inventoryV2) {
    s.inventoryV2 = true;
    const cards = report?.dom?.cards ?? [];
    const small = (report?.dom?.actions ?? [])
      .filter((a) => a.w > 0 && a.w <= 48 && a.h > 0 && a.h <= 48)
      .map((a) => `${a.label || "·"}(${a.x},${a.y})`);
    const bar = (report?.dom?.actions ?? [])
      .filter((a) => /移动|删除|更多|全选|取消|退出|下载|分享/.test(a.label))
      .map((a) => `${a.label}(${a.x},${a.y},${a.w}x${a.h})`);
    logTo(
      s,
      `盘点 目标条目=${item.id}；卡片ID=[${cards.map((c) => c.itemId).slice(0, 8).join(",")}]；操作条=[${bar.slice(0, 20).join("|") || "无"}]；小元素=[${small.slice(0, 40).join("|") || "无"}]`
    );
  }

  // subStep 0：滚动找到卡片（目标可能在下方，需滚动加载，最多 25 屏）
  if (s.subStep === 0) {
    if (card) {
      s.findScroll = 0;
      s.subStep = 1;
      return { op: "scrollTo", x: card.x + card.w / 2, y: card.y + card.h / 2 };
    }
    s.findScroll ??= 0;
    if (s.findScroll >= 25) return failItem(s, report, "card_not_found");
    s.findScroll += 1;
    return { op: "scrollBottom" };
  }

  // subStep 1：选中卡片（点左上角/勾选圈/卡片本体），以底部“移动到收藏夹”出现为确认
  if (s.subStep === 1) {
    const otherSelected = (report.dom?.cards ?? []).some((c) => c.checked && c.itemId !== item.id);
    if (otherSelected) return block(s, "unexpected_selection");
    if (card?.checked) {
      s.selectTries = 0;
      s.subStep = 2;
      return decide(s, report);
    }
    const targetId = card?.checkboxId ?? card?.cornerId ?? card?.cardId ?? null;
    if (!card || !targetId) {
      s.subStep = 0; // 卡片未渲染，回滚重新找
      return { op: "noop" };
    }
    s.selectTries ??= 0;
    if (s.selectTries >= 4) return failItem(s, report, "select_failed");
    s.selectTries += 1;
    logTo(s, `尝试选中#${s.selectTries} 条目=${item.id}`);
    return { op: "click", id: targetId };
  }

  // subStep 2：点移动
  if (s.subStep === 2) {
    const moveBtn = byLabel(report, UI.moveStrong) ?? byLabel(report, UI.move);
    if (moveBtn) {
      s.subStep = 3;
      return { op: "click", id: moveBtn.id };
    }
    // 勾选态可能丢，退回勾选
    s.subStep = 1;
    return { op: "noop" };
  }

  // subStep 3：弹层选目标文件夹
  if (s.subStep === 3) {
    const folderHit = allByLabel(report, new RegExp(`^${escapeRe(target)}$`))[0];
    if (folderHit) {
      s.subStep = 4;
      s.verifyAfter = Date.now();
      s.writesSeen = report?.net?.writes?.length ?? s.writesSeen;
      return { op: "click", id: folderHit.id };
    }
    return { op: "noop" }; // 等弹层渲染
  }

  // subStep 4：验证
  if (s.subStep === 4) {
    const rule = classifyByKeyword(item, s.rules);
    // 只认可操作后目标夹的读取响应中包含本条 ID；请求发出、Toast、卡片消失都不算成功。
    const confirmed = (report.net?.reads ?? []).some((r) => {
      if (!rule.folderId || !s.verifyAfter || !(r.capturedAt > s.verifyAfter)) return false;
      if (!(r.status >= 200 && r.status < 300) || r.data?.status_code !== 0) return false;
      const url = new URL(r.url, "https://www.douyin.com");
      if (!url.pathname.includes("/collects/video/list")) return false;
      const folderId = url.searchParams.get("collects_id") ?? url.searchParams.get("collects_ids");
      if (folderId !== String(rule.folderId)) return false;
      return (r.data?.aweme_list ?? []).some((a) => String(a.aweme_id) === item.id);
    });
    if (confirmed) {
      return recordSuccess(s, target);
    }
    // 未知结果停止自动重写，避免在上一次可能已成功时再次操作。
    s.subStepRetry = (s.subStepRetry ?? 0) + 1;
    if (s.subStepRetry >= 8) return block(s, "destination_readback_missing");
    return { op: "noop" };
  }

  return { op: "noop" };
}

/* ---------- 结果记录 ---------- */

function targetFolder(item, s) {
  const r = classifyByKeyword(item, s.rules);
  if (r.decision === "folder") return r.folderName;
  return null;
}

function block(s, reason) {
  s.status = "blocked";
  s.blockedReason = reason;
  logTo(s, `任务阻塞: ${reason}`);
  return { op: "done", reason };
}

function recordSuccess(s, folder) {
  s.done += 1;
  s.distribution[folder] = (s.distribution[folder] ?? 0) + 1;
  s.cursor += 1;
  s.subStep = 0;
  s.subStepRetry = 0;
  s.nextItemAt = Date.now() + ITEM_GAP_MS;
  s.step = "between";
  return { op: "noop" };
}

function failItem(s, report, reason) {
  s.failed += 1;
  logTo(s, `条目失败: ${reason}（actions=${report?.dom?.actions?.length}）`);
  s.cursor += 1;
  s.subStep = 0;
  s.subStepRetry = 0;
  s.nextItemAt = Date.now() + ITEM_GAP_MS;
  s.step = "between";
  return { op: "noop" };
}

function finish(s) {
  s.step = "finish";
  s.status = "done";
  return { op: "done", result: summarize(s) };
}

export function summarize(s) {
  return {
    taskId: s.taskId,
    itemsTotal: s.items.length,
    itemsDone: s.done,
    itemsFailed: s.failed,
    itemsNeedHuman: s.needHuman,
    distribution: s.distribution
  };
}

const escapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
