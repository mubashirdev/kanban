import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Board } from "../board";
import { encodeProjectDir, liveSessionMatch, processCommands } from "../claude";
import type { Bus } from "../events";
import { HUDDLE_HEADER } from "../huddle-roster";
import { RUN_HEADER } from "../scheduler";
import type { SessionCache } from "../session";
import type { Store } from "../store";
import type { Ticket } from "../types";
import { titleFrom } from "./chats";

/**
 * On this Mac (Chats): the Claude sessions the user started in a terminal, in any folder. Leo's SessionCache reads
 * each one (title, messages); this file only finds them and says which are open or wait on the user.
 */
export interface TerminalSession {
  id: string;
  title: string | null;
  firstPrompt: string | null;
  lastActive: string;
  /** The folder it runs in. */
  cwd: string;
  /** Open in a terminal now. */
  live: boolean;
  /** Open and waiting on the user: a question, a permission or another dialog. */
  needsYou: boolean;
}

const configDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

/** How a session was started and where, from the first lines of its file. */
export function sessionOrigin(head: string): { entrypoint: string | null; cwd: string | null } {
  const field = (name: string) => {
    const m = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`).exec(head);
    if (!m) return null;
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return null;
    }
  };
  return { entrypoint: field("entrypoint"), cwd: field("cwd") };
}

/**
 * Started by the user in a terminal: the board's own runs (sdk-cli), the desktop app and SDK scripts are left out,
 * and so are helper sessions the board starts under its own data folder.
 */
export function isTerminalSession(o: { entrypoint: string | null; cwd: string | null }, skip: string[] = []): boolean {
  return o.entrypoint === "cli" && !!o.cwd && !skip.some((p) => o.cwd === p || o.cwd!.startsWith(`${p}/`));
}

// The first lines can be long (a resumed session starts with big snapshot lines), so the start is read generously.
const HEAD_BYTES = 1 << 20;

function readPart(file: string, from: "head" | "tail", bytes = from === "head" ? HEAD_BYTES : 65536): string {
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    fd = openSync(file, "r");
    const buf = Buffer.alloc(Math.min(bytes, size));
    return buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, from === "head" ? 0 : size - buf.length));
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Claude Code keeps a status file per open interactive session (~/.claude/sessions/<pid>.json); by session id. */
export function openSessions(dir = join(configDir(), "sessions")): Map<string, { status?: string }> {
  const out = new Map<string, { status?: string }>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {}
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    let s: any = null;
    try {
      s = JSON.parse(readFileSync(join(dir, n), "utf8"));
    } catch {}
    if (typeof s?.sessionId === "string" && pidAlive(s.pid)) out.set(s.sessionId, s);
  }
  return out;
}

/** A question or plan approval the session asked and got no answer to yet (older Claude Code has no status file). */
export function pendingQuestion(tail: string): boolean {
  const asked = new Set<string>();
  for (const line of tail.split("\n")) {
    if (!line.includes("tool_")) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use" && (b.name === "AskUserQuestion" || b.name === "ExitPlanMode")) asked.add(b.id);
      else if (b?.type === "tool_result") asked.delete(b.tool_use_id);
    }
  }
  return asked.size > 0;
}

/** The folder a session file belongs to (Claude resumes it only from there); null when it's gone or unclear. */
export function sessionFolder(file: string): string | null {
  const { cwd } = sessionOrigin(readPart(file, "head"));
  if (!cwd || !existsSync(cwd)) return null;
  let dir = dirname(file);
  try {
    dir = realpathSync(dir);
  } catch {}
  return encodeProjectDir(cwd) === basename(dir) ? cwd : null;
}

/** A session's name and its first message, from Leo's parsed session. */
function namesOf(sessions: SessionCache, id: string): { title: string | null; firstPrompt: string | null } {
  const parsed = sessions.get(id);
  const first = parsed?.entries.find((e) => e.role === "user" && e.kind === "text" && e.text.trim());
  return { title: parsed?.title ?? null, firstPrompt: first ? first.text.replace(/\s+/g, " ").slice(0, 160) : null };
}

// Where and how a session started never changes.
const origins = new Map<string, { entrypoint: string | null; cwd: string | null }>();

/** The most recent sessions the user started in a terminal, across all folders, newest first. */
export function listTerminalSessions(sessions: SessionCache, commands: string[], skip: string[] = [], limit = 20, root = configDir()): TerminalSession[] {
  const projects = join(root, "projects");
  const files: { id: string; file: string; mtime: Date }[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(projects);
  } catch {}
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(projects, dir));
    } catch {}
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        files.push({ id: f.slice(0, -6), file: join(projects, dir, f), mtime: statSync(join(projects, dir, f)).mtime });
      } catch {}
    }
  }
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const open = openSessions(join(root, "sessions"));
  const out: TerminalSession[] = [];
  const seen = new Set<string>();
  for (const { id, file, mtime } of files) {
    if (out.length >= limit) break;
    // A project folder can be linked under a second name (a renamed folder): the same session twice.
    if (seen.has(id)) continue;
    seen.add(id);
    let origin = origins.get(file);
    if (!origin) {
      origin = sessionOrigin(readPart(file, "head"));
      // A file too new to have its first message yet is checked again next time.
      if (origin.entrypoint || origin.cwd) origins.set(file, origin);
    }
    if (!isTerminalSession(origin, skip)) continue;
    const { title, firstPrompt } = namesOf(sessions, id);
    const live = open.has(id) || liveSessionMatch(commands, { id, title });
    out.push({
      id, title, firstPrompt, lastActive: mtime.toISOString(), cwd: origin.cwd!, live,
      needsYou: live && (open.get(id)?.status === "waiting" || pendingQuestion(readPart(file, "tail"))),
    });
  }
  return out;
}

// Continue here twice at once (a double tap) gets the first chat, not a second one on the same session.
const continuing = new Map<string, Promise<Ticket>>();

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const error = (status: number, message: string) => json({ error: message }, status);
const SESSION_ID = /^[0-9a-f-]{36}$/i;

/**
 * The On this Mac routes, only for the user (not board runs or huddle teammates):
 * - GET /api/addons/terminal/boards/:slug: the newest terminal sessions, with the chat on that board that continues each.
 * - GET /api/addons/terminal/sessions/:id?before=N: one session's messages, a page at a time (newest last).
 * - POST /api/addons/terminal/boards/:slug/continue {sessionId}: a chat on that board that continues the session in its folder.
 */
export async function terminalRoutes(req: Request, parts: string[], deps: { store: Store; board: Board; bus: Bus; sessions: SessionCache }): Promise<Response | null> {
  if (parts[0] !== "addons" || parts[1] !== "terminal") return null;
  if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) return error(403, "only the user can do this");
  const { store, board, bus, sessions } = deps;
  const [, , what, key, action] = parts;
  // Only sessions the list could show, never a board run's own.
  const terminalFile = (id: string) => {
    const file = sessions.file(id);
    return file && isTerminalSession(sessionOrigin(readPart(file, "head")), [store.root]) ? file : null;
  };
  const linked = (slug: string) => new Map(store.listTickets(slug).filter((t) => t.sessionId).map((t) => [t.sessionId!, t]));

  if (req.method === "GET" && what === "boards" && parts.length === 4) {
    if (!store.getProfile(key)) return error(404, `board ${key} not found`);
    const chats = linked(key);
    return json(listTerminalSessions(sessions, await processCommands(), [store.root]).map((s) => {
      const t = chats.get(s.id);
      return { ...s, ticket: t ? { id: t.id, title: t.title } : null };
    }));
  }

  if (req.method === "GET" && what === "sessions" && parts.length === 4) {
    if (!SESSION_ID.test(key)) return error(400, "invalid session id");
    if (!terminalFile(key)) return error(404, "No terminal session with that id");
    const parsed = sessions.get(key);
    if (!parsed) return error(404, "session not found");
    const all = parsed.entries;
    const url = new URL(req.url);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : all.length;
    const end = Math.max(0, Math.min(all.length, before || 0));
    const start = Math.max(0, end - limit);
    return json({ entries: all.slice(start, end), start, total: all.length, title: parsed.title });
  }

  if (req.method === "POST" && what === "boards" && action === "continue" && parts.length === 5) {
    // Browsers always send Origin on a POST (Leo's gate already checked it matches); a bare curl from a run doesn't.
    if (!req.headers.get("origin")) return error(403, "only the user can do this");
    if (!store.getProfile(key)) return error(404, `board ${key} not found`);
    const b: any = await req.json().catch(() => null);
    const sessionId = String(b?.sessionId ?? "");
    if (!SESSION_ID.test(sessionId)) return error(400, "invalid session id");
    const pending = continuing.get(sessionId);
    if (pending) return json(await pending);
    const already = linked(key).get(sessionId);
    if (already) return json(already);
    const file = terminalFile(sessionId);
    if (!file) return error(404, "No terminal session with that id");
    const folder = sessionFolder(file);
    if (!folder) return error(404, "That session's folder is gone");
    const { title, firstPrompt } = namesOf(sessions, sessionId);
    const create = async () => {
      const t = await board.createTicket(key, { title: titleFrom(title ?? firstPrompt ?? "Terminal session"), body: "", status: "backlog" });
      // A chat (the Chats add-on's fields) that resumes the session in its own folder, like Leo's linkSession does.
      const fields = { standalone: true, access: "edit", readAt: new Date().toISOString(), sessionId, workdir: folder, lastRunAt: new Date().toISOString() };
      const chat = store.updateTicket(key, t.id, fields as Partial<Ticket>);
      bus.emit({ type: "ticket.updated", profile: key, ticket: chat });
      return chat;
    };
    const chat = create().finally(() => continuing.delete(sessionId));
    continuing.set(sessionId, chat);
    return json(await chat);
  }
  return error(404, "not found");
}
