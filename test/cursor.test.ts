import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { CodexSessions } from "../src/server/codex-session";
import { cursorArgs, cursorEvents, needsNewCursorChat, parseCursorModels, readableCursorError, startCursorRun } from "../src/server/cursor-runner";
import { Bus } from "../src/server/events";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";
import { makeRepo, tempDir } from "./helpers";

const FAKE_CURSOR = join(import.meta.dir, "fixtures", "fake-cursor.ts");
/** Lines recorded from `cursor-agent -p --output-format stream-json`. */
const SAMPLE = readFileSync(join(import.meta.dir, "fixtures", "cursor-stream.jsonl"), "utf8").trim().split("\n");
const saved = { ...process.env };

let store: Store, board: Board, log: string, mcpConfig: string;

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  mcpConfig = join(tempDir("ck-cursor-home-"), "mcp.json");
  board = new Board(store, new Bus(), { claudeBin: "claude", cursorBin: FAKE_CURSOR, cursorMcpConfig: mcpConfig, isSessionLive: async () => false });
  log = join(tempDir("ck-cursor-"), "cursor.jsonl");
  process.env.FAKE_CURSOR_LOG = log;
});
afterEach(() => {
  for (const key of ["FAKE_CURSOR_LOG", "FAKE_CURSOR_MODE"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function setup(): Promise<Profile> {
  const p: Profile = { name: "P", slug: "p", path: await makeRepo(), baseBranch: "main", maxParallel: 1, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p);
  return p;
}
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const all = () => SAMPLE.flatMap((line) => cursorEvents(line));

test("the chat id comes from Cursor's init event", () => {
  const [chat] = all();
  expect(chat.type).toBe("cursor.chat");
  expect(chat.chatId).toMatch(/^[\w-]+$/);
});

test("assistant text, tool calls and their results become the chat's events", () => {
  const events = all();
  const texts = events.filter((e) => e.type === "assistant" && e.message.content[0].type === "text").map((e) => e.message.content[0].text);
  expect(texts.length).toBeGreaterThan(0);
  const uses = events.filter((e) => e.type === "assistant" && e.message.content[0].type === "tool_use").map((e) => e.message.content[0]);
  const results = events.filter((e) => e.type === "user").map((e) => e.message.content[0]);
  expect(uses.length).toBeGreaterThan(0);
  // Every tool call is closed by its result, matched by id.
  for (const use of uses) expect(results.some((r) => r.tool_use_id === use.id)).toBe(true);
  // File tools carry the path where the chat's tool steps look for it.
  for (const use of uses.filter((u) => ["Read", "Write", "Edit"].includes(u.name))) expect(typeof use.input.file_path).toBe("string");
  // Cursor's echo of the prompt and its result line are not repeated: the runner writes its own.
  expect(events.some((e) => e.type === "result")).toBe(false);
});

test("recorded read, edit and shell calls show their file, diff and output", () => {
  const uses = all().filter((e) => e.type === "assistant" && e.message.content[0].type === "tool_use").map((e) => e.message.content[0]);
  expect(uses.map((u) => u.name)).toEqual(["Read", "Edit", "Bash"]);
  expect(uses[1].input).toMatchObject({ file_path: "/private/tmp/cursor-probe2/notes.txt", content: "hi\n" });
  expect(uses[2].input).toEqual({ command: "ls" });
  const results = all().filter((e) => e.type === "user").map((e) => e.message.content[0]);
  expect(results[0].content).toBe("hello\n");
  expect(results[1].content).toContain("+hi");
  expect(results[2]).toMatchObject({ content: expect.stringContaining("notes.txt"), is_error: false });
  // Thinking deltas are left out; the last assistant text is the reply.
  const texts = all().filter((e) => e.type === "assistant" && e.message.content[0].type === "text").map((e) => e.message.content[0].text);
  expect(texts.at(-1)).toBe("done");
});

test("a write tool shows as a Write step with its file and content", () => {
  const [use] = cursorEvents(JSON.stringify({ type: "tool_call", subtype: "started", call_id: "w1", tool_call: { writeToolCall: { args: { path: "a.txt", fileText: "x" } } } }));
  expect(use.message.content[0]).toEqual({ type: "tool_use", id: "w1", name: "Write", input: { path: "a.txt", fileText: "x", file_path: "a.txt", content: "x" } });
  const [failed] = cursorEvents(JSON.stringify({ type: "tool_call", subtype: "completed", call_id: "w1", tool_call: { writeToolCall: { result: { error: { message: "denied" } } } } }));
  expect(failed.message.content[0]).toMatchObject({ tool_use_id: "w1", content: "denied", is_error: true });
});

test("a board tool's answer shows as its text", () => {
  const [result] = cursorEvents(JSON.stringify({ type: "tool_call", subtype: "completed", call_id: "m1", tool_call: { mcpToolCall: { result: { success: { content: [{ text: { text: "Board demo: 2 tickets" } }], isError: false } } } } }));
  expect(result.message.content[0]).toMatchObject({ tool_use_id: "m1", content: "Board demo: 2 tickets", is_error: false });
});

test("lines that are not JSON or not known are skipped", () => {
  expect(cursorEvents("Loading…")).toEqual([]);
  expect(cursorEvents(JSON.stringify({ type: "thinking", text: "hm" }))).toEqual([]);
});

test("read only uses ask mode without --force; can edit adds --force with the sandbox off; planning uses plan mode", () => {
  const read = cursorArgs({ mode: "ask" });
  expect(read).not.toContain("--force");
  expect(read).toEqual(expect.arrayContaining(["--trust", "--mode", "ask"]));
  expect(cursorArgs({ mode: "agent" })).toEqual(expect.arrayContaining(["--force", "--sandbox", "disabled"]));
  const plan = cursorArgs({ mode: "plan", chatId: "abc", model: "gpt-5" });
  expect(plan).toEqual(expect.arrayContaining(["--mode", "plan", "--resume", "abc", "--model", "gpt-5"]));
  expect(plan).not.toContain("--force");
});

test("only a chat stuck in plan or ask mode needs a new chat to change mode", () => {
  expect(needsNewCursorChat("ask", "agent")).toBe(true);
  expect(needsNewCursorChat("plan", "agent")).toBe(true);
  expect(needsNewCursorChat("ask", "ask")).toBe(false);
  expect(needsNewCursorChat("agent", "ask")).toBe(false);
  expect(needsNewCursorChat(null, "agent")).toBe(false);
});

test("models are read from `cursor-agent models` lines", () => {
  // Recorded from cursor-agent 2026.01.23.
  expect(parseCursorModels("\x1b[2KLoading models…\nAvailable models\n\nauto - Auto (current, default)\ngpt-5.3-codex - Codex 5.3\ncomposer-2.5 - Composer 2.5\n")).toEqual([
    { value: "auto", displayName: "Auto" },
    { value: "gpt-5.3-codex", displayName: "Codex 5.3" },
    { value: "composer-2.5", displayName: "Composer 2.5" },
  ]);
});

test("a Cursor chat with Can edit edits, keeps its chat id and resumes it on the next message", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "Ask", body: "", status: "backlog", standalone: true, access: "edit", agent: "cursor" });
  await board.chat("p", t.id, "Write notes.txt");
  await board.whenIdle();
  const first = calls().at(-1);
  expect(first.cwd).toBe(p.path);
  expect(first.args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--force", "--approve-mcps"]));
  expect(first.args).not.toContain("--resume");
  expect(first.prompt).toContain("Write notes.txt");
  const after = store.getTicket("p", t.id)!;
  expect(after.cursorChatId).toBe("c0ffee00-1111-2222-3333-444455556666");
  expect(after.outcome).not.toBe("failed");
  // The board's tools are registered where Cursor reads them, with the run's identity passed through.
  const server = JSON.parse(readFileSync(mcpConfig, "utf8")).mcpServers.ckanban;
  expect(server.env.CKANBAN_TICKET).toBe("${env:CKANBAN_TICKET}");

  await board.chat("p", t.id, "And again");
  await board.whenIdle();
  const second = calls().at(-1);
  expect(second.args[second.args.indexOf("--resume") + 1]).toBe("c0ffee00-1111-2222-3333-444455556666");

  const chat = new CodexSessions(store).get("p", t.id)!;
  const words = chat.entries.filter((e: any) => e.kind === "text").map((e: any) => e.text);
  expect(words).toEqual(expect.arrayContaining(["Write notes.txt", "Done.", "And again"]));

  await board.chat("p", t.id, "/clear");
  expect(store.getTicket("p", t.id)!.cursorChatId).toBeNull();
});

test("a read-only Cursor chat runs in ask mode without --force", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Ask", body: "", status: "backlog", standalone: true, access: "read", agent: "cursor" });
  await board.chat("p", t.id, "What is this?");
  await board.whenIdle();
  const args = calls().at(-1).args;
  expect(args).not.toContain("--force");
  expect(args[args.indexOf("--mode") + 1]).toBe("ask");
});

test("switching a read-only chat to can edit starts a new Cursor chat that is told the conversation so far", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Ask", body: "", status: "backlog", standalone: true, access: "read", agent: "cursor" });
  await board.chat("p", t.id, "What is in math.ts?");
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.cursorMode).toBe("ask");
  await board.updateTicket("p", t.id, { access: "edit" });
  await board.chat("p", t.id, "Now add subtract");
  await board.whenIdle();
  const call = calls().at(-1);
  expect(call.args).not.toContain("--resume");
  expect(call.args).toContain("--force");
  expect(call.prompt).toContain("User: What is in math.ts?");
  expect(call.prompt).toContain("You: Done.");
  expect(call.prompt.endsWith("Now add subtract")).toBe(true);
  expect(store.getTicket("p", t.id)!.cursorMode).toBe("agent");
  // Back in agent mode, the next message resumes the new chat.
  await board.chat("p", t.id, "Thanks");
  await board.whenIdle();
  expect(calls().at(-1).args).toContain("--resume");
});

test("a run with no output is stopped by the watchdog and says so", async () => {
  process.env.FAKE_CURSOR_MODE = "silent";
  const handle = startCursorRun({ bin: FAKE_CURSOR, cwd: tempDir("ck-cwd-"), args: [], input: "hi", onEvent: () => {}, silenceMs: 300 });
  const out = await handle.done;
  expect(out.code).not.toBe(0);
  expect(out.stderr).toContain("Cursor stopped responding");
});

test("a login problem is explained in plain words", async () => {
  process.env.FAKE_CURSOR_MODE = "auth";
  const out = await startCursorRun({ bin: FAKE_CURSOR, cwd: tempDir("ck-cwd-"), args: [], input: "hi", onEvent: () => {} }).done;
  expect(out.code).not.toBe(0);
  expect(out.stderr).toBe(readableCursorError("Error: Authentication required. Please run 'agent login' first"));
  expect(out.stderr).toContain("cursor-agent login");
});
