import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attentionFor } from "../src/server/attention";
import { Board } from "../src/server/board";
import { codexSkills, expandCodexCommand } from "../src/server/codex-commands";
import { CodexSessions, listCodexSessions, rolloutEvents } from "../src/server/codex-session";
import { ClaudeCommands } from "../src/server/commands";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { parseSession } from "../src/server/session";
import { Store } from "../src/server/store";
import type { Profile, Ticket } from "../src/server/types";
import { makeRepo, tempDir } from "./helpers";
import { run } from "../src/server/git";
import { gitState, searchFiles } from "../src/server/git-actions";
import { readableError } from "../src/server/codex-runner";

const FAKE_CLAUDE = join(import.meta.dir, "fixtures", "fake-claude.ts");
const FAKE_CODEX = join(import.meta.dir, "fixtures", "fake-codex.ts");
const saved = { ...process.env };

let store: Store, bus: Bus, board: Board, argsFile: string, codexLog: string;

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  board = new Board(store, bus, { claudeBin: FAKE_CLAUDE, codexBin: FAKE_CODEX, isSessionLive: async () => false });
  argsFile = join(tempDir("ck-args-"), "args.jsonl");
  codexLog = join(tempDir("ck-codex-"), "codex.jsonl");
  Object.assign(process.env, { FAKE_ARGS_FILE: argsFile, FAKE_CODEX_LOG: codexLog, FAKE_MODE: "ok" });
});
afterEach(() => {
  for (const key of ["FAKE_ARGS_FILE", "FAKE_CODEX_LOG", "FAKE_MODE", "FAKE_CODEX_FAIL", "CODEX_HOME"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function setup(): Promise<Profile> {
  const p: Profile = { name: "P", slug: "p", path: await makeRepo(), baseBranch: "main", maxParallel: 1, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p);
  return p;
}
const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const session = (input: Partial<Parameters<Store["createTicket"]>[1]> = {}) =>
  board.createTicket("p", { title: "Ask", body: "", status: "backlog", standalone: true, ...input });

test("a session runs in the repo folder, sends text as typed and never moves on the board", async () => {
  const p = await setup();
  const t = await session();
  await board.chat("p", t.id, "What does this repo do?");
  await board.whenIdle();
  const call = lines(argsFile).at(-1);
  expect(call.cwd).toBe(p.path);
  expect(call.prompt).toBe("What does this repo do?");
  // Read-only by default: plan mode, and the prompt tells Claude what it may do right now.
  expect(call.args).toContain("plan");
  expect(call.args[call.args.indexOf("--append-system-prompt") + 1]).toContain("Access right now: read-only");
  const after = store.getTicket("p", t.id)!;
  expect(after).toMatchObject({ status: "backlog", worktree: null, branch: null, runCount: 0, access: "read" });
});

test("switching a session to edit gives the next run edit rights and says so", async () => {
  await setup();
  const t = await session();
  await board.updateTicket("p", t.id, { access: "edit" });
  await board.chat("p", t.id, "Fix it");
  await board.whenIdle();
  const { args } = lines(argsFile).at(-1);
  expect(args).toContain("bypassPermissions");
  expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("Access right now: can edit");
  const ticket = await board.createTicket("p", { title: "Board ticket", body: "", status: "backlog" });
  expect(board.updateTicket("p", ticket.id, { access: "edit" })).rejects.toThrow("Only sessions");
});

test("switching access mid-run: the next message gets its own turn with the new access", async () => {
  await setup();
  process.env.FAKE_STEP_MS = "300";
  try {
    const t = await session();
    await board.chat("p", t.id, "Look around");
    await Bun.sleep(400);
    await board.updateTicket("p", t.id, { access: "edit" });
    await board.chat("p", t.id, "Now fix it");
    await board.whenIdle();
    // Not fed into the read-only turn: a second run answers it with edit rights.
    const calls = lines(argsFile);
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toBe("Now fix it");
    expect(calls[1].args).toContain("bypassPermissions");
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
}, 15000);

test("/clear starts a new conversation for both agents without running anything", async () => {
  await setup();
  const claude = await session();
  await board.chat("p", claude.id, "Hello");
  await board.whenIdle();
  const before = store.getTicket("p", claude.id)!;
  const runs = lines(argsFile).length;
  await board.chat("p", claude.id, "/clear");
  const cleared = store.getTicket("p", claude.id)!;
  expect(cleared.sessionId).not.toBe(before.sessionId);
  expect(cleared.sessionStarted).toBe(false);
  expect(lines(argsFile).length).toBe(runs);

  const codex = await session({ agent: "codex" });
  await board.chat("p", codex.id, "Hello");
  await board.whenIdle();
  const sessions = new CodexSessions(store, tempDir("ck-codex-home-"));
  expect(sessions.get("p", codex.id)?.entries.length).toBeGreaterThan(0);
  await board.chat("p", codex.id, "/new");
  expect(store.getTicket("p", codex.id)!.codexSessionId).toBeNull();
  expect(sessions.get("p", codex.id)).toBeNull();
});

test("Codex sessions expand board commands into prompts and get the session prompt as developer instructions", async () => {
  await setup();
  const t = await session({ agent: "codex" });
  await board.chat("p", t.id, "/review the parser");
  await board.whenIdle();
  const call = lines(codexLog).at(-1);
  expect(call.prompt).toContain("Review the uncommitted changes");
  expect(call.prompt).toContain("Focus on: the parser");
  expect(call.args.find((a: string) => a.startsWith("developer_instructions="))).toContain("Access right now: read-only");
  // Text that only looks like a command (a path) goes to Codex as typed.
  expect(expandCodexCommand("/Users/me/app.ts throws, why?")).toBe("/Users/me/app.ts throws, why?");
  expect(() => expandCodexCommand("/model gpt")).toThrow("settings button");
});

test("a failed session run is cleared by the next message", async () => {
  await setup();
  const t = await session({ agent: "codex" });
  process.env.FAKE_CODEX_FAIL = "1";
  await board.chat("p", t.id, "Hello");
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.outcome).toBe("failed");
  delete process.env.FAKE_CODEX_FAIL;
  await board.chat("p", t.id, "Again");
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.outcome).toBeNull();
});

test("a session waits on the user only for a reply they haven't seen", () => {
  const t = { standalone: true, agent: "codex", status: "backlog", outcome: null, readAt: "2026-01-01T10:00:00.000Z" } as Ticket;
  const reply = (at: string) => ({ lastMessage: { role: "assistant", text: "Done", at }, openQuestions: 0 }) as any;
  expect(attentionFor(t, reply("2026-01-01T11:00:00.000Z"), false)).toEqual({ kind: "reply", label: "Codex replied" });
  expect(attentionFor(t, reply("2026-01-01T09:00:00.000Z"), false)).toBeNull();
  expect(attentionFor(t, reply("2026-01-01T11:00:00.000Z"), true)).toBeNull();
  expect(attentionFor({ ...t, outcome: "failed" }, null, false)?.kind).toBe("failed");
});

test("Codex skills come from the repo first, then the user's folders", () => {
  const home = tempDir("ck-home-");
  const repo = tempDir("ck-repo-");
  mkdirSync(join(repo, ".git"));
  const skill = (root: string, dir: string, body: string) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "SKILL.md"), body);
  };
  skill(join(repo, ".agents", "skills"), "deploy", "---\nname: deploy\ndescription: Repo deploy steps\n---\n");
  skill(join(home, "skills"), "deploy", "---\nname: deploy\ndescription: User deploy\n---\n");
  skill(join(home, "skills"), "notes", "---\ndescription: \"Take notes\"\n---\n");
  process.env.CODEX_HOME = home;
  expect(codexSkills(repo).filter((s) => ["deploy", "notes"].includes(s.name))).toEqual([
    { name: "deploy", description: "Repo deploy steps" },
    { name: "notes", description: "Take notes" },
  ]);
});

test("a Codex rollout reads as the user's words, replies and tool calls", async () => {
  const rollout = [
    { timestamp: "t1", type: "session_meta", payload: { id: "11111111-1111-1111-1111-111111111111", cwd: "/repo" } },
    { timestamp: "t2", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<injected context>" }] } },
    { timestamp: "t3", type: "event_msg", payload: { type: "user_message", message: "List the files" } },
    { timestamp: "t4", type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", input: 'await tools.exec_command({cmd:"ls -la\\n"})' } },
    { timestamp: "t5", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "app.js" }] } },
    { timestamp: "t6", type: "event_msg", payload: { type: "agent_message", message: "One file: app.js" } },
  ].map((l) => JSON.stringify(l)).join("\n");
  const parsed = parseSession(rolloutEvents(rollout).map((e) => JSON.stringify(e)).join("\n"));
  expect(parsed.entries.map((e) => [e.role, e.text])).toEqual([["user", "List the files"], ["assistant", "Bash: ls -la"], ["assistant", "One file: app.js"]]);

  const home = tempDir("ck-codex-home-");
  mkdirSync(join(home, "sessions", "2026", "10", "06"), { recursive: true });
  writeFileSync(join(home, "sessions", "2026", "10", "06", "rollout-x-11111111-1111-1111-1111-111111111111.jsonl"), rollout);
  writeFileSync(join(home, "session_index.jsonl"), JSON.stringify({ id: "11111111-1111-1111-1111-111111111111", thread_name: "Files" }) + "\n");
  expect(await listCodexSessions("/repo", home)).toEqual([expect.objectContaining({ id: "11111111-1111-1111-1111-111111111111", title: "Files", firstPrompt: "List the files" })]);
  expect(await listCodexSessions("/other", home)).toEqual([]);
});

test("a Codex 0.160 rollout reads its user and agent messages from completed items", () => {
  const rollout = [
    { timestamp: "t1", type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "Say hi" }] } } },
    { timestamp: "t2", type: "event_msg", payload: { type: "item_completed", item: { type: "Reasoning", summary_text: [] } } },
    { timestamp: "t3", type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "hi" }] } } },
  ].map((l) => JSON.stringify(l)).join("\n");
  const parsed = parseSession(rolloutEvents(rollout).map((e) => JSON.stringify(e)).join("\n"));
  expect(parsed.entries.map((e) => [e.role, e.text])).toEqual([["user", "Say hi"], ["assistant", "hi"]]);
});

test("a Codex progress note is marked as a note, the final answer is not", () => {
  const rollout = [
    { timestamp: "t1", type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "hi" }] } } },
    { timestamp: "t2", type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", phase: "commentary", content: [{ type: "Text", text: "I'll load your instructions." }] } } },
    { timestamp: "t3", type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", phase: "final_answer", content: [{ type: "Text", text: "Hi! What are we working on?" }] } } },
  ].map((l) => JSON.stringify(l)).join("\n");
  const parsed = parseSession(rolloutEvents(rollout).map((e) => JSON.stringify(e)).join("\n"));
  expect(parsed.entries.map((e) => [e.role, e.note ?? false])).toEqual([["user", false], ["assistant", true], ["assistant", false]]);
});

test("a tool step gets its result, duration and the change it made, for Claude and Codex", () => {
  const claude = [
    { type: "assistant", uuid: "a1", timestamp: "2026-10-07T10:00:00.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/a.ts", old_string: "let x = 1", new_string: "let x = 2" } }] } },
    { type: "user", uuid: "u1", timestamp: "2026-10-07T10:00:02.500Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "File updated", is_error: false }] } },
    { type: "assistant", uuid: "a2", timestamp: "2026-10-07T10:00:03.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "bun test" } }] } },
    { type: "user", uuid: "u2", timestamp: "2026-10-07T10:00:04.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "1 fail" }], is_error: true }] } },
  ].map((e) => JSON.stringify(e)).join("\n");
  const [edit, bash] = parseSession(claude).entries;
  expect(edit.tool).toEqual({ diff: "-let x = 1\n+let x = 2", ok: true, output: "File updated", ms: 2500 });
  expect(bash.tool).toMatchObject({ ok: false, output: "1 fail", ms: 1000 });

  const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch";
  const codex = [
    { timestamp: "2026-10-07T10:00:00.000Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: patch } },
    { timestamp: "2026-10-07T10:00:01.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: "Done!" } },
  ].map((l) => JSON.stringify(l)).join("\n");
  const [applied] = parseSession(rolloutEvents(codex).map((e) => JSON.stringify(e)).join("\n")).entries;
  expect(applied.tool).toMatchObject({ diff: patch, ok: true, output: "Done!", ms: 1000 });
});

test("an expired command list is served at once while a fresh one loads", async () => {
  let calls = 0, release = () => {};
  const commands = new ClaudeCommands("claude", async () => {
    calls++;
    if (calls > 1) await new Promise<void>((r) => (release = r));
    return { commands: [{ name: `v${calls}`, description: "", argumentHint: "", aliases: [], builtin: true }], models: [] };
  });
  expect((await commands.get("/repo", false)).map((c) => c.name)).toEqual(["v1"]);
  (commands as any).cache.get("false:/repo").until = 0;
  expect((await commands.get("/repo", false)).map((c) => c.name)).toEqual(["v1"]);
  expect((await commands.get("/repo", false)).map((c) => c.name)).toEqual(["v1"]);
  expect(calls).toBe(2);
  release();
  await Bun.sleep(5);
  expect((await commands.get("/repo", false)).map((c) => c.name)).toEqual(["v2"]);
});

test("the API creates sessions, lists Codex commands with skills and moves a session to the board", async () => {
  await setup();
  const server = createServer({ store, bus, board, port: 0, webDir: tempDir() });
  const base = `http://127.0.0.1:${server.port}/api/profiles/p/tickets`;
  const send = (url: string, method: string, body: unknown) => fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const created: any = await (await send(base, "POST", { title: "Ask", body: "", status: "in_progress", standalone: true, access: "edit", agent: "codex" })).json();
    expect(created).toMatchObject({ standalone: true, access: "edit", status: "backlog", agent: "codex" });
    const catalog: any = await (await fetch(`${base}/${created.id}/commands`)).json();
    expect(catalog.commands.slice(0, 2).map((c: any) => c.name)).toEqual(["clear", "model"]);
    expect(catalog.commands.filter((c: any) => c.insert).every((c: any) => c.insert === `$${c.name} `)).toBe(true);
    expect((await send(`${base}/${created.id}`, "PATCH", { readAt: "2026-01-01T00:00:00.000Z" })).status).toBe(200);
    const moved: any = await (await send(`${base}/${created.id}`, "PATCH", { standalone: false })).json();
    expect(moved.standalone).toBe(false);
    expect(moved.access).toBeUndefined();
    expect((await send(base, "POST", { title: "Bad", status: "backlog", agent: "claude", codexSessionId: "11111111-1111-1111-1111-111111111111" })).status).toBe(400);
  } finally {
    server.stop(true);
  }
});

test("/clear on a resumed Claude session starts a fresh id instead of resuming one that doesn't exist", async () => {
  await setup();
  const t = await session();
  await board.linkSession("p", t.id, "22222222-2222-2222-2222-222222222222");
  await board.chat("p", t.id, "/clear");
  await board.chat("p", t.id, "Hello again");
  await board.whenIdle();
  const { args } = lines(argsFile).at(-1);
  expect(args).not.toContain("--resume");
  expect(args[args.indexOf("--session-id") + 1]).toBe(store.getTicket("p", t.id)!.sessionId);
});

test("a Codex session moved to the board keeps working in the repo folder", async () => {
  const p = await setup();
  const t = await session({ agent: "codex", access: "edit" });
  await board.chat("p", t.id, "Change something");
  await board.whenIdle();
  await board.updateTicket("p", t.id, { standalone: false });
  await board.chat("p", t.id, "Continue");
  await board.whenIdle();
  expect(lines(codexLog).at(-1).cwd).toBe(p.path);
  expect(store.getTicket("p", t.id)!.worktree).toBeNull();
});

test("a growing Codex rollout is read in pieces, keeping a half-written line for later", async () => {
  await setup();
  const home = tempDir("ck-codex-home-");
  const thread = "33333333-3333-3333-3333-333333333333";
  mkdirSync(join(home, "sessions"), { recursive: true });
  const file = join(home, "sessions", `rollout-x-${thread}.jsonl`);
  const line = (payload: object) => JSON.stringify({ timestamp: "t", type: "event_msg", payload }) + "\n";
  writeFileSync(file, line({ type: "user_message", message: "First" }));
  const t = await session({ agent: "codex", codexSessionId: thread });
  const sessions = new CodexSessions(store, home);
  expect(sessions.get("p", t.id)!.entries.map((e) => e.text)).toEqual(["First"]);
  const reply = line({ type: "agent_message", message: "Réponse" });
  appendFileSync(file, reply.slice(0, 20));
  expect(sessions.get("p", t.id)!.entries.map((e) => e.text)).toEqual(["First"]);
  appendFileSync(file, reply.slice(20));
  expect(sessions.get("p", t.id)!.entries.map((e) => e.text)).toEqual(["First", "Réponse"]);
});

test("Reload during a background refresh waits for the fresh list", async () => {
  let calls = 0, release = () => {};
  const commands = new ClaudeCommands("claude", async () => {
    calls++;
    if (calls > 1) await new Promise<void>((r) => (release = r));
    return { commands: [{ name: `v${calls}`, description: "", argumentHint: "", aliases: [], builtin: true }], models: [] };
  });
  await commands.get("/repo", false);
  (commands as any).cache.get("false:/repo").until = 0;
  await commands.get("/repo", false);
  const reload = commands.get("/repo", false, true);
  release();
  expect((await reload).map((c) => c.name)).toEqual(["v2"]);
  expect(calls).toBe(2);
});

test("resuming a Claude session from Sessions keeps it out of Review", async () => {
  await setup();
  const server = createServer({ store, bus, board, port: 0, webDir: tempDir() });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/profiles/p/tickets`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Earlier", body: "", status: "backlog", standalone: true, sessionId: "44444444-4444-4444-4444-444444444444" }),
    });
    expect(((await res.json()) as any)).toMatchObject({ standalone: true, status: "backlog", sessionId: "44444444-4444-4444-4444-444444444444" });
  } finally {
    server.stop(true);
  }
});

test("an isolated session works on its own branch and the Changes pane can commit and push it", async () => {
  const p = await setup();
  const origin = tempDir("ck-origin-");
  await run(["git", "init", "-q", "--bare", origin], origin);
  await run(["git", "remote", "add", "origin", origin], p.path);
  await run(["git", "push", "-q", "-u", "origin", "HEAD:main"], p.path);
  const t = await session({ access: "edit", isolated: true });
  await board.chat("p", t.id, "Change something");
  await board.whenIdle();
  const after = store.getTicket("p", t.id)!;
  expect(after.worktree).not.toBeNull();
  expect(lines(argsFile).at(-1).cwd).toBe(after.worktree);

  writeFileSync(join(after.worktree!, "new.txt"), "hello\n");
  expect(await gitState(after.worktree!, "main")).toMatchObject({ branch: after.branch, dirty: 1, upstream: false });
  expect(board.gitAction("p", t.id, "commit", "  ")).rejects.toThrow("commit message");
  await board.gitAction("p", t.id, "commit", "feat: add new.txt");
  expect(await gitState(after.worktree!, "main")).toMatchObject({ dirty: 0, ahead: 1, upstream: false });
  await board.gitAction("p", t.id, "push");
  expect(await gitState(after.worktree!, "main")).toMatchObject({ ahead: 0, upstream: true });
  expect((await run(["git", "log", "--oneline", "-1", after.branch!], origin)).stdout).toContain("feat: add new.txt");
  // The repo folder itself never changed.
  expect(existsSync(join(p.path, "new.txt"))).toBe(false);
});

test("@ mentions find repo files by name first, leaving ignored files out", async () => {
  const p = await setup();
  mkdirSync(join(p.path, "src", "deep"), { recursive: true });
  writeFileSync(join(p.path, "src", "deep", "parser.ts"), "");
  writeFileSync(join(p.path, "src", "parse-utils.ts"), "");
  mkdirSync(join(p.path, "parsers"));
  writeFileSync(join(p.path, "parsers", "index.ts"), "");
  writeFileSync(join(p.path, ".gitignore"), "secret.env\n");
  writeFileSync(join(p.path, "secret.env"), "");
  // A match in the file name beats one in a folder name.
  const found = await searchFiles(p.path, "pars");
  expect(found.slice(0, 2).sort()).toEqual(["src/deep/parser.ts", "src/parse-utils.ts"]);
  expect(found[2]).toBe("parsers/index.ts");
  expect(await searchFiles(p.path, "secret")).toEqual([]);
});

test("a Codex model error says how to fix it", () => {
  const raw = JSON.stringify({ type: "error", status: 400, error: { message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." } });
  expect(readableError(raw)).toBe("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account. Update Codex (run `codex update`) or choose another model in the chat settings.");
  expect(readableError("Network down")).toBe("Network down");
});
