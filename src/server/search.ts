import type { CodexSessions } from "./codex-session";
import type { SessionCache } from "./session";
import type { Store } from "./store";
import type { Status } from "./types";

export type SearchField = "title" | "description" | "comment" | "message";

export interface SearchHit {
  id: string;
  title: string;
  /** A chat (Chats view) rather than a board ticket. */
  standalone: boolean;
  status: Status;
  field: SearchField;
  snippet: string;
}

const MAX_HITS = 40;
const FIELD_ORDER: SearchField[] = ["title", "description", "comment", "message"];

function snippet(text: string, word: string): string {
  const at = Math.max(0, text.toLowerCase().indexOf(word));
  const start = Math.max(0, at - 40);
  const end = at + 90;
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

/**
 * Every ticket and chat of a board whose title, description, comments or conversation contain all the words of `query`
 * (case-insensitive). One hit per ticket, for the first field that matches (conversation: its newest matching message).
 */
export function searchBoard(store: Store, sessions: SessionCache, codexSessions: CodexSessions, slug: string, query: string): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const matches = (text: string) => {
    const lower = text.toLowerCase();
    return words.every((w) => lower.includes(w));
  };
  const hits: (SearchHit & { updatedAt: string })[] = [];
  for (const t of store.listTickets(slug)) {
    const hit = (field: SearchField, text: string) => hits.push({ id: t.id, title: t.title, standalone: !!t.standalone, status: t.status, field, snippet: snippet(text, words[0]), updatedAt: t.updatedAt });
    if (matches(t.title)) hit("title", t.title);
    else if (matches(t.body)) hit("description", t.body);
    else {
      const comment = store.listComments(slug, t.id).findLast((c) => matches(c.text));
      if (comment) hit("comment", comment.text);
      else {
        const parsed = t.agent === "codex" ? codexSessions.get(slug, t.id) : t.sessionId ? sessions.get(t.sessionId) : null;
        const message = parsed?.entries.findLast((e) => e.kind === "text" && matches(e.text));
        if (message) hit("message", message.text);
      }
    }
  }
  const rank = (h: SearchHit) => FIELD_ORDER.indexOf(h.field);
  return hits
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_HITS)
    .map(({ updatedAt, ...hit }) => hit);
}
