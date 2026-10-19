import { helperArgv } from "../../artifact";
import { HUDDLE_AGENT_ENV } from "../../huddle-roster";
import type { RunHandle, startRun } from "../../runner";
import { askHandler } from "./asks";
import { codexArgs, startCodexRun } from "./runner";
import { codexStore, patchTicket, saveTeammateThread, teammateThread, threadOf, ticketRef } from "./state";

/** The value after a flag in Claude's command line (see buildArgs), e.g. --append-system-prompt. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * A board or huddle run on Codex, from the options the board gives Claude's runs:
 * - Planning chats and read-only teammates (edit tools turned off) get a read-only sandbox.
 * - A ticket's own work and chats ask the user before going outside the sandbox (the permission card);
 *   Planning chats, read-only runs and huddle teammates never ask.
 * - Only the outputs folder is writable besides the work folder. Never any part of .git: a file planted there (a hook,
 *   config, a worktree's commondir) would run outside the sandbox on the next git command, so commits ask first.
 * - A ticket continues its Codex thread (codexSessionId on the ticket); a teammate the one kept for its session.
 */
export function startCodexFor(opts: Parameters<typeof startRun>[0]): RunHandle {
  const env = opts.env ?? {};
  const teammate = !!env[HUDDLE_AGENT_ENV];
  const ticket = teammate ? null : ticketRef(env.CKANBAN_TICKET);
  const session = flag(opts.args, "--session-id") ?? flag(opts.args, "--resume") ?? "";
  const readOnly = !!opts.planning || (flag(opts.args, "--disallowedTools") ?? "").split(",").includes("Edit");
  const ask = !!ticket && !readOnly;
  const writableRoots = readOnly || !env.CKANBAN_OUTPUT_DIR ? [] : [env.CKANBAN_OUTPUT_DIR];
  // Tools the board turned off for this run (a Planning chat's list), for Codex too.
  const disabledTools = (flag(opts.args, "--disallowedTools") ?? "").split(",").filter((t) => t.startsWith("mcp__ckanban__")).map((t) => t.slice("mcp__ckanban__".length));
  const threadId = ticket ? threadOf(codexStore().getTicket(ticket.slug, ticket.id)) : session ? teammateThread(session) : null;
  const asks = ask ? askHandler(ticket!.slug, ticket!.id) : null;
  const handle = startCodexRun({
    bin: process.env.CKANBAN_CODEX_BIN ?? "codex",
    cwd: opts.cwd,
    args: codexArgs({ readOnly, ask, writableRoots, instructions: flag(opts.args, "--append-system-prompt"), mcp: [...helperArgv(), "mcp"], disabledTools }),
    input: opts.input ?? "",
    threadId,
    env,
    onEvent: opts.onEvent,
    onThread: (id) => {
      if (id === threadId) return;
      if (ticket) patchTicket(ticket.slug, ticket.id, { codexSessionId: id });
      else if (session) saveTeammateThread(session, id);
    },
    onPermission: asks?.onPermission,
  });
  asks?.attach(handle);
  handle.done.finally(() => asks?.end());
  return handle;
}
