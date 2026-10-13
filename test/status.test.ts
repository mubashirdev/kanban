import { expect, test } from "bun:test";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";
import { summarizeEvent } from "../src/server/activity";
import { huddleNudgeAnswer, NUDGE_TEXT, nudgeAnswer, pushStep, stepLabel } from "../src/server/status";
import type { PermissionAsk } from "../src/server/types";

const tool = (name: string, input: any) => summarizeEvent({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

test("run events become plain step labels", () => {
  expect(tool("Bash", { command: "cd /repo && bun test test" })).toBe("Running tests");
  expect(tool("Bash", { command: "bun run build:web" })).toBe("Building");
  expect(tool("Bash", { command: "bunx tsc --noEmit" })).toBe("Checking types");
  expect(tool("Bash", { command: "git push origin HEAD:main" })).toBe("Uploading changes");
  expect(tool("Bash", { command: "git commit -m 'feat: x'" })).toBe("Saving a snapshot");
  expect(tool("Edit", { file_path: "/repo/web/src/Chat.tsx" })).toBe("Editing Chat.tsx");
});

test("stepLabel puts a waiting approval before the last tool call", () => {
  expect(stepLabel({ lastActivity: "Editing Chat.tsx", permissionAsk: null })).toBe("Editing Chat.tsx");
  expect(stepLabel({ lastActivity: "Editing Chat.tsx", permissionAsk: { id: "1", tool: "Bash", detail: "rm -rf x" } as PermissionAsk })).toBe("Waiting for your approval");
  expect(stepLabel({ lastActivity: null, permissionAsk: null })).toBe("Starting…");
});

test("pushStep keeps the last five steps without repeats", () => {
  const steps: string[] = [];
  for (const s of ["a", "a", "b", "c", "d", "e", "f"]) pushStep(steps, s);
  expect(steps).toEqual(["b", "c", "d", "e", "f"]);
});

test("nudgeAnswer finds the first reply after the last nudge", () => {
  const e = (role: "user" | "assistant", text: string, at: string, extra: object = {}) => ({ role, kind: "text" as const, text, at, ...extra });
  expect(nudgeAnswer([e("user", "hi", "1")])).toBeNull();
  expect(nudgeAnswer([e("user", NUDGE_TEXT, "1")])).toEqual({ at: "1", answer: null });
  expect(nudgeAnswer([
    e("user", NUDGE_TEXT, "1"), e("assistant", "old answer", "2"),
    e("user", `Message from the user: ${NUDGE_TEXT}`, "3"),
    { role: "assistant" as const, kind: "tool" as const, text: "Bash", at: "4" },
    e("assistant", "Checking", "5", { note: true }),
    e("assistant", " Done: UI. Left: tests. No blocker. ", "6"),
  ])).toEqual({ at: "3", answer: "Done: UI. Left: tests. No blocker." });
});

test("huddleNudgeAnswer takes main's first reply", () => {
  const m = (from: string, text: string, ts: string, kind: "message" | "system" = "message") => ({ from, text, ts, kind });
  expect(huddleNudgeAnswer([m("you", "hello", "1")])).toBeNull();
  expect(huddleNudgeAnswer([
    m("you", `@main ${NUDGE_TEXT}`, "1"), m("system", "@qa is done", "2", "system"), m("qa", "Testing the toggle.", "3"), m("main", "Reviewed 3 of 5 files.", "4"),
  ])).toEqual({ at: "1", answer: "Reviewed 3 of 5 files." });
});

test("GET /api/status lists running tickets only, and Nudge refuses a run that has finished", async () => {
  const store = new Store(tempDir()), bus = new Bus();
  store.saveProfile({ name: "Shop", slug: "shop", path: tempDir(), baseBranch: "main", maxParallel: 2, createdAt: new Date().toISOString() });
  const board = new Board(store, bus, { claudeBin: join(import.meta.dir, "fixtures", "fake-claude.ts") });
  const server = createServer({ store, bus, board, port: 0, webDir: tempDir() });
  const base = `http://127.0.0.1:${server.port}/api`;
  const post = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
  process.env.FAKE_MODE = "slow";
  try {
    const idle = store.createTicket("shop", { title: "Idle", body: "", status: "backlog" });
    const live = await board.createTicket("shop", { title: "Live", body: "", status: "ready" });
    for (let i = 0; i < 50 && !board.isRunning("shop", live.id); i++) await Bun.sleep(100);
    const rows = await (await fetch(`${base}/status`)).json() as any[];
    expect(rows.map((r) => [r.kind, r.title, r.profileName, r.agent])).toEqual([["ticket", "Live", "Shop", "Claude"]]);
    expect(rows[0].stalledMinutes).toBeNull();
    expect((await fetch(`${base}/profiles/shop/tickets/${idle.id}/nudge`, post)).status).toBe(409);
    expect(store.getTicket("shop", idle.id)!.status).toBe("backlog");
    expect((await fetch(`${base}/profiles/shop/tickets/${live.id}/nudge`, post)).status).toBe(202);
    expect(store.getTicket("shop", live.id)!.lastPrompt).toContain(NUDGE_TEXT);
  } finally {
    delete process.env.FAKE_MODE;
    board.stopAll();
    server.stop(true);
  }
}, 15000);
