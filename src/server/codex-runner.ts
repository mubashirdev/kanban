import type { RunHandle, RunOutput } from "./runner";
export function codexArgs(options: {
  sessionId?: string | null;
  refine: boolean;
  model?: string | null;
  effort?: string | null;
  writableRoots?: string[];
  /** Extra developer instructions for this turn (Codex has no --append-system-prompt). */
  instructions?: string;
}) {
  const args = ["exec"];
  if (options.sessionId) args.push("resume", options.sessionId);
  args.push(
    "--json",
    "--skip-git-repo-check",
    "-c",
    'approval_policy="never"',
    "-c",
    `sandbox_mode="${options.refine ? "read-only" : "workspace-write"}"`
  );
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
  if (options.model) args.push("--model", options.model);
  if (options.effort)
    args.push("-c", `model_reasoning_effort="${options.effort}"`);
  args.push("-");
  return args;
}
/** Codex reports API errors as a JSON string inside the message; show just the human part. */
export function readableError(message: string): string {
  let text = message;
  try {
    const parsed = JSON.parse(message);
    text = parsed?.error?.message ?? parsed?.message ?? message;
  } catch {}
  // An older CLI rejects models a newer one knows (e.g. the config's default model).
  if (/model is not supported|model metadata .* not found/i.test(text)) text += " Update Codex (run `codex update`) or choose another model in the chat settings.";
  return text;
}

/** Codex exec accepts one prompt per process. Later messages stay in the durable board queue. */
export function startCodexRun(options: {
  bin: string;
  cwd: string;
  args: string[];
  input: string;
  env?: Record<string, string>;
  onEvent: (event: any) => void;
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
      (process.stdin as import("bun").FileSink).write(options.input);
      (process.stdin as import("bun").FileSink).end();
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
          let event: any;
          try {
            event = JSON.parse(value);
          } catch {
            return;
          }
          if (
            event.type === "thread.started" &&
            typeof event.thread_id === "string"
          )
            emit({ type: "codex.thread", sessionId: event.thread_id });
          if (
            event.type === "item.started" &&
            event.item?.type === "command_execution"
          )
            emit({
              type: "assistant",
              message: {
                content: [
                  {
                    type: "tool_use",
                    id: event.item.id,
                    name: "Bash",
                    input: { command: event.item.command },
                  },
                ],
              },
            });
          if (event.type === "item.completed") {
            const item = event.item;
            if (item?.type === "agent_message") {
              finalText = item.text ?? "";
              emit({
                type: "assistant",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: finalText }],
                },
              });
            } else if (item?.type === "command_execution")
              emit({
                type: "user",
                message: {
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: item.id,
                      content: item.aggregated_output ?? "",
                      is_error: item.exit_code !== 0,
                    },
                  ],
                },
              });
            else if (item?.type === "file_change")
              emit({
                type: "assistant",
                message: {
                  content: [
                    {
                      type: "tool_use",
                      id: item.id,
                      name: "Edit",
                      input: {
                        file_path:
                          item.changes?.map((c: any) => c.path).join(", ") ??
                          "files",
                      },
                    },
                  ],
                },
              });
          }
          if (event.type === "turn.failed" || event.type === "error")
            failure = readableError(event.error?.message ?? event.message ?? "Codex turn failed");
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
