import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { run } from "./git";

export interface ClaudeProject {
  path: string;
  name: string;
  lastUsed: string | null;
}

interface Dirs {
  homeDir?: string;
  configDir?: string;
  /** Paths under these prefixes are skipped (scratch/temp sessions). */
  excludePrefixes?: string[];
}

function configDirOf(d: Dirs): string {
  return d.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(d.homeDir ?? homedir(), ".claude");
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Claude Code stores sessions under ~/.claude/projects/<cwd with every non-alphanumeric char as "-">. */
export function encodeProjectDir(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

const TEMP_PREFIXES = ["/tmp/", "/private/tmp/", "/private/var/folders/", "/var/folders/", tmpdir() + "/"];

/** Folders the user has run Claude Code in, most recent session first. */
export function listClaudeProjects(d: Dirs = {}): ClaudeProject[] {
  const home = d.homeDir ?? homedir();
  const configDir = configDirOf(d);
  // ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json when Claude Code is configured that way.
  const stateDir = !d.homeDir && process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR : home;
  const state = readJson(join(stateDir, ".claude.json"));
  const exclude = d.excludePrefixes ?? TEMP_PREFIXES;
  const paths = Object.keys(state?.projects ?? {});
  const out: ClaudeProject[] = [];
  for (const path of paths) {
    if (exclude.some((p) => path.startsWith(p))) continue;
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const sessions = join(configDir, "projects", encodeProjectDir(path));
    let lastUsed: string | null = null;
    try {
      lastUsed = statSync(sessions).mtime.toISOString();
    } catch {}
    out.push({ path, name: basename(path), lastUsed });
  }
  return out.sort((a, b) => {
    if (a.lastUsed && b.lastUsed) return b.lastUsed.localeCompare(a.lastUsed);
    if (a.lastUsed) return -1;
    if (b.lastUsed) return 1;
    return a.path.localeCompare(b.path);
  });
}

/** User-level Claude Code defaults (runs without --model inherit these automatically). */
export function claudeDefaults(d: Dirs = {}): { model: string | null } {
  const settings = readJson(join(configDirOf(d), "settings.json"));
  return { model: typeof settings?.model === "string" && settings.model ? settings.model : null };
}

/** Native macOS folder chooser. Returns null when cancelled or unsupported. */
export async function pickFolder(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const script = `tell application (path to frontmost application as text) to POSIX path of (choose folder with prompt "Choose a folder for this board")`;
  const r = await run(["osascript", "-e", script], homedir());
  if (r.code !== 0) return null;
  const path = r.stdout.trim().replace(/\/+$/, "");
  return path && existsSync(path) ? path : null;
}

export interface ClaudeSession {
  id: string;
  title: string | null;
  firstPrompt: string | null;
  lastActive: string;
}

function promptText(content: unknown): string | null {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) ? content.map((c: any) => (c?.type === "text" ? c.text : "")).join(" ") : "";
  const t = text.trim();
  // Skip slash-command / hook wrappers Claude Code stores as user messages.
  if (!t || t.startsWith("<") || /^(Base directory for this skill|Caveat:|\[Request interrupted)/.test(t)) return null;
  return t.replace(/\s+/g, " ").slice(0, 160);
}

/** Claude Code sessions started in `projectPath`, most recently active first. */
export function listSessions(projectPath: string, d: Dirs = {}, limit = 50): ClaudeSession[] {
  const dir = join(configDirOf(d), "projects", encodeProjectDir(projectPath));
  let files: { id: string; file: string; mtime: Date }[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ id: f.slice(0, -6), file: join(dir, f), mtime: statSync(join(dir, f)).mtime }));
  } catch {
    return [];
  }
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return files.slice(0, limit).map(({ id, file, mtime }) => ({ id, ...sessionNames(file), lastActive: mtime.toISOString() }));
}

/** A session's name (custom or AI title) and its first real prompt. */
function sessionNames(file: string): { title: string | null; firstPrompt: string | null } {
  let title: string | null = null;
  let aiTitle: string | null = null;
  let firstPrompt: string | null = null;
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {}
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const isTitle = line.includes('"custom-title"') || line.includes('"ai-title"');
    if (!isTitle && (firstPrompt || !line.includes('"user"'))) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "custom-title" && typeof ev.customTitle === "string") title = ev.customTitle;
    else if (ev.type === "ai-title" && typeof ev.aiTitle === "string") aiTitle = ev.aiTitle;
    else if (!firstPrompt && ev.type === "user" && ev.message?.role === "user") firstPrompt = promptText(ev.message.content);
  }
  return { title: title ?? aiTitle, firstPrompt };
}

export interface TerminalSession extends ClaudeSession {
  /** The folder it runs in. */
  cwd: string;
  /** Open in a terminal now. */
  live: boolean;
  /** Open and waiting on the user: a question, a permission or another dialog. */
  needsYou: boolean;
}

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
 * Started by the user in a terminal: the board's own runs (sdk-cli), the desktop app and SDK scripts (Hindsight's
 * survey runs) are left out, and so are helper sessions the board starts under its own data folder.
 */
export function isTerminalSession(o: { entrypoint: string | null; cwd: string | null }, skip: string[] = []): boolean {
  return o.entrypoint === "cli" && !!o.cwd && !skip.some((p) => o.cwd === p || o.cwd!.startsWith(`${p}/`));
}

function readHead(file: string, bytes = 65536): string {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, bytes, 0));
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
export function openSessions(d: Dirs = {}): Map<string, { status?: string }> {
  const dir = join(configDirOf(d), "sessions");
  const out = new Map<string, { status?: string }>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {}
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    const s = readJson(join(dir, n));
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

function readTail(file: string, bytes = 65536): string {
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    fd = openSync(file, "r");
    const buf = Buffer.alloc(Math.min(bytes, size));
    return buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, size - buf.length));
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// Where and how a session started never changes; titles are re-read when the file does.
const origins = new Map<string, { entrypoint: string | null; cwd: string | null }>();
const names = new Map<string, { key: string; title: string | null; firstPrompt: string | null }>();

/** The most recent sessions the user started in a terminal, across all folders, newest first. */
export function listTerminalSessions(commands: string[], d: Dirs = {}, skip: string[] = [], limit = 20): TerminalSession[] {
  const root = join(configDirOf(d), "projects");
  const files: { id: string; file: string; mtime: Date; size: number }[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {}
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(root, dir));
    } catch {}
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const st = statSync(join(root, dir, f));
        files.push({ id: f.slice(0, -6), file: join(root, dir, f), mtime: st.mtime, size: st.size });
      } catch {}
    }
  }
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const open = openSessions(d);
  const out: TerminalSession[] = [];
  const seen = new Set<string>();
  for (const { id, file, mtime, size } of files) {
    if (out.length >= limit) break;
    // A project folder can be linked under a second name (a renamed folder): the same session twice.
    if (seen.has(id)) continue;
    seen.add(id);
    let origin = origins.get(file);
    if (!origin) {
      origin = sessionOrigin(readHead(file));
      // A file too new to have its first message yet is checked again next time.
      if (origin.entrypoint) origins.set(file, origin);
    }
    if (!isTerminalSession(origin, skip)) continue;
    const key = `${size}:${mtime.getTime()}`;
    let n = names.get(file);
    if (n?.key !== key) {
      n = { key, ...sessionNames(file) };
      names.set(file, n);
    }
    const live = open.has(id) || liveSessionMatch(commands, { id, title: n.title });
    out.push({
      id, title: n.title, firstPrompt: n.firstPrompt, lastActive: mtime.toISOString(), cwd: origin.cwd!, live,
      needsYou: live && (open.get(id)?.status === "waiting" || pendingQuestion(readTail(file))),
    });
  }
  return out;
}

/** True if any process command line looks like a claude CLI resuming this session (by id or title). */
export function liveSessionMatch(commands: string[], s: { id: string; title: string | null }): boolean {
  return commands.some((cmd) => {
    if (!/(^|[\s/])claude(\s|$)|claude(-code)?\/cli\.js/.test(cmd)) return false;
    if (cmd.includes(s.id)) return true;
    return !!s.title && cmd.includes(s.title);
  });
}

export async function processCommands(): Promise<string[]> {
  const r = await run(["ps", "-axo", "args="], homedir());
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

export async function isSessionLive(id: string, title: string | null): Promise<boolean> {
  return liveSessionMatch(await processCommands(), { id, title });
}

export function sessionTitle(projectPath: string, id: string, d: Dirs = {}): string | null {
  return listSessions(projectPath, d, 500).find((s) => s.id === id)?.title ?? null;
}

/** The folder a session file belongs to (Claude resumes it only from there); null when it's gone or unclear. */
export function sessionFolder(file: string): string | null {
  const { cwd } = sessionOrigin(readHead(file));
  if (!cwd || !existsSync(cwd)) return null;
  let dir = dirname(file);
  try {
    dir = realpathSync(dir);
  } catch {}
  return encodeProjectDir(cwd) === basename(dir) ? cwd : null;
}
