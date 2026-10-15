import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSession } from "./session";
import type { Store } from "./store";

const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

/** Codex's own transcript of a thread: rollout-<time>-<id>.jsonl somewhere under sessions/. */
export function codexRolloutFile(threadId: string, home = codexHome()): string | null {
  const root = join(home, "sessions");
  if (!existsSync(root)) return null;
  const entry = readdirSync(root, { recursive: true, withFileTypes: true })
    .find((e) => e.isFile() && e.name.endsWith(`${threadId}.jsonl`));
  return entry ? join(entry.parentPath, entry.name) : null;
}

/** The command a Codex tool call ran, for the one-line tool summary. */
function toolCommand(payload: any): string {
  if (typeof payload.arguments === "string") {
    try { const args = JSON.parse(payload.arguments); if (args.cmd || args.command) return [args.cmd ?? args.command].flat().join(" "); } catch {}
  }
  const input = String(payload.input ?? payload.arguments ?? payload.name ?? "");
  const quoted = /cmd:\s*"((?:[^"\\]|\\.)*)"/.exec(input)?.[1];
  if (!quoted) return input.slice(0, 160);
  try { return JSON.parse(`"${quoted}"`); } catch { return quoted; }
}

/**
 * A Codex rollout as the stream events the board's Codex runner emits, so parseSession reads both alike.
 * The user's own words come from user_message events: plain user items also carry injected context.
 */
export function rolloutEvents(text: string, firstLine = 0): any[] {
  const out: any[] = [];
  text.split("\n").forEach((line, n) => {
    const i = firstLine + n;
    let e: any;
    try { e = JSON.parse(line); } catch { return; }
    const p = e.payload ?? {}, base = { provider: "codex", uuid: `rollout-${i}`, timestamp: e.timestamp };
    if (e.type === "event_msg" && p.type === "user_message" && typeof p.message === "string")
      out.push({ ...base, type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: p.message }] } });
    else if (e.type === "event_msg" && p.type === "agent_message" && typeof p.message === "string")
      out.push({ ...base, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: p.message }] } });
    else if (e.type === "event_msg" && p.type === "item_completed" && (p.item?.type === "UserMessage" || p.item?.type === "AgentMessage")) {
      // Codex 0.160+ no longer writes user_message/agent_message events; its messages arrive as completed items.
      const text = (p.item.content ?? []).map((part: any) => part.text ?? "").join("");
      if (!text) return;
      const role = p.item.type === "UserMessage" ? "user" : "assistant";
      out.push({ ...base, type: role, ...(role === "user" ? { isReplay: true } : { phase: p.item.phase }), message: { role, content: [{ type: "text", text }] } });
    }
    else if (e.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call"))
      out.push({ ...base, type: "assistant", message: { content: [{ type: "tool_use", id: p.call_id, name: "Bash", input: { command: toolCommand(p), ...(String(p.input ?? "").startsWith("*** Begin Patch") ? { patch: String(p.input) } : {}) } }] } });
    else if (e.type === "response_item" && (p.type === "function_call_output" || p.type === "custom_tool_call_output")) {
      const output = Array.isArray(p.output) ? p.output.map((o: any) => o.text ?? "").join("") : String(p.output ?? "");
      out.push({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: p.call_id, content: output }] } });
    }
  });
  return out;
}

/**
 * Reuse parsed transcripts between board polling, SSE views, and notification checks.
 * A ticket's Codex thread is read from Codex's own rollout (it also holds turns typed in a terminal);
 * without one, from the board's run activity after the last /clear.
 */
export class CodexSessions {
  private cache = new Map<string, { version: string; value: ReturnType<typeof parseSession> | null }>();
  /** Rollouts grow during a run and can be many MB: each read only takes the bytes added since the last one. */
  private rollouts = new Map<string, { file: string; offset: number; lines: number; events: any[] }>();
  private missed = new Map<string, number>();
  constructor(private store: Store, private home = codexHome()) {}

  /** Finding a rollout walks Codex's whole sessions folder, so a miss is only retried every 30s. */
  private rolloutFile(threadId: string): string | null {
    const known = this.rollouts.get(threadId)?.file;
    if (known && existsSync(known)) return known;
    if (Date.now() - (this.missed.get(threadId) ?? 0) < 30_000) return null;
    const file = codexRolloutFile(threadId, this.home);
    if (!file) this.missed.set(threadId, Date.now());
    return file;
  }

  private rolloutEvents(threadId: string, file: string, size: number): any[] {
    let r = this.rollouts.get(threadId);
    if (!r || r.file !== file || size < r.offset) r = { file, offset: 0, lines: 0, events: [] };
    if (size > r.offset) {
      const bytes = Buffer.alloc(size - r.offset);
      const fd = openSync(file, "r");
      try { readSync(fd, bytes, 0, bytes.length, r.offset); } finally { closeSync(fd); }
      // Only whole lines: a line still being written is read again next time.
      const cut = bytes.lastIndexOf(0x0a) + 1;
      const complete = bytes.subarray(0, cut).toString("utf8");
      r.events.push(...rolloutEvents(complete, r.lines));
      r.lines += complete.split("\n").length - 1;
      r.offset += cut;
    }
    this.rollouts.set(threadId, r);
    return r.events;
  }

  get(slug: string, id: string) {
    const key = `${slug}/${id}`;
    const threadId = this.store.getTicket(slug, id)?.codexSessionId;
    const file = threadId ? this.rolloutFile(threadId) : null;
    const size = file ? statSync(file).size : 0;
    const version = file ? `rollout:${file}:${size}` : this.store.activityVersion(slug, id);
    if (!version) {
      this.cache.delete(key);
      return null;
    }
    const cached = this.cache.get(key);
    if (cached?.version === version) return cached.value;
    const events = file ? this.rolloutEvents(threadId!, file, size) : this.activityEvents(slug, id);
    const value = events.length ? parseSession(events.map((event) => JSON.stringify(event)).join("\n")) : null;
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { version, value });
    return value;
  }

  private activityEvents(slug: string, id: string): any[] {
    const all = this.store.readActivity(slug, id).filter((entry) => (entry.event as any)?.provider === "codex");
    // /clear starts a new Codex thread; only show what came after it.
    const cleared = all.findLastIndex((entry) => (entry.event as any).type === "codex.clear");
    return all.slice(cleared + 1).map((entry) => ({ ...(entry.event as any), timestamp: entry.at }));
  }
}

export interface CodexSessionInfo { id: string; title: string | null; firstPrompt: string | null; lastActive: string }

/** The first thing the user typed, to name a session Codex never titled. */
async function firstPrompt(file: string): Promise<string | null> {
  const text = await Bun.file(file).slice(0, 256 * 1024).text();
  const line = text.split("\n").find((l) => l.includes('"type":"user_message"'));
  try {
    const message = line ? JSON.parse(line).payload?.message : null;
    return typeof message === "string" && message.trim() ? message.trim().slice(0, 200) : null;
  } catch {
    return null;
  }
}

/** Codex sessions started in this folder, newest first, read from Codex's own session files. */
export async function listCodexSessions(cwd: string, home = codexHome()): Promise<CodexSessionInfo[]> {
  const root = join(home, "sessions");
  if (!existsSync(root)) return [];
  const names = new Map<string, string>();
  try {
    for (const line of readFileSync(join(home, "session_index.jsonl"), "utf8").split("\n")) {
      try { const entry = JSON.parse(line); if (entry.id && entry.thread_name) names.set(entry.id, entry.thread_name); } catch {}
    }
  } catch {}
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath, entry.name))
    .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 300);
  const out: CodexSessionInfo[] = [];
  for (const { file, mtime } of files) {
    // The first line holds the session's metadata but can be long (it embeds instructions): only read its start.
    const head = await Bun.file(file).slice(0, 4096).text();
    const id = /"id":"([a-f0-9-]{36})"/.exec(head)?.[1];
    const dir = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
    if (!id || !dir || JSON.parse(`"${dir}"`) !== cwd) continue;
    out.push({ id, title: names.get(id) ?? null, firstPrompt: await firstPrompt(file), lastActive: new Date(mtime).toISOString() });
    if (out.length >= 50) break;
  }
  return out;
}
