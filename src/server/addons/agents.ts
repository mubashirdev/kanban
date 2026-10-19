import type { AgentId } from "../agents";
import { startRun, type RunHandle } from "../runner";
import { startCodexFor } from "./codex/start";
import { attachedStore } from "./codex/state";
import { withChatPrompt } from "./chats";
import { withEffort } from "./models";

type RunOptions = Parameters<typeof startRun>[0];

/**
 * The one switch where a run starts (Leo's board and huddle runs call this instead of startRun): Claude runs as
 * before, another agent gets the same options and reads what it needs from them. A new agent (Cursor) adds a line here.
 */
export function startAgentRun(agent: AgentId | null | undefined, opts: RunOptions): RunHandle {
  opts = { ...opts, args: withChatPrompt(opts.args, opts.env) };
  if (agent === "codex") return startCodexFor(opts);
  return startRun({ ...opts, args: withEffort(opts.args, opts.env, attachedStore()) });
}

/** A huddle teammate runs on Codex when its model is "codex" (the roster's Claude | Codex switch sets it). */
export const teammateAgent = (p: { model: string | null }): AgentId => (p.model === "codex" ? "codex" : "claude");
