import { codexAnswer, type CodexRunHandle } from "./runner";
import { patchTicket } from "./state";

/** Codex paused to ask before a command or an edit outside its sandbox; the card shows it on the ticket. */
export interface PermissionAsk {
  /** Codex's request id. */
  id: string;
  kind: "command" | "edit";
  /** The command, or the folder it wants to write in. */
  detail: string;
  /** What "Always allow" matches later: the full command, or the files. Empty: never remembered. */
  exact: string;
  /** Codex's own words for why, when it gave them. */
  reason: string;
  at: string;
}

/** The ticket's runs waiting on the user, by "slug/id": the run to answer and its open asks, oldest first. */
const waiting = new Map<string, { handle: CodexRunHandle | null; asks: Map<string, PermissionAsk> }>();

/**
 * "Always allow in this chat", by "slug/id": Codex runs one process per reply, so the board remembers the answer
 * and gives it again when the same ask comes back in a later reply (until the daemon restarts).
 */
const always = new Map<string, Set<string>>();
const sameAsk = (ask: PermissionAsk) => `${ask.kind}:${ask.exact}`;

/** A new conversation (the ticket switched agent): "in this chat" no longer applies. */
export function forgetAlways(slug: string, id: string) {
  always.delete(`${slug}/${id}`);
}

/** Shown on the ticket as `codexAsk`: the oldest ask still open, or null. */
function show(slug: string, id: string) {
  const entry = waiting.get(`${slug}/${id}`);
  patchTicket(slug, id, { codexAsk: entry?.asks.values().next().value ?? null });
}

/** The onPermission of a ticket's Codex run: each ask shows as the card until it is answered or Codex drops it. */
export function askHandler(slug: string, id: string) {
  const key = `${slug}/${id}`;
  const entry = { handle: null as CodexRunHandle | null, asks: new Map<string, PermissionAsk>() };
  waiting.set(key, entry);
  return {
    attach: (handle: CodexRunHandle) => (entry.handle = handle),
    onPermission: (requestId: string, ask: PermissionAsk | null) => {
      if (ask?.exact && always.get(key)?.has(sameAsk(ask))) {
        // The runner starts waiting for an answer once this returns.
        queueMicrotask(() => entry.handle?.answer(codexAnswer(requestId, true, true)));
        return true;
      }
      if (ask) entry.asks.set(requestId, ask);
      else entry.asks.delete(requestId);
      show(slug, id);
      return true;
    },
    /** The run ended: nothing is waiting any more. */
    end: () => {
      if (waiting.get(key) !== entry) return;
      waiting.delete(key);
      if (entry.asks.size) show(slug, id);
    },
  };
}

export class AskGoneError extends Error {}

/** The user's answer from the card; the next ask waiting (if any) shows next. */
export function answerAsk(slug: string, id: string, askId: string, allow: boolean, remember: boolean) {
  const key = `${slug}/${id}`;
  const entry = waiting.get(key);
  const ask = entry?.asks.get(askId);
  if (!entry?.handle || !ask) throw new AskGoneError("Codex is no longer waiting for this answer");
  if (allow && remember && ask.exact) always.set(key, (always.get(key) ?? new Set()).add(sameAsk(ask)));
  entry.handle.answer(codexAnswer(askId, allow, remember));
  entry.asks.delete(askId);
  show(slug, id);
}
