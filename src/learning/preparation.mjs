import { dailyLearningQueue, dayKey } from "./domain.mjs";

const configurationErrors = new Set(["question_not_configured", "question_pricing_missing",
  "question_reservation_too_small", "invalid_question_endpoint", "vision_not_configured", "vision_pricing_missing", "invalid_model_config"]);
export function learningPreparation(state, batch, { active = false, modelError, taskError, plan, now = Date.now() } = {}) {
  const queue = dailyLearningQueue(state.items, state.progress, state.questions, state.cards, state.events,
    state.learningConfig.dailyVideos, now);
  if (queue.length) return { status: "ready", readyVideos: queue.length };
  const completed = new Set(state.events.filter(e => dayKey(e.at) === dayKey(now)).map(e => e.itemKey));
  if (completed.size >= state.learningConfig.dailyVideos) return { status: "daily_completed" };
  if (!state.items.length) return { status: "empty_library" };
  if (modelError) return { status: "needs_configuration", error: modelError };
  const entries = Object.values(batch.ledger.days[dayKey(now)]?.entries ?? {});
  const prepared = entries.filter(e => e.status === "completed").length;
  if (active) return { status: "preparing", preparedVideos: prepared,
    stage: entries.some(e => e.status === "running") ? "processing" : "starting" };
  const failed = entries.filter(e => !["completed", "skipped"].includes(e.status));
  const errors = [taskError, batch.latest?.date === dayKey(now) ? batch.latest?.error : undefined,
    ...failed.map(e => e.error)];
  // A newly saved question configuration supersedes earlier configuration failures.
  const error = errors.find(e => e && (!configurationErrors.has(e) || e.startsWith("vision_")));
  if (error) return { status: configurationErrors.has(error) ? "needs_configuration" : "blocked", error };
  if (plan?.remainingCny <= 0) return { status: "blocked", error: "daily_budget_limit" };
  if (plan?.items.length) return { status: "idle" };
  if (plan?.eligibleItems && !plan.remainingItems) return { status: "blocked", error: "daily_item_limit" };
  if (state.questions.length) return { status: "no_due_questions" };
  return { status: "no_learning_content" };
}
