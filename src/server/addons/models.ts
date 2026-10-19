import { homedir } from "node:os";
import { validModel } from "../commands";
import type { Bus } from "../events";
import { HUDDLE_AGENT_ENV, HUDDLE_HEADER } from "../huddle-roster";
import { RUN_HEADER } from "../scheduler";
import type { Store } from "../store";
import type { Profile, Ticket } from "../types";
import { codexModels } from "./codex/catalog";

export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const CODEX_EFFORTS = [...CLAUDE_EFFORTS, "ultra"];

/** Our fields on a ticket next to Leo's `model` (Claude's model). The same names our old version saved. */
export interface TicketModelFields {
  effort?: string | null;
  codexModel?: string | null;
  codexEffort?: string | null;
}

/** Board defaults next to Leo's `model` on the board (Claude's model), saved in its profile.json. */
export interface BoardModelFields {
  claudeEffort?: string | null;
  codexModel?: string | null;
  codexEffort?: string | null;
}

export interface ClaudeModel {
  value: string;
  displayName: string;
  description: string;
  /** null: Claude didn't say, so every level is offered. [] : the model has no effort setting. */
  efforts: string[] | null;
}

let claudeCache: { until: number; models: Promise<ClaudeModel[]> } | null = null;
let lastClaudeModels: ClaudeModel[] = [];

/** Claude's models and the efforts each supports, as Claude Code reports them. Kept 10 minutes: asking takes seconds. */
export function claudeModels(bin = process.env.CKANBAN_CLAUDE_BIN ?? "claude"): Promise<ClaudeModel[]> {
  if (claudeCache && claudeCache.until > Date.now()) return claudeCache.models;
  const models = askClaudeModels(bin).then((list) => (lastClaudeModels = list));
  claudeCache = { until: Date.now() + 10 * 60_000, models };
  models.catch(() => (claudeCache = null));
  return models;
}

/** Asks `claude -p` for its startup info (no prompt, no model turn) and keeps its model list. */
async function askClaudeModels(bin: string): Promise<ClaudeModel[]> {
  const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CKANBAN_TICKET, ...env } = process.env;
  const proc = Bun.spawn([bin, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    { cwd: homedir(), env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  proc.stdin.write(JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } }) + "\n");
  proc.stdin.flush();
  const timer = setTimeout(() => proc.kill(), 30_000);
  try {
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += new TextDecoder().decode(chunk);
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.includes('"control_response"')) continue;
        const models = JSON.parse(line).response?.response?.models;
        return Array.isArray(models) ? models.filter((m) => typeof m?.value === "string" && m.value !== "default").map(toClaudeModel) : [];
      }
    }
    throw new Error("Claude didn't list its models. Check that Claude is installed and signed in.");
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}

const toClaudeModel = (m: any): ClaudeModel => ({
  value: m.value,
  displayName: String(m.displayName ?? m.value),
  description: String(m.description ?? ""),
  efforts: m.supportsEffort === false ? [] : Array.isArray(m.supportedEffortLevels) ? CLAUDE_EFFORTS.filter((e) => m.supportedEffortLevels.includes(e)) : null,
});

/** The effort to use, or null when the model is known not to support it (the run then uses the model's own). */
function supported(effort: string | null | undefined, efforts: string[] | null | undefined): string | null {
  if (!effort) return null;
  return !efforts || efforts.includes(effort) ? effort : null;
}

/** What a Claude run of this ticket uses: its own effort, else the board's. Leo's code already picks the model. */
export function claudeEffort(t: Ticket, profile: Profile): string | null {
  const model = t.model ?? profile.model;
  const effort = (t as Ticket & TicketModelFields).effort ?? (profile as Profile & BoardModelFields).claudeEffort;
  return supported(effort, model ? lastClaudeModels.find((m) => m.value === model)?.efforts : null);
}

/** What a Codex run of this ticket uses: its own model and effort, else the board's. */
export function codexChoice(t: Ticket, profile: Profile): { model: string | null; effort: string | null } {
  const own = t as Ticket & TicketModelFields;
  const board = profile as Profile & BoardModelFields;
  const model = own.codexModel ?? board.codexModel ?? null;
  const effort = own.codexEffort ?? board.codexEffort;
  return { model, effort: supported(effort, model ? codexModels().find((m) => m.value === model)?.efforts : null) };
}

/** Adds `--effort` to a Claude board run's arguments. Huddle teammates keep theirs (they have no ticket of their own). */
export function withEffort(args: string[], env: Record<string, string> | undefined, store: Store | null): string[] {
  const [slug, id] = env?.CKANBAN_TICKET?.split("/") ?? [];
  if (!store || !slug || !id || env?.[HUDDLE_AGENT_ENV]) return args;
  const t = store.getTicket(slug, id);
  const profile = store.getProfile(slug);
  const effort = t && profile ? claudeEffort(t, profile) : null;
  return effort ? [...args, "--effort", effort] : args;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const error = (status: number, message: string) => json({ error: message }, status);

const validCodexModel = (v: string) => /^[a-zA-Z0-9._:-]{1,100}$/.test(v);

/** Reads one optional field from a request body: a valid string, null (back to the default), or undefined (unchanged). */
function field(b: any, key: string, valid: (v: string) => boolean): string | null | undefined {
  if (b[key] === undefined) return undefined;
  if (b[key] === null || b[key] === "") return null;
  if (typeof b[key] !== "string" || !valid(b[key])) throw new Error(`Invalid ${key}`);
  return b[key];
}

function picks(b: any, keys: Record<string, (v: string) => boolean>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, valid] of Object.entries(keys)) {
    const value = field(b, key, valid);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const boardDefaults = (p: Profile) => {
  const b = p as Profile & BoardModelFields;
  return { claudeModel: p.model ?? null, claudeEffort: b.claudeEffort ?? null, codexModel: b.codexModel ?? null, codexEffort: b.codexEffort ?? null };
};

/**
 * The model add-on's routes, only for the user (board runs and huddle teammates can't change them):
 * GET /api/addons/models/claude, POST /api/addons/models/tickets/:id, GET|PATCH /api/addons/models/boards/:slug.
 */
export async function modelRoutes(req: Request, parts: string[], deps: { store: Store; bus: Bus }): Promise<Response | null> {
  if (parts[0] !== "addons" || parts[1] !== "models") return null;
  if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) return error(403, "only the user can do this");
  const [, , what, id] = parts;
  if (req.method === "GET" && what === "claude" && parts.length === 3) {
    try {
      return json(await claudeModels());
    } catch (e) {
      return error(502, (e as Error).message);
    }
  }
  if (req.method !== "GET" && !req.headers.get("origin")) return error(403, "only the user can do this");
  if (parts.length !== 4) return error(404, "not found");
  const b: any = req.method === "GET" ? {} : await req.json().catch(() => ({}));
  try {
    if (what === "tickets" && req.method === "POST" && /^t_\w+$/.test(id)) {
      // Ticket ids are unique across boards.
      const slug = deps.store.listProfiles().find((p) => deps.store.getTicket(p.slug, id))?.slug;
      if (!slug) return error(404, `ticket ${id} not found`);
      const patch = picks(b, { model: validModel, effort: (v) => CLAUDE_EFFORTS.includes(v), codexModel: validCodexModel, codexEffort: (v) => CODEX_EFFORTS.includes(v) });
      const t = deps.store.updateTicket(slug, id, patch as Partial<Ticket>);
      deps.bus.emit({ type: "ticket.updated", profile: slug, ticket: t });
      return json(t);
    }
    const profile = what === "boards" ? deps.store.getProfile(id) : null;
    if (!profile) return error(404, "not found");
    if (req.method === "GET") return json(boardDefaults(profile));
    if (req.method !== "PATCH") return error(404, "not found");
    const { claudeModel, ...rest } = picks(b, { claudeModel: validModel, claudeEffort: (v) => CLAUDE_EFFORTS.includes(v), codexModel: validCodexModel, codexEffort: (v) => CODEX_EFFORTS.includes(v) });
    const next: Profile = { ...profile, ...rest, ...(claudeModel !== undefined ? { model: claudeModel } : {}) };
    deps.store.saveProfile(next);
    deps.bus.emit({ type: "profile.updated", slug: next.slug, profile: next });
    return json(boardDefaults(next));
  } catch (e) {
    return error(400, (e as Error).message);
  }
}
