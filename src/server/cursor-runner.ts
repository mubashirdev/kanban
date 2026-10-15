import { resolveCursorBin } from "./agents";
import type { RunHandle, RunOutput } from "./runner";

/** Cursor's `-p` mode can hang without output (forum report on 2026.01.28), so a silent run is stopped after this long. */
export const CURSOR_SILENCE_MS = 5 * 60_000;

/**
 * plan: planning a ticket (read-only). ask: a Read only chat; leaving out --force doesn't stop -p from writing files
 * (2026.10.14), ask mode does. agent: Can edit, with --force and Cursor's sandbox off.
 * A chat that had a plan or ask turn stays in that mode for good, even with --force (see needsNewCursorChat).
 */
export type CursorMode = "plan" | "ask" | "agent";

/** Changing a chat out of plan or ask mode needs a new Cursor chat. */
export const needsNewCursorChat = (chatMode: CursorMode | null | undefined, mode: CursorMode) =>
  !!chatMode && chatMode !== "agent" && chatMode !== mode;

export function cursorArgs(options: { chatId?: string | null; mode: CursorMode; model?: string | null }) {
  // --trust: headless runs refuse to start in a folder nobody trusted interactively.
  const args = ["-p", "--trust", "--output-format", "stream-json", "--approve-mcps"];
  if (options.chatId) args.push("--resume", options.chatId);
  if (options.mode === "agent") args.push("--force", "--sandbox", "disabled");
  else args.push("--mode", options.mode);
  if (options.model) args.push("--model", options.model);
  return args;
}

/** Cursor's tool kinds, as the tool names the chat already knows how to show. */
const TOOL_NAMES: Record<string, string> = {
  shellToolCall: "Bash",
  readToolCall: "Read",
  writeToolCall: "Write",
  editToolCall: "Edit",
  deleteToolCall: "Delete",
  grepToolCall: "Grep",
  globToolCall: "Glob",
  lsToolCall: "LS",
  todoToolCall: "TodoWrite",
  updateTodosToolCall: "TodoWrite",
};

/** A Cursor tool's arguments in the shape the chat's tool steps read (file_path, command, pattern). */
function toolInput(args: any): Record<string, unknown> {
  const input: Record<string, unknown> = { ...args };
  if (typeof args.path === "string") input.file_path = args.path;
  if (typeof args.fileText === "string") input.content = args.fileText;
  if (typeof args.streamContent === "string") input.content = args.streamContent;
  return input;
}

function toolUse(id: string, call: any) {
  const [kind, body] = Object.entries(call ?? {})[0] ?? [];
  if (!kind) return null;
  if (kind === "function") {
    let input: any = {};
    try { input = JSON.parse((body as any)?.arguments ?? "{}"); } catch {}
    return { type: "tool_use", id, name: (body as any)?.name ?? "tool", input };
  }
  const args = (body as any)?.args ?? {};
  if (kind === "mcpToolCall") {
    const server = args.providerIdentifier ?? args.serverName ?? "mcp";
    const tool = args.toolName ?? args.name ?? "tool";
    return { type: "tool_use", id, name: `mcp__${server}__${tool}`, input: args.args ?? args.arguments ?? {} };
  }
  // Shell calls also carry Cursor's parse of the command; the step only needs the command.
  if (kind === "shellToolCall") return { type: "tool_use", id, name: "Bash", input: { command: args.command } };
  return { type: "tool_use", id, name: TOOL_NAMES[kind] ?? kind.replace(/ToolCall$/, ""), input: toolInput(args) };
}

/** What a finished Cursor tool returned, as text for the tool step. */
function toolOutput(result: any): { content: string; isError: boolean } {
  if (result?.error) return { content: String(result.error.message ?? result.error.error ?? JSON.stringify(result.error)), isError: true };
  if (result?.rejected) return { content: String(result.rejected.reason ?? "Rejected"), isError: true };
  const ok = result?.success ?? result ?? {};
  if (typeof ok === "string") return { content: ok, isError: false };
  // MCP tools answer with content parts: [{ text: { text } }].
  if (Array.isArray(ok.content)) return { content: ok.content.map((part: any) => part?.text?.text ?? part?.text ?? "").join("\n"), isError: ok.isError === true };
  // Edits report the change as a diff.
  const text = [ok.stdout, ok.stderr].filter((s) => typeof s === "string" && s).join("\n") || ok.content || ok.diffString || ok.message || ok.output || ok.interleavedOutput;
  if (typeof text === "string") return { content: text, isError: typeof ok.exitCode === "number" && ok.exitCode !== 0 };
  return { content: JSON.stringify(ok).slice(0, 4000), isError: false };
}

/**
 * One line of `cursor-agent -p --output-format stream-json` as the board's stream events (the shape Claude Code
 * writes), so the chat, activity and result parsing treat Cursor like the other agents.
 * The chat id comes out as a "cursor.chat" event; Cursor's own result is left to the runner.
 */
export function cursorEvents(line: string): any[] {
  let event: any;
  try { event = JSON.parse(line); } catch { return []; }
  if (event?.type === "system" && event.subtype === "init" && typeof event.session_id === "string")
    return [{ type: "cursor.chat", chatId: event.session_id, model: event.model }];
  if (event?.type === "assistant") {
    const text = (event.message?.content ?? []).map((part: any) => part.type === "text" ? part.text ?? "" : "").join("");
    return text ? [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }] : [];
  }
  if (event?.type === "tool_call" && typeof event.call_id === "string") {
    if (event.subtype === "started") {
      const use = toolUse(event.call_id, event.tool_call);
      return use ? [{ type: "assistant", message: { role: "assistant", content: [use] } }] : [];
    }
    if (event.subtype === "completed") {
      const body: any = Object.values(event.tool_call ?? {})[0] ?? {};
      const { content, isError } = toolOutput(body.result);
      return [{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: event.call_id, content, is_error: isError }] } }];
    }
  }
  return [];
}

/** The conversation so far, for a new Cursor chat that replaces one stuck in another mode. */
export function cursorRecap(events: any[]): string {
  const lines = events
    .filter((e) => (e.type === "user" && e.isReplay) || (e.type === "assistant" && e.message?.content?.[0]?.type === "text"))
    .map((e) => `${e.type === "user" ? "User" : "You"}: ${String(e.message.content[0].text).slice(0, 1500)}`);
  if (!lines.length) return "";
  return `Earlier in this conversation (it continues in a new Cursor chat because the access changed):\n\n${lines.slice(-20).join("\n\n").slice(-8000)}`;
}

/** Cursor's error on stderr, with what the user can do about it. */
export function readableCursorError(stderr: string): string {
  const text = stderr.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
  if (/authentication required|not logged in|unauthori[sz]ed/i.test(text)) return "Cursor isn't logged in. Run `cursor-agent login` in a terminal, then send your message again.";
  return text.split("\n").slice(-3).join("\n");
}

/** Cursor's `-p` takes one prompt per process. Later messages stay in the board's queue, like Codex. */
export function startCursorRun(options: {
  bin: string;
  cwd: string;
  args: string[];
  input: string;
  /** The board's instructions. Cursor has no system prompt option, so they go before the message (not shown in the chat). */
  instructions?: string;
  env?: Record<string, string>;
  onEvent: (event: any) => void;
  silenceMs?: number;
}): RunHandle {
  let child: ReturnType<typeof Bun.spawn> | null = null, stopped = false, failure = "", finalText = "";
  const events: any[] = [];
  const started = Date.now();
  const silenceMs = options.silenceMs ?? CURSOR_SILENCE_MS;
  const emit = (event: any) => {
    const value = { ...event, provider: "cursor", uuid: event.uuid ?? crypto.randomUUID() };
    events.push(value);
    options.onEvent(value);
  };
  const kill = () => {
    if (!child) return;
    const proc = child;
    try { globalThis.process.kill(-proc.pid, "SIGTERM"); } catch { proc.kill(); }
    const timer = setTimeout(() => { try { globalThis.process.kill(-proc.pid, "SIGKILL"); } catch {} }, 5000);
    proc.exited.finally(() => clearTimeout(timer));
  };
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const heard = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      failure = `Cursor stopped responding (no output for ${Math.round(silenceMs / 60_000)} minutes), so the board stopped it. Send your message again to retry.`;
      kill();
    }, silenceMs);
  };
  const done = (async (): Promise<RunOutput> => {
    try {
      const prompt = options.instructions ? `${options.instructions}\n\n---\n\n${options.input}` : options.input;
      child = Bun.spawn([options.bin, ...options.args, "--", prompt], {
        cwd: options.cwd,
        env: { ...globalThis.process.env, ...options.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      emit({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: options.input }] } });
      heard();
      const stdout = (async () => {
        const reader = (child!.stdout as ReadableStream<Uint8Array>).getReader(), decoder = new TextDecoder();
        let buffer = "";
        const line = (value: string) => {
          for (const event of cursorEvents(value)) {
            if (event.type === "assistant" && event.message.content[0]?.type === "text") finalText = event.message.content[0].text;
            emit(event);
          }
        };
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          heard();
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 4 * 1024 * 1024) {
            failure = "Cursor sent an oversized event";
            kill();
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
      const stderr = (async () => {
        const reader = (child!.stderr as ReadableStream<Uint8Array>).getReader(), decoder = new TextDecoder();
        let tail = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          heard();
          tail = (tail + decoder.decode(value, { stream: true })).slice(-2048);
        }
        return tail;
      })();
      const [code, errors] = await Promise.all([child.exited, stderr, stdout]);
      if (watchdog) clearTimeout(watchdog);
      const failed = code !== 0 || !!failure;
      emit({ type: "result", result: finalText, is_error: failed, duration_ms: Date.now() - started });
      return { code: failed ? code || 1 : 0, stderr: (failure || readableCursorError(errors)).slice(-2048), events };
    } catch (error) {
      if (watchdog) clearTimeout(watchdog);
      const message = (error as Error).message;
      const missing = message.startsWith("Executable not found");
      return { code: -1, stderr: missing ? `Cursor CLI not found (${options.bin}). Install it (curl https://cursor.com/install -fsS | bash) or set CKANBAN_CURSOR_BIN.` : message, events };
    }
  })();
  return {
    done,
    send: () => false,
    endWhenIdle() {},
    keepWaiting() {},
    get stopped() { return stopped; },
    stop() {
      if (!child || stopped) return;
      stopped = true;
      kill();
    },
  };
}

export interface CursorModel { value: string; displayName: string }

/** `cursor-agent models` lines like "gpt-5 - GPT-5 (current)", without the terminal colours and the loading line. */
export function parseCursorModels(text: string): CursorModel[] {
  const out: CursorModel[] = [];
  for (const raw of text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n")) {
    const m = /^\s*([a-zA-Z0-9._:-]{1,100})\s+-\s+(.+?)\s*$/.exec(raw);
    if (m) out.push({ value: m[1], displayName: m[2].replace(/\s*\((current|default)(,\s*(current|default))?\)$/i, "") });
  }
  return out;
}

let modelCache: { at: number; models: CursorModel[] } | null = null;

/** The models this Cursor account can use. The CLI asks Cursor's servers, so the list is kept for 10 minutes. */
export async function cursorModels(bin = resolveCursorBin()): Promise<CursorModel[]> {
  if (modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache.models;
  try {
    const p = Bun.spawn([bin, "models"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), 20_000);
    const text = await new Response(p.stdout as ReadableStream).text();
    clearTimeout(timer);
    const models = parseCursorModels(text);
    if (models.length) modelCache = { at: Date.now(), models };
    return models;
  } catch {
    return [];
  }
}
