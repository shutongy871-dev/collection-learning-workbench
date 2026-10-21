/**
 * background.js —— 稳定的“开门人”（不含任何平台按钮知识，长期不改动）
 *
 * 只负责保证收藏页这个“工位”是开着的，具体怎么干活全由：
 *   - content/driver.js 在收藏页常驻，向本地控制面领取动作
 *   - 本地控制面 driver 大脑决定下一步
 *
 * 触发源：每分钟 alarm 查询控制面是否有待办任务；有则打开收藏页。
 */

const API_BASE = "http://localhost:7788";
const COLLECTION_URL =
  "https://www.douyin.com/user/self?showTab=favorite_collection";

async function getDouyinTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.douyin.com/*" });
  return tabs[0] ?? null;
}

async function shouldRun() {
  try {
    const r = await fetch(`${API_BASE}/driver/should-run`);
    const j = await r.json();
    return Boolean(j.run);
  } catch {
    return false; // 控制面未启动
  }
}

/**
 * 确保收藏页在后台就绪；content 上线后会自动接管。
 * 铁律：绝不激活/切换标签页（active 一律 false 或不传），不打断用户当前页面。
 */
async function ensureOpen() {
  const tab = await getDouyinTab();
  if (!tab) {
    await chrome.tabs.create({ url: COLLECTION_URL, active: false }); // 后台打开，不抢焦点
  } else if (!tab.url.includes("/user/self")) {
    await chrome.tabs.update(tab.id, { url: COLLECTION_URL }); // 仅改地址，不激活
  }
  // 已在收藏页：什么都不做，尤其不能 active:true
}

async function healthStale() {
  try {
    const r = await fetch(`${API_BASE}/driver/health`);
    const j = await r.json();
    return Boolean(j.stale);
  } catch {
    return false;
  }
}

async function tick() {
  if (!(await shouldRun())) return;
  await ensureOpen();
  // 执行器卡死（超时未上报）时自动刷新标签，自愈无需用户介入
  if (await healthStale()) {
    const tab = await getDouyinTab();
    if (tab) chrome.tabs.reload(tab.id);
  }
}

chrome.alarms.create("driverTick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "driverTick") tick();
});

chrome.runtime.onStartup.addListener(tick);

chrome.runtime.onInstalled.addListener(async () => {
  // 让早已打开的抖音页重新加载一次，以便注入新版 content script（仅安装时自动做一次）
  const tab = await getDouyinTab();
  if (tab) chrome.tabs.reload(tab.id);
  tick();
});

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.kind !== "run_now") return;
  // 主动触发：若无待办任务则先建一个，再打开收藏页（content 上线自动接管）
  try {
    const j = await (await fetch(`${API_BASE}/driver/should-run`)).json();
    if (!j.run) {
      await fetch(`${API_BASE}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trigger: "manual" })
      });
    }
  } catch { /* 控制面未启动则仅打开页面 */ }
  ensureOpen();
});
