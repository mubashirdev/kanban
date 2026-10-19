// On this Mac (Chats add-on): Claude sessions started in a terminal, in any folder, and Continue here.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeProjectDir } from "../src/server/claude";
import { isTerminalSession, listTerminalSessions, pendingQuestion, sessionFolder, sessionOrigin, terminalRoutes } from "../src/server/addons/terminal-sessions";
import { SessionCache } from "../src/server/session";
import { board, bus, readArgs, setup, store, untilSpawned, useBoardEnv } from "./board-env";
import { tempDir, until } from "./helpers";

useBoardEnv();

const id = (n: number) => `0000000${n}-0000-0000-0000-000000000000`;

/** A session file as Claude Code writes it, last changed on `day`. */
function write(configDir: string, folder: string, sid: string, entrypoint: string, day: string, extra: object[] = []) {
  const dir = join(configDir, "projects", encodeProjectDir(folder));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, [
    JSON.stringify({ type: "user", uuid: `${sid}-u`, timestamp: day, cwd: folder, entrypoint, message: { role: "user", content: `work in ${folder}` } }),
    ...extra.map((e) => JSON.stringify(e)),
  ].join("\n") + "\n");
  utimesSync(file, new Date(day), new Date(day));
  return file;
}

test("isTerminalSession keeps only sessions the user started in a terminal", () => {
  expect(isTerminalSession({ entrypoint: "cli", cwd: "/Users/x/travelz" })).toBe(true);
  expect(isTerminalSession({ entrypoint: "sdk-cli", cwd: "/Users/x/travelz" })).toBe(false);
  expect(isTerminalSession({ entrypoint: "sdk-py", cwd: "/Users/x" })).toBe(false);
  expect(isTerminalSession({ entrypoint: "claude-desktop", cwd: "/Users/x" })).toBe(false);
  expect(isTerminalSession({ entrypoint: null, cwd: "/Users/x" })).toBe(false);
  expect(isTerminalSession({ entrypoint: "cli", cwd: null })).toBe(false);
  expect(isTerminalSession({ entrypoint: "cli", cwd: "/Users/x/.claude-kanban/artifact-helper" }, ["/Users/x/.claude-kanban"])).toBe(false);
  expect(isTerminalSession({ entrypoint: "cli", cwd: "/Users/x/.claude-kanban-other" }, ["/Users/x/.claude-kanban"])).toBe(true);
});

test("sessionOrigin reads entrypoint and folder from the first lines", () => {
  const head = [
    JSON.stringify({ type: "file-history-snapshot" }),
    JSON.stringify({ type: "user", cwd: "/Users/x/my \"app\"", entrypoint: "cli", message: { role: "user", content: "hi" } }),
  ].join("\n");
  expect(sessionOrigin(head)).toEqual({ entrypoint: "cli", cwd: "/Users/x/my \"app\"" });
  expect(sessionOrigin("")).toEqual({ entrypoint: null, cwd: null });
});

test("a session whose first lines are long (a resumed one) is still found", () => {
  const configDir = tempDir();
  write(configDir, "/Users/x/kanban", id(9), "cli", "2026-10-07");
  const file = join(configDir, "projects", encodeProjectDir("/Users/x/kanban"), `${id(9)}.jsonl`);
  const snapshot = JSON.stringify({ type: "file-history-snapshot", snapshot: "x".repeat(200_000) });
  writeFileSync(file, `${snapshot}\n${readFileSync(file, "utf8")}`);
  const list = listTerminalSessions(new SessionCache({ configDir }), [], [], 20, configDir);
  expect(list.map((s) => s.id)).toEqual([id(9)]);
});

test("pendingQuestion: an unanswered AskUserQuestion or plan approval", () => {
  const use = (tid: string, name: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: tid, name, input: {} }] } });
  const result = (tid: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: tid, content: "ok" }] } });
  expect(pendingQuestion(use("a", "AskUserQuestion"))).toBe(true);
  expect(pendingQuestion([use("a", "AskUserQuestion"), result("a")].join("\n"))).toBe(false);
  expect(pendingQuestion(use("p", "ExitPlanMode"))).toBe(true);
  expect(pendingQuestion(use("b", "Bash"))).toBe(false);
  expect(pendingQuestion("{broken")).toBe(false);
});

test("listTerminalSessions: newest terminal sessions across folders, board runs and the desktop app left out", () => {
  const configDir = tempDir();
  write(configDir, "/Users/x/travelz", id(1), "cli", "2026-10-01");
  write(configDir, "/Users/x/travelz/api", id(2), "cli", "2026-10-03", [{ type: "ai-title", aiTitle: "Fix the API" }]);
  write(configDir, "/Users/x/kanban", id(3), "sdk-cli", "2026-10-04");
  write(configDir, "/Users/x", id(4), "claude-desktop", "2026-10-05");
  write(configDir, "/Users/x/.claude-kanban/artifact-helper", id(5), "cli", "2026-10-06");
  write(configDir, "/Users/x/app", id(6), "cli", "2026-10-02", [{ type: "assistant", message: { content: [{ type: "tool_use", id: "q", name: "AskUserQuestion", input: {} }] } }]);
  // A renamed project folder linked under its old name lists the same sessions twice.
  symlinkSync(join(configDir, "projects", encodeProjectDir("/Users/x/travelz")), join(configDir, "projects", "-Users-x-old-travelz"));
  // Open in a terminal (Claude Code's status file), waiting on a permission prompt.
  mkdirSync(join(configDir, "sessions"));
  writeFileSync(join(configDir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id(1), status: "waiting" }));

  const sessions = new SessionCache({ configDir });
  const list = listTerminalSessions(sessions, [`claude --resume ${id(6)}`], ["/Users/x/.claude-kanban"], 20, configDir);
  expect(list.map((s) => s.id)).toEqual([id(2), id(6), id(1)]);
  expect(list[0]).toMatchObject({ title: "Fix the API", firstPrompt: "work in /Users/x/travelz/api", cwd: "/Users/x/travelz/api", live: false, needsYou: false });
  expect(list[1]).toMatchObject({ live: true, needsYou: true });
  expect(list[2]).toMatchObject({ live: true, needsYou: true });
  expect(listTerminalSessions(sessions, [], [], 1, configDir).map((s) => s.id)).toEqual([id(5)]);
});

test("sessionFolder: the folder Claude can resume the session from", () => {
  const configDir = tempDir();
  const folder = tempDir();
  const dir = join(configDir, "projects", encodeProjectDir(folder));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "s.jsonl");
  writeFileSync(file, JSON.stringify({ type: "user", cwd: folder, entrypoint: "cli" }) + "\n");
  expect(sessionFolder(file)).toBe(folder);
  mkdirSync(join(configDir, "projects", "-other"));
  const elsewhere = join(configDir, "projects", "-other", "s.jsonl");
  writeFileSync(elsewhere, JSON.stringify({ type: "user", cwd: folder }) + "\n");
  expect(sessionFolder(elsewhere)).toBeNull();
  const linked = join(configDir, "projects", "-linked");
  symlinkSync(dir, linked);
  expect(sessionFolder(join(linked, "s.jsonl"))).toBe(folder);
});

test("routes: list, read a page, and Continue here makes a chat that resumes the session in its own folder", async () => {
  await setup();
  const configDir = process.env.CLAUDE_CONFIG_DIR!;
  const folder = tempDir("ck-terminal-");
  const replies = Array.from({ length: 3 }, (_, n) => ({
    type: "assistant", uuid: `r${n}`, timestamp: "2026-10-02", message: { role: "assistant", content: [{ type: "text", text: `reply ${n}` }] },
  }));
  write(configDir, folder, id(7), "cli", "2026-10-02", replies);
  write(configDir, "/Users/x/kanban", id(8), "sdk-cli", "2026-10-03");
  const sessions = new SessionCache();
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { origin: "http://localhost" }) =>
    terminalRoutes(new Request(`http://localhost/api/${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined }),
      path.split("?")[0].split("/"), { store, board, bus, sessions }).then((r) => r!.json().then((data: any) => ({ status: r!.status, data })));

  const list = await call("GET", "addons/terminal/boards/p");
  expect(list.data.map((s: any) => s.id)).toEqual([id(7)]);
  expect(list.data[0]).toMatchObject({ cwd: folder, firstPrompt: `work in ${folder}`, ticket: null });

  const page = await call("GET", `addons/terminal/sessions/${id(7)}?limit=2`);
  expect(page.data).toMatchObject({ start: 2, total: 4 });
  expect(page.data.entries.map((e: any) => e.text)).toEqual(["reply 1", "reply 2"]);
  const earlier = await call("GET", `addons/terminal/sessions/${id(7)}?before=2`);
  expect(earlier.data.start).toBe(0);
  // A board run's own session is not served.
  expect((await call("GET", `addons/terminal/sessions/${id(8)}`)).status).toBe(404);
  expect((await call("POST", "addons/terminal/boards/p/continue", { sessionId: id(8) })).status).toBe(404);
  // Board runs and requests without the browser's Origin can't continue a session.
  expect((await call("POST", "addons/terminal/boards/p/continue", { sessionId: id(7) }, {})).status).toBe(403);
  expect((await call("GET", "addons/terminal/boards/p", undefined, { "x-ckanban-run": "p/t_1" })).status).toBe(403);

  const chat = (await call("POST", "addons/terminal/boards/p/continue", { sessionId: id(7) })).data;
  expect(chat).toMatchObject({ standalone: true, access: "edit", status: "backlog", sessionId: id(7), workdir: folder });
  expect(chat.title).toStartWith("work in ");
  // Two taps at once make one chat.
  write(configDir, folder, id(6), "cli", "2026-10-01");
  const [a, b] = await Promise.all([1, 2].map(() => call("POST", "addons/terminal/boards/p/continue", { sessionId: id(6) })));
  expect(a.data.id).toBe(b.data.id);
  expect(store.listTickets("p").filter((t) => t.sessionId === id(6))).toHaveLength(1);
  // Continue here again opens the same chat.
  expect((await call("POST", "addons/terminal/boards/p/continue", { sessionId: id(7) })).data.id).toBe(chat.id);
  expect((await call("GET", "addons/terminal/boards/p")).data[0].ticket).toEqual({ id: chat.id, title: chat.title });

  await board.chat("p", chat.id, "What did we do?");
  await untilSpawned();
  await until(() => !board.isRunning("p", chat.id));
  const [run] = readArgs();
  expect(run.cwd).toBe(folder);
  expect(run.args[run.args.indexOf("--resume") + 1]).toBe(id(7));
  expect(run.prompt).toBe("What did we do?");
  expect(store.getTicket("p", chat.id)!.status).toBe("backlog");
});
