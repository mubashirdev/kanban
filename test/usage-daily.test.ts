import { expect, test } from "bun:test";
import { dailyUsage } from "../src/server/usage-daily";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

test("daily usage adds up finished runs, Claude cost and run time for today across boards", () => {
  const store = new Store(tempDir());
  store.saveProfile({ name: "A", slug: "a", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: new Date().toISOString() });
  const t = store.createTicket("a", { title: "Work", body: "", status: "backlog" });
  store.appendActivity("a", t.id, 1, { type: "result", session_id: "s1", total_cost_usd: 0.25, duration_ms: 4000 });
  store.appendActivity("a", t.id, 2, { type: "result", session_id: "s2", total_cost_usd: 0.5, duration_ms: 6000 });
  store.appendActivity("a", t.id, 3, { type: "result", provider: "codex", duration_ms: 10000 });
  store.appendActivity("a", t.id, 3, { type: "assistant" });

  const days = dailyUsage(store, 3);
  expect(days).toHaveLength(3);
  expect(days[0]).toMatchObject({ claudeRuns: 2, codexRuns: 1, costUsd: 0.75, seconds: 20 });
  expect(days[1]).toMatchObject({ claudeRuns: 0, codexRuns: 0, costUsd: 0 });
});

test("a long chat's turns count only what each added: its result lines carry the session's running total", () => {
  const store = new Store(tempDir());
  store.saveProfile({ name: "A", slug: "a", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: new Date().toISOString() });
  const t = store.createTicket("a", { title: "Chat", body: "", status: "backlog" });
  for (const total of [10, 12, 15]) store.appendActivity("a", t.id, 1, { type: "result", session_id: "s1", total_cost_usd: total });
  // Resumed later: the session's total carries on from 15.
  store.appendActivity("a", t.id, 2, { type: "result", session_id: "s1", total_cost_usd: 16 });
  expect(dailyUsage(store, 1)[0].costUsd).toBe(16);
});
