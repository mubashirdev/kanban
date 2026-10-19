// The Chats add-on: chats off the board run as typed in the board folder, read only or with edit access.
import { beforeEach, expect, test } from "bun:test";
import { chatRoutes, chatTurn, titleFrom } from "../src/server/addons/chats";
import { chatList, isUnread } from "../web/src/addons/chats/chatList";
import { attachCodex } from "../src/server/addons/codex/state";
import { board, bus, readArgs, setup, store, untilSpawned, useBoardEnv } from "./board-env";
import { until } from "./helpers";

useBoardEnv();

beforeEach(() => attachCodex(store, bus));

const post = (path: string, body: unknown, headers: Record<string, string> = { origin: "http://localhost" }) =>
  chatRoutes(new Request(`http://localhost/api/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
    path.split("/"), { store, board, bus });

const body = async (r: Response | null): Promise<any> => r!.json();

async function chat(access: "read" | "edit") {
  await setup();
  const t = await board.createTicket("p", { title: "Chat", body: "", status: "backlog" });
  store.updateTicket("p", t.id, { standalone: true, access } as any);
  return t.id;
}

test("chatTurn: a chat's message goes as typed and quietly; board tickets are left to Leo's chatFor", () => {
  expect(chatTurn({ status: "backlog" }, { text: "hi" })).toBeNull();
  expect(chatTurn({ standalone: true }, { text: "hi" })).toEqual({ text: "hi", mode: "refine", raw: true, quiet: true });
  expect(chatTurn({ standalone: true, access: "edit" }, { text: "/compact", slash: "local" })).toEqual({ text: "/compact", mode: "act", raw: true, quiet: true, slash: "local" });
});

test("titleFrom names a chat after its first line", () => {
  expect(titleFrom("Why is the PC going to sleep?\nmore")).toBe("Why is the PC going to sleep?");
  expect(titleFrom("x".repeat(80))).toHaveLength(58);
});

test("a read-only chat runs in the board folder with the message as typed, can't edit, and stays in Backlog", async () => {
  const id = await chat("read");
  await board.chat("p", id, "What does main.ts do?");
  await untilSpawned();
  await until(() => !board.isRunning("p", id));
  const [run] = readArgs();
  const t = store.getTicket("p", id)!;
  expect(run.cwd).toBe(store.getProfile("p")!.path);
  expect(t.worktree).toBeNull();
  expect(run.prompt).toBe("What does main.ts do?");
  expect(run.args[run.args.indexOf("--disallowedTools") + 1]).toContain("Edit");
  expect(run.args[run.args.indexOf("--append-system-prompt") + 1]).toContain("Access right now: read only");
  expect(t.status).toBe("backlog");
  expect(t.runCount).toBe(0);
});

test("a chat that can edit has its edit tools", async () => {
  const id = await chat("edit");
  await board.chat("p", id, "Fix the typo");
  await untilSpawned();
  await until(() => !board.isRunning("p", id));
  const [run] = readArgs();
  expect(run.args).not.toContain("--disallowedTools");
  expect(run.args[run.args.indexOf("--append-system-prompt") + 1]).toContain("Access right now: can edit");
  expect(store.getTicket("p", id)!.status).toBe("backlog");
});

test("routes: start a chat, switch access, mark read and unread, move between board and Chats", async () => {
  await setup();
  const started = await body(await post("addons/chats/boards/p", { text: "Hello there", access: "edit", agent: "claude" }));
  expect(started).toMatchObject({ title: "Hello there", standalone: true, access: "edit", status: "backlog" });
  await until(() => !board.isRunning("p", started.id));

  const read = await body(await post(`addons/chats/tickets/${started.id}/access`, { access: "read" }));
  expect(read.access).toBe("read");
  const unread = await body(await post(`addons/chats/tickets/${started.id}/read`, { read: false }));
  expect(unread.readAt).toBe(new Date(0).toISOString());
  const seen = await body(await post(`addons/chats/tickets/${started.id}/read`, { read: true }));
  expect(seen.readAt > unread.readAt).toBe(true);

  const ticket = await board.createTicket("p", { title: "Board work", body: "", status: "review" });
  const moved = await body(await post(`addons/chats/tickets/${ticket.id}/move`, { to: "chats" }));
  expect(moved).toMatchObject({ standalone: true, access: "read", status: "backlog" });
  const back = await body(await post(`addons/chats/tickets/${ticket.id}/move`, { to: "board" }));
  expect(back.standalone).toBe(false);
  expect(back.access).toBeUndefined();
});

test("routes refuse board runs and requests without the browser's Origin", async () => {
  await setup();
  expect((await post("addons/chats/boards/p", { text: "hi" }, {}))!.status).toBe(403);
  expect((await post("addons/chats/boards/p", { text: "hi" }, { origin: "http://localhost", "x-ckanban-run": "1" }))!.status).toBe(403);
  expect(await chatRoutes(new Request("http://localhost/api/profiles"), ["profiles"], { store, board, bus })).toBeNull();
});

test("the Chats list: only chats, newest message first, search, and unread after the last look", () => {
  const msg = (role: string, at: string, text = "") => ({ lastMessage: { role, at, text } });
  const tickets = [
    { title: "Board work", createdAt: "2026-10-01" },
    { title: "Old chat", standalone: true, createdAt: "2026-10-01", readAt: "2026-10-03", session: msg("assistant", "2026-10-02", "done") },
    { title: "New chat", standalone: true, createdAt: "2026-10-01", readAt: "2026-10-03", session: msg("assistant", "2026-10-05", "the PC sleeps") },
  ];
  expect(chatList(tickets, "").map((t) => t.title)).toEqual(["New chat", "Old chat"]);
  expect(chatList(tickets, "sleeps").map((t) => t.title)).toEqual(["New chat"]);
  expect(isUnread(tickets[2])).toBe(true);
  expect(isUnread(tickets[1])).toBe(false);
  // Running, or the user spoke last: nothing unread yet. No readAt (never opened): unread.
  expect(isUnread({ ...tickets[2], running: true })).toBe(false);
  expect(isUnread({ ...tickets[2], session: msg("user", "2026-10-06") })).toBe(false);
  expect(isUnread({ ...tickets[2], readAt: null })).toBe(true);
});
