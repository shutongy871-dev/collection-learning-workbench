import { createEmptyCard, fsrs, generatorParameters, Rating } from "ts-fsrs";

export const FSRS_VERSION = "ts-fsrs@5.4.2 / FSRS-6";
export const defaultParameters = () => generatorParameters({
  request_retention: .9, enable_fuzz: false, enable_short_term: true,
  learning_steps: ["10m"], relearning_steps: ["10m"]
});
export const ratings = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };
export function newCard(question, due = new Date()) {
  return { questionId: question.id, itemKey: question.itemKey, revision: 0, card: createEmptyCard(new Date(due)) };
}
export function previewReview(record, parameters, correct, at = new Date()) {
  const scheduler = fsrs(parameters);
  return Object.fromEntries(Object.entries(ratings).filter(([name]) => correct || name === "again").map(([name, grade]) => {
    const result = scheduler.next(record.card, new Date(at), grade);
    return [name, JSON.parse(JSON.stringify(result))];
  }));
}
export function normalizeLearning(state, now = new Date()) {
  const migrated = state.version !== 2;
  state.learningConfig ??= { dailyVideos: 5 };
  if (!Number.isInteger(state.learningConfig.dailyVideos) ||
      state.learningConfig.dailyVideos < 1 || state.learningConfig.dailyVideos > 50) {
    state.learningConfig.dailyVideos = 5;
  }
  state.cards ??= {};
  state.drafts ??= {};
  state.generations ??= {};
  state.fsrs ??= { version: FSRS_VERSION, parameters: defaultParameters() };
  const ids = new Set(state.questions.map(q => q.id));
  const keys = new Set(state.items.map(i => i.key));
  for (const id of Object.keys(state.cards)) if (!ids.has(id)) delete state.cards[id];
  for (const [id, draft] of Object.entries(state.drafts)) if (!keys.has(draft.itemKey)) delete state.drafts[id];
  for (const key of Object.keys(state.generations)) if (!keys.has(key)) delete state.generations[key];
  for (const q of state.questions) {
    state.progress[q.itemKey] ??= {
      enrolledAt: new Date(now).toISOString(),
      dueAt: new Date(now).toISOString(),
      stage: -1,
      reviews: 0,
      source: "automatic_question"
    };
    // Legacy due dates are retained; stability/difficulty are not invented from item-level reviews.
    state.cards[q.id] ??= newCard(q, migrated ? state.progress[q.itemKey]?.dueAt ?? now : now);
  }
  if (migrated) {
    state.migration = { from: state.version, at: new Date(now).toISOString(), legacyProgress: structuredClone(state.progress) };
    for (const a of Object.values(state.attempts)) {
      if (!a.completed) { a.revision = 0; delete a.previews; }
    }
  }
  state.version = 2;
  summarizeProgress(state);
  return state;
}
/** SQL: SELECT item_key, MIN(card.due) FROM cards JOIN enrolled USING(item_key) GROUP BY item_key. */
export function summarizeProgress(state) {
  for (const [key, p] of Object.entries(state.progress)) {
    const cards = Object.values(state.cards).filter(c => c.itemKey === key);
    if (cards.length) p.dueAt = cards.map(c => new Date(c.card.due).toISOString()).sort()[0];
  }
}
