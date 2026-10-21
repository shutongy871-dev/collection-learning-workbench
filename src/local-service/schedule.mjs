// 北京时间09:00只决定启动时刻。每次执行扫描全部未分类存量，不按任何日期筛视频。
export function scheduledTrigger(config, now = new Date()) {
  if (config.schedule?.enabled !== true) return null;
  const time = config.schedule.time ?? "09:00";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("invalid schedule time");
  if ((config.schedule.timezone ?? "Asia/Shanghai") !== "Asia/Shanghai") {
    throw new Error("目前调度仅支持 Asia/Shanghai");
  }
  const scheduleDate = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const scheduledFor = new Date(`${scheduleDate}T${time}:00+08:00`);
  if (now < scheduledFor) return null;
  return { scheduleDate, scheduledFor: scheduledFor.toISOString(), delayed: now - scheduledFor >= 60_000 };
}

export function nextScheduledTask(config, tasks, now = new Date()) {
  const window = scheduledTrigger(config, now);
  if (!window) return null;
  if (tasks.some((t) => t.trigger === "scheduled" && t.platform === config.platform &&
    (t.scheduleDate === window.scheduleDate || (!t.scheduleDate &&
      new Date(Date.parse(t.createdAt) + 8 * 3600_000).toISOString().slice(0, 10) === window.scheduleDate)))) return null;
  return { ...window, platform: config.platform, trigger: "scheduled", scope: "all_unclassified" };
}
