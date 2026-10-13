import type { HuddleMessage, Ticket } from "./types";
import type { SessionEntry } from "./session";
import { MAIN_HANDLE, USER_HANDLE } from "./huddle-roster";

/** What the Inbox's Status section asks a run with Nudge (sent like any chat message). */
export const NUDGE_TEXT = "Give me a 2-line status: what's done, what's left, any blocker";

/** What Nudge sends: a running Claude gets queued messages with "carry on", so it asks for the answer first. */
export const NUDGE_PROMPT = `Answer this right away, before your next step. ${NUDGE_TEXT}`;

/** How many recent steps a Status row shows when expanded. */
export const STEP_COUNT = 5;

/** One running ticket, chat or huddle in the Inbox's Status section. */
export interface StatusRow {
  kind: "ticket" | "chat" | "huddle";
  profile: string;
  profileName: string;
  /** The ticket (for a huddle: its host ticket). */
  id: string;
  huddleId?: string;
  title: string;
  /** "Claude", "Codex" or "Huddle · 2 working". */
  agent: string;
  startedAt: string | null;
  costUsd: number;
  /** The last step in plain words ("Editing Chat.tsx", "Waiting for your approval"). */
  step: string;
  /** Newest last. */
  steps: string[];
  /** No output for this many minutes (the board's stall watchdog). */
  stalledMinutes: number | null;
  /** The last Nudge: when it reached the run and the run's answer, once there is one. */
  nudge: { at: string; answer: string | null } | null;
}

/** The step a running ticket is on: a waiting permission ask wins over its last tool call. */
export function stepLabel(t: Pick<Ticket, "permissionAsk" | "lastActivity">): string {
  if (t.permissionAsk) return "Waiting for your approval";
  return t.lastActivity || "Starting…";
}

/** Adds a step to a run's recent steps (oldest dropped, repeats skipped). */
export function pushStep(steps: string[], step: string): void {
  if (steps.at(-1) === step) return;
  steps.push(step);
  if (steps.length > STEP_COUNT) steps.shift();
}

/** The last Nudge in a chat and the first thing the agent wrote after it. */
export function nudgeAnswer(entries: Pick<SessionEntry, "role" | "kind" | "text" | "at" | "note">[]): StatusRow["nudge"] {
  const i = entries.findLastIndex((e) => e.role === "user" && e.text.includes(NUDGE_TEXT));
  if (i < 0) return null;
  const reply = entries.slice(i + 1).find((e) => e.role === "assistant" && e.kind === "text" && !e.note && e.text.trim());
  return { at: entries[i].at, answer: reply?.text.trim() ?? null };
}

/** The same for a huddle: the user's last Nudge post (to @main) and main's first message after it. */
export function huddleNudgeAnswer(msgs: Pick<HuddleMessage, "from" | "text" | "ts" | "kind">[]): StatusRow["nudge"] {
  const i = msgs.findLastIndex((m) => m.from === USER_HANDLE && m.text.includes(NUDGE_TEXT));
  if (i < 0) return null;
  const reply = msgs.slice(i + 1).find((m) => m.from === MAIN_HANDLE && m.kind !== "system");
  return { at: msgs[i].ts, answer: reply?.text.trim() ?? null };
}
