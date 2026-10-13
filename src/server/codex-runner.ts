import type { RunHandle, RunOutput } from "./runner";
/** Runs `codex app-server` (JSON-RPC over stdio); the thread to resume goes to startCodexRun. */
export function codexArgs(options: {
  refine: boolean;
  /** Commands and edits outside the sandbox ask the user (a permission card) instead of failing. */
  ask?: boolean;
  model?: string | null;
  effort?: string | null;
  writableRoots?: string[];
  /** Extra developer instructions for this turn (Codex has no --append-system-prompt). */
  instructions?: string;
  /** The ckanban MCP server's command line: the board's tools, with the run's identity env passed through. */
  mcp?: string[];
}) {
  const args = [
    "app-server",
    "-c",
    `approval_policy="${options.ask ? "on-request" : "never"}"`,
    "-c",
    `sandbox_mode="${options.refine ? "read-only" : "workspace-write"}"`,
  ];
  // The user's own config may send asks to Codex's automatic reviewer; board asks go to the user.
  if (options.ask) args.push("-c", 'approvals_reviewer="user"');
  if (!options.refine) {
    args.push("-c", "sandbox_workspace_write.network_access=true");
    if (options.writableRoots?.length)
      args.push(
        "-c",
        `sandbox_workspace_write.writable_roots=${JSON.stringify(
          options.writableRoots
        )}`
      );
  }
  // JSON string syntax is valid TOML for a basic string.
  if (options.instructions) args.push("-c", `developer_instructions=${JSON.stringify(options.instructions)}`);
  if (options.mcp) {
    const [command, ...rest] = options.mcp;
    args.push(
      "-c", `mcp_servers.ckanban.command=${JSON.stringify(command)}`,
      "-c", `mcp_servers.ckanban.args=${JSON.stringify(rest)}`,
      "-c", `mcp_servers.ckanban.env_vars=${JSON.stringify(MCP_ENV)}`,
      // Board tools never need a card: without this Codex would ask (or, with approval_policy never, refuse) every one that changes something.
      "-c", 'mcp_servers.ckanban.default_tools_approval_mode="approve"'
    );
  }
  if (options.model) args.push("-c", `model=${JSON.stringify(options.model)}`);
  if (options.effort)
    args.push("-c", `model_reasoning_effort="${options.effort}"`);
  return args;
}
/** What tells the ckanban MCP server which run (and huddle agent) is calling. Codex doesn't pass env to MCP servers by itself. */
const MCP_ENV = ["CKANBAN_TICKET", "CKANBAN_OUTPUT_DIR", "CKANBAN_HUDDLE_AGENT", "CKANBAN_HOME", "CKANBAN_PORT"];

/** Codex reports API errors as a JSON string inside the message; show just the human part. */
export function readableError(message: string): string {
  let text = message;
  try {
    const parsed = JSON.parse(message);
    text = parsed?.error?.message ?? parsed?.message ?? message;
  } catch {}
  // An older CLI rejects models a newer one knows (e.g. the config's default model).
  if (/model is not supported|model metadata .* not found/i.test(text)) text += " Update Codex (run `codex update`) or choose another model in the chat settings.";
  // An older CLI doesn't know the app-server methods or settings board runs use.
  else if (/method not found|unknown variant/i.test(text)) text += " Update Codex (run `codex update`).";
  return text;
}


/** A single action is the command without Codex's shell wrapper (`/bin/zsh -lc '...'`); several keep the whole line. */
function shownCommand(item: any): string {
  const actions = item?.commandActions;
  return actions?.length === 1 && actions[0].command ? actions[0].command : item?.command ?? "";
}

/**
 * A Codex approval request in the shape of Claude's permission ask (see describeAsk), so it shows as the same card.
 * Null: not an approval the card can answer.
 */
export function codexAsk(method: string, params: any): any {
  const description = typeof params?.reason === "string" ? params.reason : undefined;
  // "Always" = acceptForSession: it lasts for this run only and is never saved to Codex's rules.
  const always = ["session"];
  if (method === "item/commandExecution/requestApproval")
    return { tool_name: "Bash", description, input: { command: shownCommand(params) }, permission_suggestions: always };
  if (method === "item/fileChange/requestApproval")
    return { tool_name: "Edit", description, input: { file_path: params?.grantRoot ?? "" }, permission_suggestions: always };
  return null;
}

/** The JSON-RPC answer to a Codex approval request. Deny lets Codex carry on without it. */
export function codexAnswer(requestId: string, allow: boolean, always = false) {
  return { id: requestId, result: { decision: !allow ? "decline" : always ? "acceptForSession" : "accept" } };
}

/** Codex thread items as the stream events the board shows for Claude (tool calls, results, replies). */
export function codexItemEvents(method: string, item: any): any[] {
  const toolUse = (name: string, input: unknown) => [{ type: "assistant", message: { content: [{ type: "tool_use", id: item.id, name, input }] } }];
  const toolResult = (content: string, failed: boolean) =>
    [{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: item.id, content, is_error: failed }] } }];
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
  if (item?.type === "fileChange") return toolUse("Edit", { file_path: item.changes?.map((c: any) => c.path).join(", ") ?? "files" });
  return [];
}

/**
 * One turn per process: `codex app-server` starts or resumes the thread and runs the prompt, then exits when its
 * input closes. Later messages stay in the durable board queue. Approval requests go to onPermission and wait.
 */
export function startCodexRun(options: {
  bin: string;
  cwd: string;
  args: string[];
  input: string;
  /** The Codex thread to resume (the ticket's codexSessionId). */
  threadId?: string | null;
  env?: Record<string, string>;
  onEvent: (event: any) => void;
  /** An approval request (see codexAsk) or, with cancelled, one Codex no longer waits for. False: declined at once. */
  onPermission?: (requestId: string, request: any, cancelled?: boolean) => boolean;
}): RunHandle {
  let process: ReturnType<typeof Bun.spawn> | null = null,
    stopped = false;
  const events: any[] = [];
  let finalText = "",
    failure = "";
  const started = Date.now();
  const emit = (event: any) => {
    const value = {
      ...event,
      provider: "codex",
      uuid: event.uuid ?? crypto.randomUUID(),
    };
    events.push(value);
    options.onEvent(value);
  };
  // JSON-RPC: our requests waiting for a reply, and Codex's approval requests waiting for the user (ask id -> request id).
  const replies = new Map<number, (message: any) => void>();
  const asks = new Map<string, string | number>();
  let nextId = 0;
  let turnDone = () => {};
  const turnFinished = new Promise<void>((resolve) => (turnDone = resolve));
  const write = (message: object) => {
    const stdin = process!.stdin as import("bun").FileSink;
    stdin.write(JSON.stringify(message) + "\n");
    stdin.flush();
  };
  const request = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      replies.set(id, (message) => (message.error ? reject(new Error(message.error.message ?? "Codex error")) : resolve(message.result)));
      write({ id, method, params });
    });
  const serverRequest = (message: any) => {
    const ask = codexAsk(message.method, message.params);
    const key = String(message.id);
    if (ask && options.onPermission?.(key, ask)) asks.set(key, message.id);
    else if (ask) write({ ...codexAnswer(key, false), id: message.id });
    else write({ id: message.id, error: { code: -32601, message: "The board can't answer this request" } });
  };
  const notification = (method: string, params: any) => {
    for (const event of codexItemEvents(method, params?.item)) emit(event);
    if (method === "item/completed" && params?.item?.type === "agentMessage") finalText = params.item.text ?? "";
    if (method === "serverRequest/resolved") {
      const key = String(params?.requestId);
      if (asks.delete(key)) options.onPermission?.(key, null, true);
    }
    if (method === "error" && !params?.willRetry) failure = readableError(params?.error?.message ?? "Codex turn failed");
    if (method === "turn/completed") {
      if (params?.turn?.status === "failed") failure = readableError(params.turn.error?.message ?? "Codex turn failed");
      turnDone();
    }
  };
  const done = (async (): Promise<RunOutput> => {
    try {
      process = Bun.spawn([options.bin, ...options.args], {
        cwd: options.cwd,
        env: { ...globalThis.process.env, ...options.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      emit({
        type: "user",
        isReplay: true,
        message: {
          role: "user",
          content: [{ type: "text", text: options.input }],
        },
      });
      const stdout = (async () => {
        const reader = (
            process!.stdout as ReadableStream<Uint8Array>
          ).getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        const line = (value: string) => {
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
        };
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 4 * 1024 * 1024) {
            failure = "Codex emitted an oversized event";
            process!.kill();
            break;
          }
          let index;
          while ((index = buffer.indexOf("\n")) >= 0) {
            line(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
          }
        }
        if (buffer.trim()) line(buffer);
        // Codex is gone: nothing will answer what is still waiting.
        for (const reply of replies.values()) reply({ error: { message: "Codex exited" } });
        replies.clear();
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
          emit({ type: "codex.thread", sessionId: threadId });
          await request("turn/start", { threadId, input: [{ type: "text", text: options.input, text_elements: [] }] });
          await turnFinished;
        } catch (error) {
          failure ||= readableError((error as Error).message);
        } finally {
          try {
            (process!.stdin as import("bun").FileSink).end();
          } catch {}
        }
      })();
      const [code, stderr] = await Promise.all([
        process.exited,
        (async () => {
          const reader = (
              process!.stderr as ReadableStream<Uint8Array>
            ).getReader(),
            decoder = new TextDecoder();
          let tail = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            tail = (tail + decoder.decode(value, { stream: true })).slice(
              -2048
            );
          }
          return tail;
        })(),
        stdout,
        talk,
      ]);
      const failed = code !== 0 || !!failure;
      emit({
        type: "result",
        result: finalText,
        is_error: failed,
        duration_ms: Date.now() - started,
      });
      return {
        code: failed ? code || 1 : 0,
        stderr: (failure || stderr).slice(-2048),
        events,
      };
    } catch (error) {
      const message = (error as Error).message;
      const missing = message.startsWith("Executable not found");
      return { code: -1, stderr: missing ? `Codex CLI not found (${options.bin}). Install Codex or set CKANBAN_CODEX_BIN.` : message, events };
    }
  })();
  return {
    done,
    send: () => false,
    answer(response: any) {
      const id = asks.get(response?.id);
      if (id === undefined || !process) return;
      asks.delete(response.id);
      write({ ...response, id });
    },
    endWhenIdle() {},
    keepWaiting() {},
    get stopped() {
      return stopped;
    },
    stop() {
      if (!process || stopped) return;
      stopped = true;
      const child = process;
      try {
        globalThis.process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill();
      }
      const timer = setTimeout(() => {
        try {
          globalThis.process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 5000);
      child.exited.finally(() => clearTimeout(timer));
    },
  };
}
