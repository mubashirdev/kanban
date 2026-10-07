import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { CodexSessions } from "../src/server/codex-session";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { searchBoard } from "../src/server/search";
import { SessionCache } from "../src/server/session";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

const line = (role: "user" | "assistant", text: string, at: string) =>
  JSON.stringify({ type: role, uuid: `${role}${at}`, timestamp: at, message: { role, content: role === "user" ? text : [{ type: "text", text }] } });

function setup() {
  const store = new Store(tempDir("ck-home-"));
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  const configDir = tempDir("ck-claude-");
  mkdirSync(join(configDir, "projects", "-repo"), { recursive: true });
  const sessions = new SessionCache({ configDir });
  const codexSessions = new CodexSessions(store, tempDir("ck-codex-home-"));
  const withConversation = (sessionId: string, ...lines: string[]) =>
    writeFileSync(join(configDir, "projects", "-repo", `${sessionId}.jsonl`), lines.join("\n") + "\n");
  return { store, sessions, codexSessions, withConversation };
}

test("search finds words in titles, descriptions, comments and conversations, best field first", () => {
  const { store, sessions, codexSessions, withConversation } = setup();
  const byTitle = store.createTicket("p", { title: "Fix the Parser crash", body: "", status: "backlog" });
  const byBody = store.createTicket("p", { title: "Cleanup", body: "The parser leaks memory on large files", status: "backlog" });
  const byComment = store.createTicket("p", { title: "Docs", body: "", status: "review" });
  store.addComment("p", byComment.id, "ai", "Rewrote the PARSER section");
  const chat = store.createTicket("p", { title: "Chat", body: "", status: "backlog", standalone: true });
  const sessionId = "11111111-2222-3333-4444-555555555555";
  store.updateTicket("p", chat.id, { sessionId });
  withConversation(sessionId, line("user", "why is it slow?", "2026-10-01T10:00:00Z"), line("assistant", "The parser re-reads every file twice, which is the slow part.", "2026-10-01T10:00:05Z"));
  store.createTicket("p", { title: "Unrelated", body: "nothing here", status: "backlog" });

  const hits = searchBoard(store, sessions, codexSessions, "p", "parser");
  expect(hits.map((h) => [h.id, h.field])).toEqual([[byTitle.id, "title"], [byBody.id, "description"], [byComment.id, "comment"], [chat.id, "message"]]);
  expect(hits[3]).toMatchObject({ standalone: true, snippet: "The parser re-reads every file twice, which is the slow part." });
  // Every word must match, in any order; a blank query matches nothing.
  expect(searchBoard(store, sessions, codexSessions, "p", "slow  parser").map((h) => h.id)).toEqual([chat.id]);
  expect(searchBoard(store, sessions, codexSessions, "p", "parser banana")).toEqual([]);
  expect(searchBoard(store, sessions, codexSessions, "p", "   ")).toEqual([]);
});

test("a long message is cut around the match", () => {
  const { store, sessions, codexSessions, withConversation } = setup();
  const chat = store.createTicket("p", { title: "Chat", body: "", status: "backlog", standalone: true });
  const sessionId = "11111111-2222-3333-4444-555555555555";
  store.updateTicket("p", chat.id, { sessionId });
  withConversation(sessionId, line("assistant", `${"a ".repeat(100)}needle${" b".repeat(100)}`, "2026-10-01T10:00:00Z"));
  const [hit] = searchBoard(store, sessions, codexSessions, "p", "NEEDLE");
  expect(hit.snippet.startsWith("…")).toBe(true);
  expect(hit.snippet.endsWith("…")).toBe(true);
  expect(hit.snippet).toContain("needle");
  expect(hit.snippet.length).toBeLessThan(140);
});

test("the search route returns hits for the board", async () => {
  const { store, sessions, codexSessions } = setup();
  const ticket = store.createTicket("p", { title: "Dark mode", body: "", status: "backlog" });
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "claude", isSessionLive: async () => false });
  const server = createServer({ store, bus, board, port: 0, webDir: tempDir(), sessions, codexSessions });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/profiles/p/search?q=dark`);
    expect(await res.json()).toEqual([{ id: ticket.id, title: "Dark mode", standalone: false, status: "backlog", field: "title", snippet: "Dark mode" }]);
    expect(await (await fetch(`http://127.0.0.1:${server.port}/api/profiles/p/search`)).json()).toEqual([]);
  } finally {
    server.stop(true);
  }
});
