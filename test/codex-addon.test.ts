// The Codex add-on: event mapping, permission asks, board and huddle runs on a fake `codex app-server`.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startAgentRun, teammateAgent } from "../src/server/addons/agents";
import { answerAsk } from "../src/server/addons/codex/asks";
import { codexAnswer, codexArgs, codexAsk, codexItemEvents } from "../src/server/addons/codex/runner";
import { CodexSessionCache, rolloutEvents } from "../src/server/addons/codex/sessions";
import { attachCodex, teammateThread } from "../src/server/addons/codex/state";
import { setTicketAgent } from "../src/server/addons/codex/http";
import { board, bus, setup, store, useBoardEnv } from "./board-env";
import { readJsonl, tempDir, until } from "./helpers";

useBoardEnv();

const FAKE_CODEX = join(import.meta.dir, "fixtures", "fake-codex.ts");
let log: string;
const turns = () => readJsonl(log).filter((e) => e.args);
const decisions = () => readJsonl(log).filter((e) => e.decision).map((e) => e.decision);
const arg = (args: string[], value: string) => args.includes(value);

beforeEach(() => {
  attachCodex(store, bus);
  log = join(tempDir("ck-codex-"), "log.jsonl");
  process.env.CKANBAN_CODEX_BIN = FAKE_CODEX;
  process.env.FAKE_CODEX_LOG = log;
});

afterEach(() => {
  for (const k of ["CKANBAN_CODEX_BIN", "FAKE_CODEX_LOG", "FAKE_CODEX_ASK", "FAKE_CODEX_FAIL"]) delete process.env[k];
});

async function codexTicket(status: "ready" | "planning", extra: Record<string, unknown> = {}) {
  await setup();
  const t = await board.createTicket("p", { title: "Check it", body: "desc", status: "backlog" });
  store.updateTicket("p", t.id, { agent: "codex", ...extra } as any);
  await board.updateTicket("p", t.id, { status });
  return t.id;
}

test("Codex items map to the board's Claude-style events", () => {
  const command = { type: "commandExecution", id: "c", command: "/bin/zsh -lc 'ls'", commandActions: [{ command: "ls" }] };
  expect(codexItemEvents("item/started", command)[0].message.content[0]).toEqual({ type: "tool_use", id: "c", name: "Bash", input: { command: "ls" } });
  expect(codexItemEvents("item/completed", { ...command, status: "completed", exitCode: 0, aggregatedOutput: "a.txt" })[0].message.content[0])
    .toEqual({ type: "tool_result", tool_use_id: "c", content: "a.txt", is_error: false });
  expect(codexItemEvents("item/completed", { ...command, status: "declined", aggregatedOutput: null, exitCode: null })[0].message.content[0])
    .toMatchObject({ content: "Denied", is_error: true });
  expect(codexItemEvents("item/started", { type: "mcpToolCall", id: "m", server: "ckanban", tool: "get_ticket", arguments: { id: 1 } })[0].message.content[0])
    .toMatchObject({ type: "tool_use", name: "mcp__ckanban__get_ticket", input: { id: 1 } });
  expect(codexItemEvents("item/completed", { type: "agentMessage", id: "r", text: "Done." })[0]).toMatchObject({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
  expect(codexItemEvents("item/completed", { type: "fileChange", id: "f", changes: [{ path: "a.ts" }, { path: "b.ts" }] })[0].message.content[0])
    .toMatchObject({ name: "Edit", input: { file_path: "a.ts, b.ts" } });
  expect(codexItemEvents("item/started", { type: "reasoning", id: "x" })).toEqual([]);
});

test("Codex approval requests map to the card and its three answers", () => {
  expect(codexAsk("7", "item/commandExecution/requestApproval", { reason: "Outside", command: "/bin/zsh -lc 'touch ~/x'", commandActions: [{ command: "touch ~/x" }] }))
    .toMatchObject({ id: "7", kind: "command", detail: "touch ~/x", exact: "/bin/zsh -lc 'touch ~/x'", reason: "Outside" });
  expect(codexAsk("8", "item/fileChange/requestApproval", { grantRoot: "/etc" })).toMatchObject({ kind: "edit", detail: "/etc" });
  // Without a folder the card names the files of that edit; with neither, nothing can be remembered.
  expect(codexAsk("8", "item/fileChange/requestApproval", { itemId: "f" }, "/etc/hosts")).toMatchObject({ detail: "/etc/hosts", exact: "/etc/hosts" });
  expect(codexAsk("8", "item/fileChange/requestApproval", {})).toMatchObject({ detail: "", exact: "" });
  expect(codexAsk("9", "mcpServer/elicitation/request", {})).toBeNull();
  expect(codexAnswer("7", true).result.decision).toBe("accept");
  expect(codexAnswer("7", true, true).result.decision).toBe("acceptForSession");
  expect(codexAnswer("7", false).result.decision).toBe("decline");
});

test("read-only runs never ask; work runs ask with the board's tools", () => {
  const planning = codexArgs({ readOnly: true });
  expect(planning).toContain('sandbox_mode="read-only"');
  expect(planning).toContain('approval_policy="never"');
  // Jobs and schedules run commands outside the sandbox: never offered to Codex, plus what the board turned off.
  expect(codexArgs({ readOnly: true, mcp: ["/bin/ck", "mcp"], disabledTools: ["start_huddle"] })).toContain(
    'mcp_servers.ckanban.disabled_tools=["schedule_job","update_job","run_job_now","cancel_job","create_schedule","update_schedule","delete_schedule","run_schedule","start_huddle"]');
  const work = codexArgs({ readOnly: false, ask: true, writableRoots: ["/out"], mcp: ["/bin/ck", "mcp"] });
  expect(work).toEqual(expect.arrayContaining(['approval_policy="on-request"', 'approvals_reviewer="user"', 'sandbox_mode="workspace-write"',
    'sandbox_workspace_write.writable_roots=["/out"]', 'mcp_servers.ckanban.command="/bin/ck"', 'mcp_servers.ckanban.default_tools_approval_mode="approve"']));
});

test("a Codex ticket runs on Codex, saves its thread and lands in Review", async () => {
  const id = await codexTicket("ready");
  await board.whenIdle();
  const t = store.getTicket("p", id) as any;
  expect(t.status).toBe("review");
  expect(t.outcome).toBe("done");
  expect(t.codexSessionId).toBe("12345678-1234-1234-1234-123456789abc");
  const [run] = turns();
  expect(arg(run.args, 'approval_policy="on-request"')).toBe(true);
  expect(arg(run.args, 'sandbox_mode="workspace-write"')).toBe(true);
  expect(run.resume).toBeNull();
  expect(run.cwd).toBe(t.worktree);
  // Only the outputs folder is writable besides the work folder: no part of .git.
  const roots = JSON.parse(run.args.find((a: string) => a.startsWith("sandbox_workspace_write.writable_roots=")).split("=")[1]);
  expect(roots).toEqual([store.outputsDir("p", id)]);
  const events = store.readActivity("p", id).map((a) => a.event);
  expect(events.some((e) => e.provider === "codex" && e.message?.content?.[0]?.name === "Bash")).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: "result", provider: "codex", is_error: false });
});

test("the transcript of a Codex ticket comes from its run log, or Codex's rollout once it exists", async () => {
  const id = await codexTicket("ready");
  await board.whenIdle();
  const home = tempDir("ck-codex-home-");
  const sessions = new CodexSessionCache(store, home);
  const t = store.getTicket("p", id)!;
  const fromLog = sessions.get(t.sessionId!)!;
  expect(fromLog.entries.some((e: any) => e.role === "assistant" && JSON.stringify(e).includes("Verified."))).toBe(true);
  expect(sessions.summary(t.sessionId!)?.lastMessage).not.toBeNull();
  expect(sessions.exists(t.sessionId!, () => false)).toBe(true);
  // Codex's own transcript, as an old Codex ticket from before the switch has it.
  const dir = join(home, "sessions", "2026", "10", "15");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rollout-2026-10-15T16-55-33-12345678-1234-1234-1234-123456789abc.jsonl"), [
    { type: "event_msg", payload: { type: "user_message", message: "Earlier question" } },
    { type: "event_msg", payload: { type: "agent_message", message: "Earlier answer" } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const fromRollout = new CodexSessionCache(store, home).get(t.sessionId!)!;
  expect(JSON.stringify(fromRollout.entries)).toContain("Earlier answer");
});

test("rollout lines map to the same events as a live run", () => {
  const events = rolloutEvents([
    JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ text: "Hi" }] } } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "c1", arguments: JSON.stringify({ cmd: "ls" }) } }),
  ].join("\n"));
  expect(events[0]).toMatchObject({ type: "assistant", provider: "codex", message: { content: [{ text: "Hi" }] } });
  expect(events[1].message.content[0]).toMatchObject({ type: "tool_use", name: "Bash", input: { command: "ls" } });
});

test("an old Codex ticket continues its own Codex thread", async () => {
  const id = await codexTicket("ready", { codexSessionId: "old-thread" });
  await board.whenIdle();
  expect(turns()[0].resume).toBe("old-thread");
  expect((store.getTicket("p", id) as any).codexSessionId).toBe("old-thread");
});

for (const [label, allow, always, decision] of [
  ["Allow", true, false, "accept"],
  ["Always allow in this chat", true, true, "acceptForSession"],
  ["Deny", false, false, "decline"],
] as const) {
  test(`a permission ask waits on the ticket until ${label}`, async () => {
    process.env.FAKE_CODEX_ASK = "1";
    const id = await codexTicket("ready");
    await until(() => !!(store.getTicket("p", id) as any).codexAsk);
    const ask = (store.getTicket("p", id) as any).codexAsk;
    expect(ask).toMatchObject({ kind: "command", detail: "touch ~/x", reason: "Write outside the folder?" });
    answerAsk("p", id, ask.id, allow, always);
    await board.whenIdle();
    expect(decisions()).toEqual([decision]);
    expect((store.getTicket("p", id) as any).codexAsk).toBeNull();
    expect(() => answerAsk("p", id, ask.id, true, false)).toThrow("no longer waiting");
  });
}

test("Always allow in this chat also answers the same ask in the ticket's later replies", async () => {
  process.env.FAKE_CODEX_ASK = "1";
  const id = await codexTicket("ready");
  await until(() => !!(store.getTicket("p", id) as any).codexAsk);
  answerAsk("p", id, (store.getTicket("p", id) as any).codexAsk.id, true, true);
  await board.whenIdle();
  await board.chat("p", id, "Once more");
  await until(() => decisions().length === 2);
  await board.whenIdle();
  expect(decisions()).toEqual(["acceptForSession", "acceptForSession"]);
  expect(turns()[1].resume).toBe("12345678-1234-1234-1234-123456789abc");
  expect((store.getTicket("p", id) as any).codexAsk).toBeNull();
});

test("a Planning chat on Codex is read-only and never asks", async () => {
  process.env.FAKE_CODEX_ASK = "1";
  const id = await codexTicket("planning");
  await until(() => turns().length > 0 && decisions().length > 0);
  await board.whenIdle();
  const [run] = turns();
  expect(arg(run.args, 'sandbox_mode="read-only"')).toBe(true);
  expect(arg(run.args, 'approval_policy="never"')).toBe(true);
  // The tools a Claude Planning chat can't use are off for Codex too.
  expect(run.args.find((a: string) => a.startsWith("mcp_servers.ckanban.disabled_tools="))).toContain('"start_huddle"');
  // The ask came anyway (fake): the board declined it at once, no card.
  expect(decisions()).toEqual(["decline"]);
  expect((store.getTicket("p", id) as any).codexAsk ?? null).toBeNull();
});

test("a huddle teammate on Codex never asks and keeps its own thread", async () => {
  process.env.FAKE_CODEX_ASK = "1";
  expect(teammateAgent({ model: "codex" })).toBe("codex");
  expect(teammateAgent({ model: "opus" })).toBe("claude");
  const handle = startAgentRun("codex", {
    bin: "claude", cwd: tempDir(), input: "Review it", onEvent: () => {},
    args: ["-p", "--session-id", "teammate-session", "--disallowedTools", "Edit,Write,NotebookEdit"],
    env: { CKANBAN_TICKET: "p/t_1", CKANBAN_HUDDLE_AGENT: "h1/reviewer/token" },
  });
  const out = await handle.done;
  expect(out.code).toBe(0);
  const [run] = turns();
  expect(arg(run.args, 'approval_policy="never"')).toBe(true);
  expect(arg(run.args, 'sandbox_mode="read-only"')).toBe(true);
  expect(decisions()).toEqual(["decline"]);
  expect(teammateThread("teammate-session")).toBe("12345678-1234-1234-1234-123456789abc");
});

test("a failed Codex turn fails the run with Codex's message", async () => {
  process.env.FAKE_CODEX_FAIL = "1";
  const id = await codexTicket("ready");
  await board.whenIdle();
  const t = store.getTicket("p", id)!;
  expect(t.outcome).toBe("failed");
  expect(t.error).toContain("Fake provider failure");
});

test("switching agent starts a new conversation", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  store.updateTicket("p", t.id, { agent: "codex", codexSessionId: "th", sessionId: "s1", sessionStarted: true, runCount: 1 } as any);
  const back = setTicketAgent(store, "p", t.id, "claude") as any;
  expect(back).toMatchObject({ agent: "claude", codexSessionId: null, sessionId: null, sessionStarted: false });
  const again = setTicketAgent(store, "p", t.id, "codex") as any;
  expect(again).toMatchObject({ agent: "codex", codexSessionId: null });
});
