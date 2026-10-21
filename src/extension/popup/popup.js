/**
 * popup.js —— 插件弹窗逻辑
 */
const SERVICE = "http://localhost:7788";

const $ = (id) => document.getElementById(id);

async function refresh() {
  try {
    const health = await (await fetch(`${SERVICE}/status`)).json();
    if (!health.ok) throw new Error("服务不可用");
    $("dot").classList.add("ok");
    $("status").textContent = "已连接";

    const devices = await (await fetch(`${SERVICE}/devices`)).json();
    const { deviceId } = await chrome.storage.local.get("deviceId");
    const current = devices.find((d) => d.deviceId === deviceId);
    $("deviceId").textContent = current ? current.name : deviceId ?? "-";
    const tasks = await (await fetch(`${SERVICE}/tasks`)).json();
    const latest = tasks[0];
    const reasons = {
      unclassified_scope_unverified: "尚未完成所有收藏夹的成员扫描，无法确认哪些视频未分类。",
      manage_entry_exhausted: "无法进入批量管理，已停止。",
      destination_readback_missing: "尚未确认视频进入目标收藏夹，已停止重复操作。",
      step_timeout: "操作没有进展，已停止。",
      scan_timeout: "没有取得完整收藏数据，已停止。"
    };
    $("taskState").textContent = latest
      ? `最近任务：${latest.status}，确认成功 ${latest.itemsDone ?? 0} 条。${reasons[latest.blockedReason] ?? ""}`
      : "尚无任务。";
  } catch (_) {
    $("status").textContent = "未运行";
  }

  try {
    const config = await (await fetch(`${SERVICE}/config`)).json();
    $("webhook").value = config.feishuWebhook ?? "";
  } catch (_) { /* ignore */ }
}

$("runNow").addEventListener("click", () => {
  chrome.runtime.sendMessage({ kind: "run_now" }, () => window.close());
});

$("openPage").addEventListener("click", () => {
  chrome.tabs.create({
    url: "https://www.douyin.com/user/self?showTab=favorite_collection"
  });
});

$("saveWebhook").addEventListener("click", async () => {
  try {
    const webhook = $("webhook").value.trim();
    const saved = await fetch(`${SERVICE}/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feishuWebhook: webhook })
    });
    if (!saved.ok) throw new Error("保存失败");
    const response = await fetch(`${SERVICE}/notify/test`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "发送失败");
    $("notifyState").textContent = "飞书已接受测试消息。";
  } catch (error) {
    $("notifyState").textContent = `测试未成功：${error.message}`;
  }
});

refresh();
