import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";
import { makeRepo, tempDir } from "./helpers";

const FAKE_CLAUDE = join(import.meta.dir, "fixtures", "fake-claude.ts");
const saved = { ...process.env };

let store: Store, bus: Bus, board: Board, argsFile: string;

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  board = new Board(store, bus, { claudeBin: FAKE_CLAUDE, isSessionLive: async () => false, sessionExists: () => false });
  argsFile = join(tempDir("ck-args-"), "args.jsonl");
  Object.assign(process.env, { FAKE_ARGS_FILE: argsFile, FAKE_MODE: "ok" });
});
afterEach(() => {
  for (const key of ["FAKE_ARGS_FILE", "FAKE_MODE"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function setup(): Promise<Profile> {
  const p: Profile = { name: "P", slug: "p", path: await makeRepo(), baseBranch: "main", maxParallel: 1, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p);
  return p;
}
const lastCall = () => readFileSync(argsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
const session = (input: Partial<Parameters<Store["createTicket"]>[1]> = {}) =>
  board.createTicket("p", { title: "Ask", body: "", status: "backlog", standalone: true, ...input });

test("forking a Claude chat copies its conversation into a new chat on another model and leaves the original alone", async () => {
  await setup();
  const original = await session({ title: "Parser question" });
  expect(board.fork("p", original.id)).rejects.toThrow("Send a first message");
  await board.chat("p", original.id, "What does the parser do?");
  await board.whenIdle();
  const parent = store.getTicket("p", original.id)!;

  const copy = await board.fork("p", original.id, { model: "haiku", text: "Same question, second opinion" });
  await board.whenIdle();
  expect(copy).toMatchObject({ title: "Fork of Parser question", standalone: true, access: "read", model: "haiku" });
  const first = lastCall();
  const arg = (name: string) => first.args[first.args.indexOf(name) + 1];
  expect(arg("--resume")).toBe(parent.sessionId);
  expect(first.args).toContain("--fork-session");
  expect(arg("--session-id")).toBe(store.getTicket("p", copy.id)!.sessionId);
  expect(arg("--session-id")).not.toBe(parent.sessionId);
  expect(arg("--model")).toBe("haiku");
  expect(first.prompt).toBe("Same question, second opinion");

  // Once the copy has its own session it is resumed like any chat, without forking again.
  await board.chat("p", copy.id, "And now?");
  await board.whenIdle();
  const next = lastCall();
  expect(next.args).not.toContain("--fork-session");
  expect(next.args[next.args.indexOf("--resume") + 1]).toBe(store.getTicket("p", copy.id)!.sessionId);
  expect(store.getTicket("p", copy.id)!.forkOf).toBeNull();
  expect(store.getTicket("p", original.id)!.sessionId).toBe(parent.sessionId);
});

test("a fork whose first run failed forks again on retry, and /clear drops the fork", async () => {
  await setup();
  const original = await session();
  await board.chat("p", original.id, "Hello");
  await board.whenIdle();
  const copy = await board.fork("p", original.id);
  process.env.FAKE_MODE = "fail";
  await board.chat("p", copy.id, "Try");
  await board.whenIdle();
  expect(store.getTicket("p", copy.id)!.forkOf).toBe(store.getTicket("p", original.id)!.sessionId);
  process.env.FAKE_MODE = "ok";
  await board.chat("p", copy.id, "Try again");
  await board.whenIdle();
  expect(lastCall().args).toContain("--fork-session");
  expect(store.getTicket("p", copy.id)!.forkOf).toBeNull();

  const other = await board.fork("p", original.id);
  await board.chat("p", other.id, "/clear");
  expect(store.getTicket("p", other.id)!.forkOf).toBeNull();
});

test("only idle Claude chats in the repo folder can be forked, and the API says why", async () => {
  await setup();
  const codex = await session({ agent: "codex" });
  expect(board.fork("p", codex.id)).rejects.toThrow("Codex chats can't be forked");
  const ticket = await board.createTicket("p", { title: "Board ticket", body: "", status: "backlog" });
  expect(board.fork("p", ticket.id)).rejects.toThrow("Only chats");

  const server = createServer({ store, bus, board, port: 0, webDir: tempDir() });
  const base = `http://127.0.0.1:${server.port}/api/profiles/p/tickets`;
  const post = (id: string, body: unknown) => fetch(`${base}/${id}/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const chat = await session();
    await board.chat("p", chat.id, "Hello");
    await board.whenIdle();
    expect((await post(chat.id, { model: "bad model!" })).status).toBe(400);
    expect((await post(codex.id, {})).status).toBe(400);
    const ok = await post(chat.id, { model: "haiku" });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ title: "Fork of Ask", model: "haiku" });
  } finally {
    server.stop(true);
  }
});

test("the last message is kept on the chat for retry, and a new conversation forgets it", async () => {
  await setup();
  const chat = await session();
  await board.chat("p", chat.id, "check the failing test");
  await board.whenIdle();
  expect(store.getTicket("p", chat.id)?.lastPrompt).toBe("check the failing test");
  await board.chat("p", chat.id, "/clear");
  expect(store.getTicket("p", chat.id)?.lastPrompt).toBeNull();
});
