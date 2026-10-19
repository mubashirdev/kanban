import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSession, SessionCache, type ParsedSession, type SessionSummary } from "../../session";
import type { Store } from "../../store";
import type { Ticket } from "../../types";
import { agentOf, threadOf } from "./state";

const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

/** Codex's own transcript of a thread: rollout-<time>-<id>.jsonl somewhere under sessions/. */
export function codexRolloutFile(threadId: string, home = codexHome()): string | null {
  const root = join(home, "sessions");
  if (!existsSync(root)) return null;
  const entry = readdirSync(root, { recursive: true, withFileTypes: true }).find((e) => e.isFile() && e.name.endsWith(`${threadId}.jsonl`));
  return entry ? join(entry.parentPath, entry.name) : null;
}

/** The command a Codex tool call ran, for the one-line tool summary. */
function toolCommand(payload: any): string {
  if (typeof payload.arguments === "string") {
    try {
      const args = JSON.parse(payload.arguments);
      if (args.cmd || args.command) return [args.cmd ?? args.command].flat().join(" ");
    } catch {}
  }
  const input = String(payload.input ?? payload.arguments ?? payload.name ?? "");
  const quoted = /cmd:\s*"((?:[^"\\]|\\.)*)"/.exec(input)?.[1];
  if (!quoted) return input.slice(0, 160);
  try {
    return JSON.parse(`"${quoted}"`);
  } catch {
    return quoted;
  }
}

/**
 * A Codex rollout as the stream events the Codex runner emits, so Leo's parseSession reads both alike.
 * The user's own words come from user_message events: plain user items also carry injected context.
 */
export function rolloutEvents(text: string, firstLine = 0): any[] {
  const out: any[] = [];
  text.split("\n").forEach((line, n) => {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const p = e.payload ?? {};
    const base = { provider: "codex", uuid: `rollout-${firstLine + n}`, timestamp: e.timestamp };
    const message = (role: "user" | "assistant", text: string) =>
      out.push({ ...base, type: role, ...(role === "user" ? { isReplay: true } : {}), message: { role, content: [{ type: "text", text }] } });
    if (e.type === "event_msg" && p.type === "user_message" && typeof p.message === "string") message("user", p.message);
    else if (e.type === "event_msg" && p.type === "agent_message" && typeof p.message === "string") message("assistant", p.message);
    else if (e.type === "event_msg" && p.type === "item_completed" && (p.item?.type === "UserMessage" || p.item?.type === "AgentMessage")) {
      // Codex 0.160+ no longer writes user_message/agent_message events; its messages arrive as completed items.
      const text = (p.item.content ?? []).map((part: any) => part.text ?? "").join("");
      if (text) message(p.item.type === "UserMessage" ? "user" : "assistant", text);
    } else if (e.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
      out.push({ ...base, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: p.call_id, name: "Bash", input: { command: toolCommand(p) } }] } });
    } else if (e.type === "response_item" && (p.type === "function_call_output" || p.type === "custom_tool_call_output")) {
      const output = Array.isArray(p.output) ? p.output.map((o: any) => o.text ?? "").join("") : String(p.output ?? "");
      out.push({ ...base, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: p.call_id, content: output }] } });
    }
  });
  return out;
}

const size = (file: string) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

/**
 * Leo's session reader, plus Codex tickets: a Codex ticket's conversation is read from Codex's own rollout of its
 * thread (it also holds turns typed in a terminal), or without one from the Codex events in the board's run log.
 * Everything that reads a ticket's conversation by its sessionId (chat, card, inbox, alerts) then works for Codex too.
 */
export class CodexSessionCache extends SessionCache {
  private tickets = { at: 0, bySession: new Map<string, { slug: string; id: string }>() };
  /** Rollouts grow during a run and can be many MB: each read only takes the bytes added since the last one. */
  private rollouts = new Map<string, { file: string; offset: number; lines: number; events: any[] }>();
  private parsed = new Map<string, { version: string; value: ParsedSession | null }>();
  private missed = new Map<string, number>();

  constructor(private store: Store, private home = codexHome()) {
    super();
  }

  /** The Codex ticket a board session id belongs to, from a list refreshed at most every 2s. */
  private codexTicket(sessionId: string): Ticket | null {
    if (Date.now() - this.tickets.at > 2000) {
      const bySession = new Map<string, { slug: string; id: string }>();
      for (const p of this.store.listProfiles()) {
        for (const t of this.store.listTickets(p.slug)) if (t.sessionId && agentOf(t) === "codex") bySession.set(t.sessionId, { slug: p.slug, id: t.id });
      }
      this.tickets = { at: Date.now(), bySession };
    }
    const ref = this.tickets.bySession.get(sessionId);
    const t = ref ? this.store.getTicket(ref.slug, ref.id) : null;
    return t && agentOf(t) === "codex" && t.sessionId === sessionId ? t : null;
  }

  /** Finding a rollout walks Codex's whole sessions folder, so a miss is only retried every 30s. */
  private rolloutFile(threadId: string): string | null {
    const known = this.rollouts.get(threadId)?.file;
    if (known && existsSync(known)) return known;
    if (Date.now() - (this.missed.get(threadId) ?? 0) < 30_000) return null;
    const file = codexRolloutFile(threadId, this.home);
    if (!file) this.missed.set(threadId, Date.now());
    return file;
  }

  private rolloutEvents(threadId: string, file: string): any[] {
    const end = size(file);
    let r = this.rollouts.get(threadId);
    if (!r || r.file !== file || end < r.offset) r = { file, offset: 0, lines: 0, events: [] };
    if (end > r.offset) {
      const bytes = Buffer.alloc(end - r.offset);
      const fd = openSync(file, "r");
      try {
        readSync(fd, bytes, 0, bytes.length, r.offset);
      } finally {
        closeSync(fd);
      }
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

  /** Where the Codex ticket's conversation is read from, and a marker that changes when it grows. */
  private source(t: Ticket): { version: string; events: () => any[] } | null {
    const threadId = threadOf(t);
    const file = threadId ? this.rolloutFile(threadId) : null;
    if (threadId && file) return { version: `rollout:${file}:${size(file)}`, events: () => this.rolloutEvents(threadId, file) };
    const log = this.store.activityPath(this.slugOf(t), t.id);
    if (!existsSync(log)) return null;
    return {
      version: `activity:${size(log)}`,
      events: () => this.store.readActivity(this.slugOf(t), t.id)
        .filter((e) => e.event?.provider === "codex")
        .map((e) => ({ ...e.event, timestamp: e.at })),
    };
  }

  private slugOf(t: Ticket): string {
    return this.tickets.bySession.get(t.sessionId!)!.slug;
  }

  private codexGet(t: Ticket): ParsedSession | null {
    const src = this.source(t);
    if (!src) return null;
    const cached = this.parsed.get(t.sessionId!);
    if (cached?.version === src.version) return cached.value;
    const events = src.events();
    const value = events.length ? parseSession(events.map((e) => JSON.stringify(e)).join("\n")) : null;
    this.parsed.set(t.sessionId!, { version: src.version, value });
    return value;
  }

  override version(sessionId: string): string | null {
    const t = this.codexTicket(sessionId);
    return t ? this.source(t)?.version ?? null : super.version(sessionId);
  }

  override get(sessionId: string): ParsedSession | null {
    const t = this.codexTicket(sessionId);
    return t ? this.codexGet(t) : super.get(sessionId);
  }

  override summary(sessionId: string): SessionSummary | null {
    const t = this.codexTicket(sessionId);
    if (!t) return super.summary(sessionId);
    const p = this.codexGet(t);
    if (!p) return null;
    return {
      title: p.title, lastMessage: p.lastMessage, artifacts: p.artifacts, updatedAt: t.updatedAt,
      openQuestions: p.openQuestions, pendingProposal: p.pendingProposal, pendingNewTickets: p.pendingNewTickets, pendingTeammates: p.pendingTeammates,
    };
  }

  /** Board runs ask whether a session can be resumed: a Codex ticket can once its thread exists. */
  exists(sessionId: string, claudeExists: (id: string) => boolean): boolean {
    const t = this.codexTicket(sessionId);
    return t ? !!threadOf(t) : claudeExists(sessionId);
  }
}
