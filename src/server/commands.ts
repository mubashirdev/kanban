import { mcpConfig } from "./agents";

export interface ClaudeCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
  builtin: boolean;
}
export interface ClaudeModel { value: string; displayName: string; description: string; supportsEffort?: boolean; supportedEffortLevels?: Effort[] }
export interface ClaudeCatalog { commands: ClaudeCommand[]; models: ClaudeModel[]; outputStyles?: string[] }
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = typeof EFFORT_LEVELS[number];
/** Only offer levels advertised by this installed CLI, rather than assuming its version. */
export function effortOptions(commands: ClaudeCommand[], models: ClaudeModel[] = [], model?: string | null): Effort[] {
  const hint = commands.find((command) => command.builtin && command.name === "effort")?.argumentHint ?? "";
  const levels = EFFORT_LEVELS.filter((level) => hint.split(/[^\w]+/).includes(level));
  const choice = models.find((item) => item.value === (model ?? "default"));
  if (!choice || !models.some((item) => item.supportsEffort !== undefined)) return levels;
  if (!choice.supportsEffort) return [];
  return choice.supportedEffortLevels ? levels.filter((level) => choice.supportedEffortLevels!.includes(level)) : levels;
}
export function outputStyleMetadata(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && /^[^\x00-\x1f\x7f/\\]{1,100}$/.test(item) && item.trim() === item && ![".", ".."].includes(item)))].slice(0, 100) : [];
}
export function modelMetadata(value: unknown): ClaudeModel[] {
  if (!Array.isArray(value)) return [];
  const names = new Set<string>();
  return value.flatMap((model) => {
    if (!model || typeof model.value !== "string" || !/^[\w][\w.:/@\[\]-]{0,255}$/.test(model.value) || names.has(model.value)) return [];
    names.add(model.value);
    return [{ value: model.value, displayName: String(model.displayName ?? model.value).slice(0, 200), description: String(model.description ?? "").slice(0, 1000),
      ...(typeof model.supportsEffort === "boolean" ? { supportsEffort: model.supportsEffort } : {}),
      ...(Array.isArray(model.supportedEffortLevels) ? { supportedEffortLevels: EFFORT_LEVELS.filter((level) => model.supportedEffortLevels.includes(level)) } : {}) }];
  });
}
const validName = (name: unknown): name is string => typeof name === "string" && /^[\w][\w:./@-]{0,199}$/.test(name) && !name.startsWith("__");
export function commandMetadata(value: unknown): ClaudeCommand[] {
  if (!Array.isArray(value)) throw new Error("Claude did not return its command list");
  const names = new Set<string>();
  return value.flatMap((entry) => {
    if (!entry || !validName(entry.name) || names.has(entry.name)) return [];
    names.add(entry.name);
    return [{ name: entry.name, description: String(entry.description ?? "").slice(0, 1000), argumentHint: String(entry.argumentHint ?? "").slice(0, 200),
      aliases: Array.isArray(entry.aliases) ? entry.aliases.filter(validName) : [], builtin: entry.builtin === true }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Ask Claude for its actual command registry without sending a prompt or using a model turn. */
export async function discoverCatalog(bin: string, cwd: string, plan: boolean, timeoutMs = 20_000): Promise<ClaudeCatalog> {
  const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CKANBAN_TICKET, ...env } = process.env;
  const proc = Bun.spawn([bin, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--permission-mode", plan ? "plan" : "bypassPermissions", "--mcp-config", mcpConfig()],
    { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "ignore", detached: true });
  const requestId = crypto.randomUUID();
  proc.stdin.write(JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } }) + "\n");
  proc.stdin.flush();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = (async () => {
      const decoder = new TextDecoder();
      let buffer = "", total = 0;
      for await (const chunk of proc.stdout) {
        total += chunk.length;
        if (total > 4 * 1024 * 1024) throw new Error("Claude's command response was too large");
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let event: any;
          try { event = JSON.parse(line); } catch { continue; }
          if (event?.type !== "control_response" || event.response?.request_id !== requestId) continue;
          if (event.response.subtype !== "success") throw new Error("Claude could not load commands. Check its connections and try again.");
          return { commands: commandMetadata(event.response.response?.commands), models: modelMetadata(event.response.response?.models), outputStyles: outputStyleMetadata(event.response.response?.available_output_styles) };
        }
      }
      throw new Error("Claude exited before loading commands. Check that Claude is installed and signed in.");
    })();
    return await Promise.race([read, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Loading Claude commands timed out. Try again.")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timeout);
    // Discovery may start MCP children: terminate the entire isolated process group.
    const kill = (signal: "TERM" | "KILL") => {
      const result = Bun.spawnSync(["kill", `-${signal}`, "--", `-${proc.pid}`], { stdout: "ignore", stderr: "ignore" });
      if (result.exitCode !== 0 && proc.exitCode === null) proc.kill(signal === "TERM" ? "SIGTERM" : "SIGKILL");
    };
    kill("TERM");
    await Promise.race([proc.exited, Bun.sleep(500)]);
    kill("KILL");
  }
}
export async function discoverCommands(bin: string, cwd: string, plan: boolean, timeoutMs = 20_000): Promise<ClaudeCommand[]> {
  return (await discoverCatalog(bin, cwd, plan, timeoutMs)).commands;
}

/** Bounded, short-lived cache: many drawers can share one discovery process. */
export class ClaudeCommands {
  private cache = new Map<string, { until: number; pending: Promise<ClaudeCatalog>; loading: boolean; refreshing?: Promise<ClaudeCatalog> }>();
  constructor(private bin = "claude", private discover = discoverCatalog) {}
  async get(cwd: string, plan: boolean, refresh = false): Promise<ClaudeCommand[]> {
    return (await this.catalog(cwd, plan, refresh)).commands;
  }
  catalog(cwd: string, plan: boolean, refresh = false): Promise<ClaudeCatalog> {
    const key = `${plan}:${cwd}`;
    const previous = this.cache.get(key);
    if (previous?.loading) return previous.pending;
    // A background refresh is running: Reload waits for it, everyone else gets the old list.
    if (previous?.refreshing) return refresh ? previous.refreshing : previous.pending;
    if (previous && !refresh && previous.until > Date.now()) return previous.pending;
    // Discovery takes many seconds: an expired list is still served while a fresh one loads.
    if (previous && !refresh) {
      const next = this.load(key, cwd, plan, false);
      previous.refreshing = next;
      next.catch(() => {}).finally(() => { previous.refreshing = undefined; });
      return previous.pending;
    }
    return this.load(key, cwd, plan, true);
  }

  /** wait: callers wait for this load (first load or Reload); otherwise the old list stays until it is done. */
  private load(key: string, cwd: string, plan: boolean, wait: boolean): Promise<ClaudeCatalog> {
    if (!this.cache.has(key) && this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
    const entry = { until: Date.now() + 120_000, pending: Promise.resolve({ commands: [], models: [] } as ClaudeCatalog), loading: true };
    entry.pending = this.discover(this.bin, cwd, plan).then((catalog) => {
      entry.loading = false;
      entry.until = Date.now() + 120_000;
      this.cache.set(key, entry);
      return catalog;
    }, (error) => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
      throw error;
    });
    if (wait) this.cache.set(key, entry);
    return entry.pending;
  }
}

export const isSlashCommand = (text: string) => /^\/[\w][\w:./@-]*(?:\s|$)/.test(text.trimStart());
