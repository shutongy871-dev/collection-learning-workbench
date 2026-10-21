/**
 * driver.js —— 通用浏览器执行器（ISOLATED world，平台无关，长期稳定不改动）
 *
 * 只做三件事，不含任何“抖音按钮叫什么”的知识：
 *   1. 看：采集页面可点元素(actions)、视频卡片(cards)、登录原始信号(signals)
 *   2. 传：向控制面 POST /driver/report，透传页面网络读/写原始报文
 *   3. 做：执行控制面返回的指令 click / scrollTo / scrollBottom / key / replay / done
 *
 * 所有“下一步点哪、接口字段怎么解析、是否登录失效”的判断都在控制面，
 * 因此大脑迭代只需重启本地服务，无需重新加载本插件。
 */

const TAG = "__collection_agent_net__";
const API_BASE = "http://localhost:7788";
const LOOP_MS = 900;
const IDLE_MS = 5000;
const CONTENT_VERSION = "2026-10-11a"; // 浏览器采集/点击修复需要重载扩展才生效

let idMap = new Map();
let seq = 0;
let running = false;
let looping = false;
let lastLoopAt = 0;
let stopReason = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 设备身份 ------------------------------ */

async function getDeviceId() {
  const stored = await chrome.storage.local.get("deviceId");
  if (stored.deviceId) return stored.deviceId;
  const deviceId = "dev_" + crypto.randomUUID().replace(/-/g, "").slice(0, 14);
  await chrome.storage.local.set({ deviceId });
  return deviceId;
}

async function registerDevice(deviceId) {
  try {
    await fetch(`${API_BASE}/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId,
        name: `${navigator.platform} · ${navigator.userAgent.includes("Windows") ? "Win" : "Mac"}`,
        supports: ["douyin"]
      })
    });
  } catch (_) { /* 服务可能未启动 */ }
}

/* ------------------------------ 看：DOM 采集 ------------------------------ */

function isVisible(el) {
  const b = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return b.width > 0 && b.height > 0 && s.display !== "none" && s.visibility !== "hidden";
}

function labelOf(el) {
  const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return t || el.getAttribute("aria-label") || el.getAttribute("title") || "";
}

function registerEl(el) {
  const id = `e${seq++}`;
  idMap.set(id, el);
  return id;
}

function collectActions() {
  const actions = [];
  const labelCount = new Map();
  const push = (el) => {
    if (!isVisible(el)) return;
    const label = labelOf(el);
    if (!label || label.length > 20) return;
    const n = (labelCount.get(label) ?? 0) + 1;
    labelCount.set(label, n);
    if (n > 5) return;
    const b = el.getBoundingClientRect();
    actions.push({
      id: registerEl(el),
      label,
      x: Math.round(b.x),
      y: Math.round(b.y),
      w: Math.round(b.width),
      h: Math.round(b.height)
    });
  };

  // 1) 语义/样式像按钮的元素
  document
    .querySelectorAll(
      'button, [role="button"], [aria-label], a, [class*="button" i], [class*="btn" i], [class*="action" i]'
    )
    .forEach(push);

  // 2) 平台无关兜底：叶子短文本 + 鼠标手型（覆盖无按钮样式的文字入口，如“批量管理”）
  const seenEl = new Set(actions.map((a) => idMap.get(a.id)));
  for (const el of document.querySelectorAll("span, div, p, li")) {
    if (el.children.length !== 0 || seenEl.has(el)) continue;
    const t = (el.textContent ?? "").trim();
    if (!t || t.length > 12) continue;
    if (getComputedStyle(el).cursor !== "pointer") continue;
    push(el);
  }
  return actions;
}

function collectCards() {
  const cards = [];
  const seen = new Set();
  const anchors = document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]');

  for (const a of anchors) {
    const m = a.href.match(/(?:video|note)\/(\d{6,})/);
    if (!m) continue;
    const itemId = m[1];
    if (seen.has(itemId)) continue;

    const box =
      a.closest('li, [class*="card" i], [class*="item" i], [class*="aweme" i]') ??
      a.parentElement?.parentElement ??
      a.parentElement;
    if (!box || !isVisible(box)) continue;

    const b = box.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    seen.add(itemId);

    // 卡片本体（封面 a 常无文字，actions 采集会漏掉，这里显式登记，供大脑点击）
    const cardId = registerEl(a);

    // 选择圆圈：扩大匹配（含 select/check），只取“小尺寸可见”的那个
    let checkboxId = null;
    let checked = false;
    let cb = null;
    const candidates = box.querySelectorAll(
      '.semi-checkbox, [class*=checkbox i], [class*="check-circle" i], [class*="circle-check" i], [class*="check" i], [class*="select" i], [role=checkbox], [role=radio]'
    );
    for (const e of candidates) {
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.width <= 48 && r.height > 0 && r.height <= 48) {
        cb = e;
        break;
      }
    }
    if (cb) {
      const clickable = cb.closest('[class*=checkbox i], [class*=select i], [role=checkbox], label') ?? cb;
      checkboxId = registerEl(clickable);
      const cls = (clickable.className || "").toString();
      checked =
        /(?:^|[\s_-])(checked|selected|active)(?:$|[\s_-])/i.test(cls) ||
        clickable.getAttribute("aria-checked") === "true" ||
        clickable.querySelector('input:checked') !== null;
    }

    // 左上角元素（通用兜底：批量模式选择圈几乎总位于卡片左上）
    let cornerId = null;
    try {
      const corner = document.elementFromPoint(b.x + 20, b.y + 20);
      if (corner && box.contains(corner)) cornerId = registerEl(corner);
    } catch { /* ignore */ }

    cards.push({
      itemId,
      cardId,
      checkboxId,
      cornerId,
      checked,
      hasCheckbox: Boolean(cb),
      x: Math.round(b.x),
      y: Math.round(b.y),
      w: Math.round(b.width),
      h: Math.round(b.height)
    });
  }
  return cards;
}

function collectLoginSignals() {
  return {
    urlHasLogin: /login|passport/.test(location.href),
    hasQr: Boolean(document.querySelector(
      'canvas, img[src*="qr" i], [class*="qrcode" i], [class*="qr-code" i]')),
    hasLoginPanel: Boolean(document.querySelector(
      '[data-e2e*="login" i], [class*="login-container" i], [class*="loginPanel" i]'))
  };
}

/* ------------------------------ 传：网络报文透传 ------------------------------ */

function collectNet() {
  return new Promise((resolve) => {
    const reads = new Map();
    const writes = [];

    const onMsg = (event) => {
      const d = event.data;
      if (!d || d.__agent !== TAG || !d.replay) return;
      if (d.phase === "read" && d.data) {
        reads.set(d.url, { url: d.url, data: d.data, status: d.status, v: d.v, capturedAt: d.capturedAt, truncated: d.truncated }); // 同 url 保留最新
      } else if (d.phase === "write") {
        writes.push({ url: d.url, method: d.method, body: d.body });
      }
    };
    window.addEventListener("message", onMsg);
    window.postMessage({ __agent: TAG, cmd: "replay" }, "*");

    setTimeout(() => {
      window.removeEventListener("message", onMsg);
      resolve({ reads: [...reads.values()].slice(-8), writes: writes.slice(-12) });
    }, 350);
  });
}

/* ------------------------------ 做：指令执行 ------------------------------ */

function realClick(el) {
  const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  if (typeof el.click === "function") el.click();
  else el.dispatchEvent(new MouseEvent("click", opts));
}

async function execCommand(cmd) {
  switch (cmd.op) {
    case "click": {
      const el = idMap.get(cmd.id);
      if (el) {
        el.scrollIntoView({ block: "center" });
        await sleep(120);
        realClick(el);
      }
      break;
    }
    case "clickAt": {
      // 视口坐标点击（大脑已用 scrollTo 把目标滚入视野，不再 scrollIntoView 以免错位）
      const el = document.elementFromPoint(cmd.x, cmd.y);
      if (el) {
        await sleep(80);
        realClick(el);
      }
      break;
    }
    case "scrollTo":
      window.scrollBy({ top: cmd.y - window.innerHeight / 2, behavior: "instant" });
      break;
    case "scrollBottom":
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      break;
    case "key":
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: cmd.key ?? "Escape",
        keyCode: cmd.key === "Enter" ? 13 : 23,
        bubbles: true
      }));
      break;
    case "replay":
      // 下一轮 collectNet 自然会 replay；这里无需动作
      break;
    case "done":
      // 本轮动作序列结束，不彻底退出，回到待命轮询；有新任务/登录恢复时自动接上
      stopReason = cmd.reason ?? "done";
      break;
    case "idle":
    case "noop":
    default:
      break;
  }
}

/* ------------------------------ 主循环（崩溃自愈） ------------------------------ */

function onCollectionPage() {
  return location.pathname.includes("/user/self");
}

/** 把运行时错误尽力上报（不保证成功），便于排查而非静默死亡 */
async function reportError(deviceId, where, err) {
  try {
    await fetch(`${API_BASE}/driver/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        v: CONTENT_VERSION,
        deviceId,
        url: location.href,
        clientError: { where, message: String(err?.message ?? err), at: Date.now() },
        dom: { actions: [], cards: [] },
        net: { reads: [], writes: [] },
        loginSignals: { urlHasLogin: false, hasQr: false, hasLoginPanel: false }
      })
    });
  } catch { /* ignore */ }
}

async function loop(deviceId) {
  if (looping) return;
  looping = true;

  while (running) {
    try {
      lastLoopAt = Date.now();

      if (!onCollectionPage()) {
        await sleep(IDLE_MS);
        continue;
      }

      idMap = new Map();
      seq = 0;

      const net = await collectNet();
      const report = {
        v: CONTENT_VERSION,
        deviceId,
        url: location.href,
        dom: { actions: collectActions(), cards: collectCards() },
        net,
        loginSignals: collectLoginSignals()
      };

      let resp;
      try {
        const r = await fetch(`${API_BASE}/driver/report`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(report)
        });
        resp = await r.json();
      } catch {
        await sleep(IDLE_MS);
        continue;
      }

      await execCommand(resp.command ?? { op: "noop" });
      const op = resp.command?.op;
      await sleep(op === "idle" || op === "done" ? IDLE_MS : LOOP_MS);
    } catch (err) {
      // 关键：任何采集/执行异常都不得终结循环
      await reportError(deviceId, "loop", err);
      await sleep(IDLE_MS);
    }
  }

  looping = false;
}

function startLoop(deviceId) {
  running = true;
  stopReason = null;
  loop(deviceId);
}

/* ------------------------------ 启动 ------------------------------ */

(async function init() {
  const deviceId = await getDeviceId();
  await registerDevice(deviceId);

  setInterval(() => {
    fetch(`${API_BASE}/devices/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId })
    }).catch(() => {});
  }, 60_000);

  // content 可被 popup/background 通过消息唤起
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.kind === "execute" && !running) startLoop(deviceId);
  });

  // 全局未捕获错误：尝试上报（不让页面静默）
  window.addEventListener("unhandledrejection", (e) =>
    reportError(deviceId, "promise", e.reason));
  window.addEventListener("error", (e) =>
    reportError(deviceId, "window", e.message));

  // 看门狗：即使 loop 因意外退出，也在收藏页自动拉起
  setInterval(() => {
    if (onCollectionPage() && (!looping || Date.now() - lastLoopAt > 15_000)) {
      startLoop(deviceId);
    }
  }, 5000);

  // 若正停在收藏页，自动接管
  if (onCollectionPage()) startLoop(deviceId);
})();
