import { inheritedEnv, type RunHandle, type RunOutput } from "../../runner";
import type { PermissionAsk } from "./asks";

/** A Codex run also takes the user's answers to its permission asks (see codexAnswer). */
export interface CodexRunHandle extends RunHandle {
  answer(response: { id: string; result: { decision: string } }): void;
}

/**
 * Board tools Codex runs never get: jobs and schedules make the daemon run commands itself, and a huddle starts
 * Claude teammates, outside Codex's sandbox and without a permission card (board tools are approved without asking).
 */
export const NO_CODEX_TOOLS = ["schedule_job", "update_job", "run_job_now", "cancel_job", "create_schedule", "update_schedule", "delete_schedule", "run_schedule", "start_huddle"];

/** What tells the ckanban MCP server which run (and huddle agent) is calling. Codex doesn't pass env to MCP servers by itself. */
const MCP_ENV = ["CKANBAN_TICKET", "CKANBAN_OUTPUT_DIR", "CKANBAN_HUDDLE_AGENT", "CKANBAN_HOME", "CKANBAN_PORT"];

/** Runs `codex app-server` (JSON-RPC over stdio); the thread to resume goes to startCodexRun. */
export function codexArgs(options: {
  /** Read-only: Planning chats and read-only huddle teammates. */
  readOnly: boolean;
  /** Commands and edits outside the sandbox ask the user (a permission card) instead of failing. */
  ask?: boolean;
  model?: string | null;
  writableRoots?: string[];
  /** Extra developer instructions for this turn (Codex has no --append-system-prompt). */
  instructions?: string;
  /** The ckanban MCP server's command line: the board's tools, with the run's identity env passed through. */
  mcp?: string[];
  /** Board tools this run can't use (names without the mcp__ckanban__ prefix), on top of NO_CODEX_TOOLS. */
  disabledTools?: string[];
}): string[] {
  const args = [
    "app-server",
    "-c", `approval_policy="${options.ask ? "on-request" : "never"}"`,
    "-c", `sandbox_mode="${options.readOnly ? "read-only" : "workspace-write"}"`,
  ];
  // The user's own config may send asks to Codex's automatic reviewer; board asks go to the user.
  if (options.ask) args.push("-c", 'approvals_reviewer="user"');
  if (!options.readOnly) {
    args.push("-c", "sandbox_workspace_write.network_access=true");
    if (options.writableRoots?.length) args.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(options.writableRoots)}`);
  }
  // JSON string syntax is valid TOML for a basic string.
  if (options.instructions) args.push("-c", `developer_instructions=${JSON.stringify(options.instructions)}`);
  if (options.mcp) {
    const [command, ...rest] = options.mcp;
    args.push(
      "-c", `mcp_servers.ckanban.command=${JSON.stringify(command)}`,
      "-c", `mcp_servers.ckanban.args=${JSON.stringify(rest)}`,
      "-c", `mcp_servers.ckanban.env_vars=${JSON.stringify(MCP_ENV)}`,
      "-c", `mcp_servers.ckanban.disabled_tools=${JSON.stringify([...new Set([...NO_CODEX_TOOLS, ...(options.disabledTools ?? [])])])}`,
      // Board tools never need a card: without this Codex would ask (or, with approval_policy never, refuse) every one that changes something.
      "-c", 'mcp_servers.ckanban.default_tools_approval_mode="approve"',
    );
  }
  if (options.model) args.push("-c", `model=${JSON.stringify(options.model)}`);
  return args;
}

/** Codex reports API errors as a JSON string inside the message; show just the human part. */
export function readableError(message: string): string {
  let text = message;
  try {
    const parsed = JSON.parse(message);
    text = parsed?.error?.message ?? parsed?.message ?? message;
  } catch {}
  // An older CLI doesn't know the app-server methods or settings board runs use.
  if (/method not found|unknown variant|model is not supported/i.test(text)) text += " Update Codex (run `codex update`).";
  return text;
}

/** A single action is the command without Codex's shell wrapper (`/bin/zsh -lc '...'`); several keep the whole line. */
function shownCommand(item: any): string {
  const actions = item?.commandActions;
  return actions?.length === 1 && actions[0].command ? actions[0].command : item?.command ?? "";
}

/**
 * A Codex approval request as the permission card shows it. Null: not an approval the card can answer.
 * `exact` is what "Always allow" matches later: the full command, or the files (empty: never remembered).
 * editPaths: the files of the edit the request is about (from its item/started), when Codex gives no folder.
 */
export function codexAsk(id: string, method: string, params: any, editPaths = ""): PermissionAsk | null {
  const reason = typeof params?.reason === "string" ? params.reason.trim() : "";
  const at = new Date().toISOString();
  if (method === "item/commandExecution/requestApproval") {
    return { id, kind: "command", detail: shownCommand(params), exact: String(params?.command ?? shownCommand(params)), reason, at };
  }
  if (method === "item/fileChange/requestApproval") {
    const detail = String(params?.grantRoot ?? "") || editPaths;
    return { id, kind: "edit", detail, exact: detail, reason, at };
  }
  return null;
}

const changedPaths = (item: any): string => item?.changes?.map((c: any) => c.path).filter(Boolean).join(", ") ?? "";

/** The JSON-RPC answer to a Codex approval request. "Always" lasts for this chat only and is never saved to Codex's rules. */
export function codexAnswer(requestId: string, allow: boolean, always = false) {
  return { id: requestId, result: { decision: !allow ? "decline" : always ? "acceptForSession" : "accept" } };
}

/** Codex thread items as the stream events the board shows for Claude (tool calls, results, replies). */
export function codexItemEvents(method: string, item: any): any[] {
  const toolUse = (name: string, input: unknown) => [{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: item.id, name, input }] } }];
  const toolResult = (content: string, failed: boolean) =>
    [{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: item.id, content, is_error: failed }] } }];
  if (method === "item/started") {
    if (item?.type === "commandExecution") return toolUse("Bash", { command: shownCommand(item) });
    if (item?.type === "mcpToolCall") return toolUse(`mcp__${item.server}__${item.tool}`, item.arguments ?? {});
    return [];
  }
  if (method !== "item/completed") return [];
  if (item?.type === "agentMessage") return [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: item.text ?? "" }] } }];
  if (item?.type === "commandExecution")
    return toolResult(item.aggregatedOutput ?? (item.status === "declined" ? "Denied" : ""), item.status !== "completed" || item.exitCode !== 0);
  if (item?.type === "mcpToolCall")
    return toolResult(item.result?.content?.map((c: any) => c.text ?? "").join("\n") ?? item.error?.message ?? "", item.status === "failed");
  if (item?.type === "fileChange") return toolUse("Edit", { file_path: changedPaths(item) || "files" });
  return [];
}

/**
 * One turn per process: `codex app-server` starts or resumes the thread and runs the prompt, then exits when its
 * input closes. Later messages stay in the board's queue (send returns false). Approval requests go to onPermission
 * and wait for answer().
 */
export function startCodexRun(options: {
  bin: string;
  cwd: string;
  args: string[];
  input: string;
  /** The Codex thread to resume. */
  threadId?: string | null;
  env?: Record<string, string>;
  onEvent: (event: any) => void;
  /** The thread's id, as soon as Codex has opened it (so a restart can resume it). */
  onThread?: (threadId: string) => void;
  /** An approval request, or null once Codex no longer waits for the one with this id. False: declined at once. */
  onPermission?: (requestId: string, ask: PermissionAsk | null) => boolean;
}): CodexRunHandle {
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stopped = false;
  const events: any[] = [];
  let finalText = "";
  let failure = "";
  const started = Date.now();
  const emit = (event: any) => {
    const value = { ...event, provider: "codex", uuid: event.uuid ?? crypto.randomUUID() };
    events.push(value);
    options.onEvent(value);
  };
  // JSON-RPC: our requests waiting for a reply, and Codex's approval requests waiting for the user (key -> request id).
  const replies = new Map<number, (message: any) => void>();
  const asks = new Map<string, string | number>();
  let nextId = 0;
  let turnDone = () => {};
  const turnFinished = new Promise<void>((resolve) => (turnDone = resolve));
  const write = (message: object) => {
    const stdin = child!.stdin as import("bun").FileSink;
    stdin.write(JSON.stringify(message) + "\n");
    stdin.flush();
  };
  const request = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      replies.set(id, (message) => (message.error ? reject(new Error(message.error.message ?? "Codex error")) : resolve(message.result)));
      write({ id, method, params });
    });
  // The files of each edit Codex started, so its approval request can name them.
  const edits = new Map<string, string>();
  const serverRequest = (message: any) => {
    const key = String(message.id);
    const ask = codexAsk(key, message.method, message.params, edits.get(String(message.params?.itemId)) ?? "");
    if (ask && options.onPermission?.(key, ask)) asks.set(key, message.id);
    else if (ask) write({ ...codexAnswer(key, false), id: message.id });
    else write({ id: message.id, error: { code: -32601, message: "The board can't answer this request" } });
  };
  const notification = (method: string, params: any) => {
    if (method === "item/started" && params?.item?.type === "fileChange") edits.set(String(params.item.id), changedPaths(params.item));
    for (const event of codexItemEvents(method, params?.item)) emit(event);
    if (method === "item/completed" && params?.item?.type === "agentMessage") finalText = params.item.text ?? "";
    if (method === "serverRequest/resolved") {
      const key = String(params?.requestId);
      if (asks.delete(key)) options.onPermission?.(key, null);
    }
    if (method === "error" && !params?.willRetry) failure = readableError(params?.error?.message ?? "Codex turn failed");
    if (method === "turn/completed") {
      if (params?.turn?.status === "failed") failure = readableError(params.turn.error?.message ?? "Codex turn failed");
      turnDone();
    }
  };
  const readLines = async (stream: ReadableStream<Uint8Array>, line: (text: string) => void) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    }
    if (buffer.trim()) line(buffer);
  };
  const done = (async (): Promise<RunOutput> => {
    try {
      child = Bun.spawn([options.bin, ...options.args], {
        cwd: options.cwd, env: { ...inheritedEnv(), ...options.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
        // Own process group so stop() can take down the commands Codex started.
        detached: true,
      });
    } catch (error) {
      const message = (error as Error).message;
      const missing = /not found|ENOENT/i.test(message);
      return { code: -1, stderr: missing ? `Codex is not installed (${options.bin} not found). Install Codex, or set CKANBAN_CODEX_BIN.` : message, events };
    }
    // The board marks the message as read when it sees it come back, like Claude's --replay-user-messages.
    emit({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: options.input }] } });
    const stdout = (async () => {
      await readLines(child!.stdout as ReadableStream<Uint8Array>, (value) => {
        let message: any;
        try {
          message = JSON.parse(value);
        } catch {
          return;
        }
        if (!message.method) {
          replies.get(message.id)?.(message);
          replies.delete(message.id);
        } else if (message.id !== undefined) serverRequest(message);
        else notification(message.method, message.params);
      });
      // Codex is gone: nothing will answer what is still waiting.
      for (const reply of replies.values()) reply({ error: { message: "Codex exited" } });
      replies.clear();
      for (const key of asks.keys()) options.onPermission?.(key, null);
      asks.clear();
      turnDone();
    })();
    const talk = (async () => {
      try {
        await request("initialize", { clientInfo: { name: "ckanban", version: "1" }, capabilities: null });
        write({ method: "initialized" });
        const opened = options.threadId
          ? await request("thread/resume", { threadId: options.threadId, cwd: options.cwd })
          : await request("thread/start", { cwd: options.cwd });
        const threadId = opened.thread.id;
        options.onThread?.(threadId);
        await request("turn/start", { threadId, input: [{ type: "text", text: options.input, text_elements: [] }] });
        await turnFinished;
      } catch (error) {
        failure ||= readableError((error as Error).message);
      } finally {
        try {
          (child!.stdin as import("bun").FileSink).end();
        } catch {}
      }
    })();
    let stderr = "";
    const stderrDone = readLines(child.stderr as ReadableStream<Uint8Array>, (line) => (stderr = (stderr + line + "\n").slice(-2048)));
    const [code] = await Promise.all([child.exited, stderrDone, stdout, talk]);
    const failed = !stopped && (code !== 0 || !!failure);
    emit({ type: "result", subtype: failed ? "error" : "success", result: finalText, is_error: failed, duration_ms: Date.now() - started });
    return { code: failed ? code || 1 : stopped ? code : 0, stderr: (failure || stderr).slice(-2048), events };
  })();
  return {
    done,
    send: () => false,
    answer(response) {
      const id = asks.get(response.id);
      if (id === undefined || !child) return;
      asks.delete(response.id);
      write({ ...response, id });
    },
    endWhenIdle() {},
    keepWaiting() {},
    get stopped() {
      return stopped;
    },
    stop() {
      if (!child || stopped) return;
      stopped = true;
      const p = child;
      try {
        process.kill(-p.pid, "SIGTERM");
      } catch {
        p.kill();
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-p.pid, "SIGKILL");
        } catch {}
      }, 5000);
      p.exited.finally(() => clearTimeout(timer));
    },
  };
}
