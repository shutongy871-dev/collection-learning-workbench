/**
 * feishu.mjs —— 飞书自定义机器人通道（群 Webhook）
 * 支持三类消息：纯文本、交互卡片（重登提醒 / 新文件夹决策 / 每日日报）
 * 注意：Webhook 机器人只可发消息；卡片按钮回执需要额外回调通道（见 docs/architecture 说明），
 *      当前阶段重登靠工具自动检测恢复，决策卡片先以"文字指令 + 编号"降级交互。
 */

export async function sendFeishu(webhook, message) {
  if (!webhook) throw new Error("feishu webhook 未配置");
  const body = message.type === "card"
    ? { msg_type: "interactive", card: message.card }
    : { msg_type: "text", content: { text: message.text } };

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  if (!res.ok) throw new Error(`飞书 HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== 0 && data.StatusCode !== 0) throw new Error(`飞书返回错误: ${data.msg ?? data.StatusMessage ?? "invalid response"}`);
  return data;
}

const header = (title, color) => ({
  title: { tag: "plain_text", content: title },
  template: color
});

/** 登录失效提醒：工具检测到登录恢复后自动续跑 */
export function loginExpiredCard(platform) {
  return {
    config: { wide_screen_mode: true },
    header: header("需要重新登录 · 收藏整理已暂停", "red"),
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**平台**：${platform}\n请在电脑上打开对应平台网页版完成扫码登录，无需回复本消息。` } },
      { tag: "div", text: { tag: "lark_md", content: "登录成功后，任务将自动继续，完成后推送日报。" } }
    ]
  };
}

/**
 * L3 新文件夹决策：列出现有文件夹 + 推荐新名称
 * 降级交互：用户直接回复编号（如 "1" 或 "新建:XX"），回执通道打通后升级为按钮
 */
export function newFolderDecisionCard(item, folders, recommendation) {
  const folderLines = folders.map((f, i) => `${i + 1}. ${f.name}`).join("\n");
  return {
    config: { wide_screen_mode: true },
    header: header("收藏归类需要你决策", "orange"),
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**视频**：${item.title ?? item.desc ?? "(无标题)"}\n**作者**：${item.author ?? "-"}\n模型判断：现有文件夹均不合适。` } },
      { tag: "hr" },
      { tag: "div", text: { tag: "lark_md", content: `**现有文件夹**\n${folderLines || "(暂无)"}\n\n**推荐新文件夹名**：${recommendation}` } },
      { tag: "note", elements: [{ tag: "plain_text", content: "回复编号归入已有文件夹；回复「新建:名称」创建新文件夹" }] }
    ]
  };
}

/** 每日整理日报 */
export function dailyReportCard(report) {
  const dist = Object.entries(report.distribution ?? {})
    .map(([name, n]) => `- ${name}：${n} 条`)
    .join("\n");
  return {
    config: { wide_screen_mode: true },
    header: header(`收藏整理日报 · ${report.date}`, report.delayed ? "yellow" : "green"),
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**共整理**：${report.itemsDone} 条\n**待你决策**：${report.itemsNeedHuman} 条\n**失败**：${report.itemsFailed} 条${report.delayed ? "\n_注：本次延迟启动，整理范围为运行时全部未分类收藏_" : ""}` } },
      { tag: "hr" },
      { tag: "div", text: { tag: "lark_md", content: dist || "_无自动归类记录_" } }
    ]
  };
}
