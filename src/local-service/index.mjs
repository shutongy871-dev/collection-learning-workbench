/**
 * index.mjs —— 收藏整理 Agent · 本地控制面服务
 *
 * 职责：
 *  1. 对本机暴露 HTTP API（跨 agent：任何程序/agent 均可调用）
 *  2. 设备注册与心跳、任务队列（pending/claimed/running/done）
 *  3. 每日 09:00 定时生成任务；9 点无设备时不丢任务，设备上线补跑
 *  4. 接收执行器上报：登录失效 / 需人工决策 → 飞书通知；完成 → 飞书日报
 *
 * 默认端口 7788，可用环境变量 COLLECTION_AGENT_PORT 覆盖。
 */
import { createServer } from "node:http";
import { loadState, saveState, nowIso, genId } from "./store.mjs";
import { classifyByKeyword } from "./classify.mjs";
import { sendFeishu, loginExpiredCard, newFolderDecisionCard, dailyReportCard } from "./feishu.mjs";
import { createSession, decide, normalizeNet, exportSession, hydrateSession } from "./driver.mjs";
import { nextScheduledTask, scheduledTrigger } from "./schedule.mjs";

const PORT = Number(process.env.COLLECTION_AGENT_PORT ?? 7788);
const state = await loadState();

/* ------------------------------ Driver 会话（大脑侧，内存态） ------------------------------ */

let activeSession = null;
let activeTask = null;
let lastReportAt = 0;

/** 登录信号是否正常（未在登录页、无登录二维码面板） */
function loginLooksHealthy(report) {
  const sig = report?.loginSignals;
  if (!sig) return false;
  return !(sig.urlHasLogin || (sig.hasLoginPanel && sig.hasQr));
}

/** 取（或为最新待办任务创建/恢复）驾驶会话；无任务则返回空 */
function ensureSession(report) {
  if (activeSession && activeSession.status === "running" && activeTask?.status === "running") {
    return { session: activeSession, task: activeTask, fresh: false };
  }
  activeSession = null;
  activeTask = null;

  const open = [...state.tasks].reverse().find((t) =>
    t.platform === "douyin" && ["pending", "running", "claimed"].includes(t.status));

  let task = open;

  // 没有待办，但有“登录失效暂停”的任务，且页面已重新登录、确实加载出收藏卡片 → 自动续跑
  if (!task && loginLooksHealthy(report) && (report?.dom?.cards?.length ?? 0) > 0) {
    task = [...state.tasks].reverse().find((t) =>
      t.platform === "douyin" && t.status === "paused" && t.pauseReason === "login_expired") ?? null;
    if (task) pushLog(task, "login restored, auto resume");
  }

  if (!task) return { session: null, task: null, fresh: false };

  if (task.status === "pending" || task.status === "paused") {
    task.status = "running";
    task.claimedBy = "driver";
    task.startedAt ??= nowIso();
    pushLog(task, "claimed by driver");
  }
  activeTask = task;
  activeSession = createSession(task, state.config.rules);
  const hadSaved = Boolean(task._session);
  if (hadSaved) hydrateSession(activeSession, task._session); // 重启后恢复进度，不从头再来
  activeSession.status = "running";
  task.pauseReason = null;
  return { session: activeSession, task, fresh: true, hadSaved };
}

/* ------------------------------ HTTP 工具 ------------------------------ */

const json = (res, status, payload) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(payload));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 2_000_000) reject(new Error("body too large"));
  });
  req.on("end", () => {
    if (!raw) return resolve({});
    try { resolve(JSON.parse(raw)); } catch { reject(new Error("invalid JSON")); }
  });
  req.on("error", reject);
});

/* ------------------------------ 任务工具 ------------------------------ */

function createTask({ platform, trigger, delayed = false, scheduledFor = null, scheduleDate = null }) {
  const task = {
    id: genId("task"),
    platform,
    trigger,
    status: "pending",
    delayed,
    scope: "all_unclassified",
    scheduledFor,
    scheduleDate,
    createdAt: nowIso(),
    claimedBy: null,
    itemsTotal: 0,
    itemsDone: 0,
    itemsNeedHuman: 0,
    itemsFailed: 0,
    distribution: {},
    log: []
  };
  state.tasks.push(task);
  return task;
}

function pushLog(task, message) {
  task.log.push({ at: nowIso(), message });
  if (task.log.length > 200) task.log = task.log.slice(-200);
}

async function notifySafely(message) {
  if (!state.config.feishuWebhook) return;
  try {
    await sendFeishu(state.config.feishuWebhook, message);
  } catch (err) {
    console.error(`[feishu] ${err.message}`);
  }
}

/* ------------------------------ 路由 ------------------------------ */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (req.method === "OPTIONS") return json(res, 204, {});

    /* 基础 */
    if (route === "GET /status") {
      return json(res, 200, { ok: true, service: "collection-tidy-agent", time: nowIso(), port: PORT });
    }

    /* 配置 */
    if (route === "GET /config") return json(res, 200, state.config);
    if (route === "POST /config") {
      const body = await readBody(req);
      const patch = body.config ?? body;
      const next = { ...state.config, ...patch, llm: { ...state.config.llm, ...patch.llm },
        schedule: { ...state.config.schedule, ...patch.schedule } };
      if (next.platform !== "douyin") return json(res, 422, { error: "platform_not_implemented", platform: next.platform });
      scheduledTrigger({ ...next, schedule: { ...next.schedule, enabled: true } });
      state.config = next;
      await saveState(state);
      return json(res, 200, state.config);
    }

    /* 设备 */
    if (route === "GET /devices") return json(res, 200, state.devices);
    if (route === "POST /devices/register") {
      const body = await readBody(req);
      let device = state.devices.find((d) => d.deviceId === body.deviceId);
      if (!device) {
        device = { deviceId: body.deviceId, name: body.name ?? "unknown", platform: body.platform ?? "unknown", registeredAt: nowIso() };
        state.devices.push(device);
      }
      device.lastSeen = nowIso();
      device.supports = body.supports ?? device.supports ?? [];
      await saveState(state);
      return json(res, 200, device);
    }
    if (route === "POST /devices/heartbeat") {
      const body = await readBody(req);
      const device = state.devices.find((d) => d.deviceId === body.deviceId);
      if (!device) return json(res, 404, { error: "device not registered" });
      device.lastSeen = nowIso();
      await saveState(state);
      return json(res, 200, { ok: true });
    }

    /* 任务 */
    if (route === "POST /tasks") {
      const body = await readBody(req);
      if ((body.platform ?? state.config.platform) !== "douyin") {
        return json(res, 422, { error: "platform_not_implemented" });
      }
      const task = createTask({ platform: body.platform ?? state.config.platform, trigger: body.trigger ?? "manual" });
      await saveState(state);
      return json(res, 201, task);
    }
    if (route === "GET /tasks") return json(res, 200, state.tasks.slice(-50).reverse());
    if (route === "GET /tasks/pending") {
      const platform = url.searchParams.get("platform");
      const deviceId = url.searchParams.get("deviceId");
      const device = state.devices.find((d) => d.deviceId === deviceId);
      const task = state.tasks
        .filter((t) => t.status === "pending" || (t.status === "claimed" && t.claimedBy === deviceId))
        .find((t) => !platform || t.platform === platform || device?.supports?.includes(t.platform));
      return json(res, 200, task ?? null);
    }
    if (route.startsWith("POST /tasks/") && url.pathname.endsWith("/cancel")) {
      const id = url.pathname.split("/")[2];
      const task = state.tasks.find((t) => t.id === id);
      if (!task) return json(res, 404, { error: "task not found" });
      task.status = "cancelled";
      task.pauseReason = null;
      if (activeTask?.id === id) {
        activeSession = null;
        activeTask = null;
      }
      pushLog(task, "cancelled by user");
      await saveState(state);
      return json(res, 200, { ok: true });
    }
    if (route.startsWith("POST /tasks/") && url.pathname.endsWith("/claim")) {
      const id = url.pathname.split("/")[2];
      const body = await readBody(req);
      const task = state.tasks.find((t) => t.id === id);
      if (!task) return json(res, 404, { error: "task not found" });
      if (task.status !== "pending" && task.claimedBy !== body.deviceId) return json(res, 409, { error: "already claimed" });
      task.status = "running";
      task.claimedBy = body.deviceId;
      task.startedAt ??= nowIso();
      pushLog(task, `claimed by ${body.deviceId}`);
      await saveState(state);
      return json(res, 200, task);
    }

    /* 执行器事件上报 */
    if (route.startsWith("POST /tasks/") && url.pathname.endsWith("/events")) {
      const id = url.pathname.split("/")[2];
      const body = await readBody(req);
      const task = state.tasks.find((t) => t.id === id);
      if (!task) return json(res, 404, { error: "task not found" });

      switch (body.type) {
        case "started":
          task.status = "running";
          task.itemsTotal = body.itemsTotal ?? task.itemsTotal;
          break;
        case "scanned":
          task.itemsTotal = body.itemsTotal;
          break;
        case "item_result":
          task.itemsDone += 1;
          if (body.folderName) task.distribution[body.folderName] = (task.distribution[body.folderName] ?? 0) + 1;
          break;
        case "item_failed":
          task.itemsFailed += 1;
          break;
        case "need_human":
          task.itemsNeedHuman += 1;
          await notifySafely({ type: "card", card: newFolderDecisionCard(body.item, state.config.folders, body.recommendation) });
          break;
        case "login_expired":
          task.status = "paused";
          task.pauseReason = "login_expired";
          pushLog(task, "login expired, paused");
          await notifySafely({ type: "card", card: loginExpiredCard(task.platform) });
          break;
        case "classify_miss":
          task.classifyMisses ??= [];
          task.classifyMisses.push({
            itemId: body.itemId,
            reason: body.reason,
            title: body.title,
            author: body.author,
            hashtags: body.hashtags
          });
          break;
        case "move_trace":
          task.moveTraces ??= [];
          task.moveTraces.push({ at: nowIso(), trace: body.trace });
          break;
        case "manage_probe":
          task.manageProbe = body.probe;
          pushLog(task, `manage probe: ${body.probe?.entered ? "entered" : "failed"}`);
          break;
        case "write_api":
          task.writeApi = body.calls;
          break;
        case "log":
          pushLog(task, body.message);
          break;
      }
      await saveState(state);
      return json(res, 200, { ok: true });
    }

    if (route.startsWith("POST /tasks/") && url.pathname.endsWith("/complete")) {
      const id = url.pathname.split("/")[2];
      const task = state.tasks.find((t) => t.id === id);
      if (!task) return json(res, 404, { error: "task not found" });
      task.status = "done";
      task.completedAt = nowIso();
      await saveState(state);
      await notifySafely({
        type: "card",
        card: dailyReportCard({
          date: new Date().toISOString().slice(0, 10),
          delayed: task.delayed,
          itemsDone: task.itemsDone,
          itemsNeedHuman: task.itemsNeedHuman,
          itemsFailed: task.itemsFailed,
          distribution: task.distribution
        })
      });
      return json(res, 200, task);
    }

    /* Driver：插件上报 DOM/网络，大脑返回下一步动作 */
    if (route === "POST /driver/report") {
      const report = await readBody(req);
      // 运行错误报告没有可靠页面快照，不能推进状态机。
      if (report.clientError) {
        if (activeTask) {
          pushLog(activeTask, `client error: ${report.clientError.where}: ${report.clientError.message}`);
          await saveState(state);
        }
        return json(res, 200, { command: { op: "idle" }, reason: "client_error" });
      }
      if (!/^https:\/\/www\.douyin\.com\/user\/self(?:[/?#]|$)/.test(report.url ?? "")) {
        return json(res, 200, { command: { op: "idle" }, reason: "unsupported_page" });
      }
      const { session, task, fresh, hadSaved } = ensureSession(report);
      if (!session) return json(res, 200, { command: { op: "idle" }, reason: "no_task" });

      // 归一化前先取原始计数（用于轨迹）
      const rawSig = report.loginSignals;
      if (report.clientError) {
        task._errors ??= [];
        task._errors.push({ at: nowIso(), ...report.clientError });
        if (task._errors.length > 30) task._errors.shift();
      }
      if (report.net) report.net = normalizeNet(report.net);
      lastReportAt = Date.now();
      const command = decide(session, report);

      // 滚动轨迹：记录每轮大脑“看到了什么、决定了什么、是否被重建”
      task._trace ??= [];
      task._trace.push({
        t: nowIso().slice(11, 19),
        fresh: fresh ? (hadSaved ? "resume" : "new") : "",
        step: session.step,
        sub: session.subStep,
        netItems: report.net?.items?.length ?? 0,
        seen: report.net?.videoListSeen ? 1 : 0,
        reads: report.net?._diag?.shapes?.length ?? 0,
        acts: report.dom?.actions?.length ?? 0,
        cards: report.dom?.cards?.length ?? 0,
        cb: report.dom?.cards?.filter((c) => c.hasCheckbox).length ?? 0,
        sig: rawSig ? `L${rawSig.urlHasLogin ? 1 : 0}Q${rawSig.hasQr ? 1 : 0}P${rawSig.hasLoginPanel ? 1 : 0}` : "",
        cmd: command.op + (command.reason ? ":" + command.reason : "")
      });
      if (task._trace.length > 60) task._trace.shift();

      // 镜像大脑日志到任务
      for (let i = session._mir ?? 0; i < session.log.length; i++) {
        pushLog(task, session.log[i].message);
      }
      session._mir = session.log.length;

      // 同步进度
      task.itemsTotal = session.items.length;
      task.itemsDone = session.done;
      task.itemsFailed = session.failed;
      task.itemsNeedHuman = session.needHuman;
      task.distribution = session.distribution;
      task.driverStep = session.step;
      task.contentVersion = report.v ?? task.contentVersion;
      task._session = exportSession(session); // 持久化大脑进度，重启可恢复

      if (command.op === "done") {
        if (session.status === "login_expired") {
          task.status = "paused";
          task.pauseReason = "login_expired";
          pushLog(task, "login expired, paused");
          await notifySafely({ type: "card", card: loginExpiredCard(task.platform) });
        } else if (session.status === "blocked") {
          task.status = "blocked";
          task.blockedReason = session.blockedReason;
        } else {
          task.status = session.failed || session.needHuman ? "partial" : "done";
          task.completedAt = nowIso();
          await notifySafely({
            type: "card",
            card: dailyReportCard({
              date: new Date().toISOString().slice(0, 10),
              delayed: task.delayed,
              itemsDone: task.itemsDone,
              itemsNeedHuman: task.itemsNeedHuman,
              itemsFailed: task.itemsFailed,
              distribution: task.distribution
            })
          });
        }
        activeSession = null;
        activeTask = null;
      }

      await saveState(state);
      return json(res, 200, { command, step: session.step });
    }

    /* background 触发器：是否需要打开/刷新收藏页 */
    if (route === "GET /driver/should-run") {
      const hasOpenTask = state.tasks.some((t) =>
        ["pending", "running", "claimed"].includes(t.status));
      return json(res, 200, { run: Boolean(hasOpenTask) });
    }

    /* 执行器健康：距上次上报秒数；供后台判断是否需要刷新卡死标签 */
    if (route === "GET /driver/health") {
      const hasActive = state.tasks.some((t) =>
        ["pending", "running", "claimed"].includes(t.status));
      const since = lastReportAt ? Math.round((Date.now() - lastReportAt) / 1000) : null;
      return json(res, 200, { active: hasActive, since, stale: hasActive && (since === null || since > 45) });
    }

    /* 分类中转：供执行器调用 L1 */
    if (route === "POST /classify/keyword") {
      const body = await readBody(req);
      return json(res, 200, classifyByKeyword(body.item, state.config.rules));
    }

    /* 飞书通道自测 */
    if (route === "POST /notify/test") {
      await sendFeishu(state.config.feishuWebhook, { text: `收藏整理 Agent 通道测试成功 · ${nowIso()}` });
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "not found", route });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[collection-tidy-agent] 控制面已启动: http://localhost:${server.address().port}`);
});

/* ------------------------------ 调度器 ------------------------------ */

/** 到点生成任务；若服务启动时已过点（如设备刚开机），立即补跑并在日报注明延迟 */
async function scheduleTick() {
  const next = nextScheduledTask(state.config, state.tasks);
  if (next) {
    const task = createTask(next);
    await saveState(state);
    console.log(`[scheduler] 已生成今日整理任务 ${task.id}${task.delayed ? "（延迟补跑）" : ""}`);
  }
}

const tickSafely = () => scheduleTick().catch((error) => console.error(`[scheduler] ${error.message}`));
tickSafely();
setInterval(tickSafely, 60_000);
