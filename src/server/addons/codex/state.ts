import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "../../agents";
import type { Bus } from "../../events";
import { atomicWrite, type Store } from "../../store";
import type { Ticket } from "../../types";

/** The Codex add-on's fields on a ticket. Leo's Ticket type doesn't know them; the ticket file keeps them as they are. */
export interface CodexFields {
  /** Who works on the ticket. Missing: Claude. */
  agent?: AgentId;
  /** The Codex thread its runs continue (the same field our old version saved). */
  codexSessionId?: string | null;
}

export const agentOf = (t: Ticket | null | undefined): AgentId => ((t as (Ticket & CodexFields) | null | undefined)?.agent === "codex" ? "codex" : "claude");
export const threadOf = (t: Ticket | null | undefined): string | null => (t as (Ticket & CodexFields) | null | undefined)?.codexSessionId ?? null;

let ctx: { store: Store; bus: Bus } | null = null;

/** Called once when the daemon starts (main.ts), and by tests. */
export function attachCodex(store: Store, bus: Bus) {
  ctx = { store, bus };
}

export function codexStore(): Store {
  if (!ctx) throw new Error("the Codex add-on isn't attached (attachCodex)");
  return ctx.store;
}

/** Saves fields on a ticket and tells the UI, like Board.patch. */
export function patchTicket(slug: string, id: string, patch: Record<string, unknown>): Ticket | null {
  if (!ctx || !ctx.store.getTicket(slug, id)) return null;
  const t = ctx.store.updateTicket(slug, id, patch as Partial<Ticket>);
  ctx.bus.emit({ type: "ticket.updated", profile: slug, ticket: t });
  return t;
}

/** "slug/id" from a run's CKANBAN_TICKET. */
export function ticketRef(value: string | undefined): { slug: string; id: string } | null {
  const [slug, id] = value?.split("/") ?? [];
  return slug && id ? { slug, id } : null;
}

/**
 * Huddle teammates have no ticket to keep their Codex thread on: it is kept here, by the teammate's board session id.
 */
const threadsFile = () => join(codexStore().root, "addons", "codex-threads.json");

function readThreads(): Record<string, string> {
  try {
    return existsSync(threadsFile()) ? JSON.parse(readFileSync(threadsFile(), "utf8")) : {};
  } catch {
    return {};
  }
}

export function teammateThread(sessionId: string): string | null {
  return readThreads()[sessionId] ?? null;
}

export function saveTeammateThread(sessionId: string, threadId: string) {
  atomicWrite(threadsFile(), JSON.stringify({ ...readThreads(), [sessionId]: threadId }, null, 2));
}
