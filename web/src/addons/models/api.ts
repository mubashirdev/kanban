import type { Ticket } from "../../api";

/** Our fields next to Leo's `model` (src/server/addons/models.ts). */
export type ModelTicket = Ticket & { effort?: string | null; codexModel?: string | null; codexEffort?: string | null };

export interface BoardDefaults {
  claudeModel: string | null;
  claudeEffort: string | null;
  codexModel: string | null;
  codexEffort: string | null;
}

/** A model the picker offers. efforts null: every level. */
export interface ModelOption {
  value: string;
  displayName: string;
  efforts: string[] | null;
}

export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"];
export const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json", "x-ckanban-source": "ui" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `${r.status} ${r.statusText}`);
  return data;
}

// Both lists change rarely: one load per page.
let claudeList: Promise<ModelOption[]> | null = null;
let codexList: Promise<ModelOption[]> | null = null;

export const modelsApi = {
  claudeModels: () => (claudeList ??= req<ModelOption[]>("GET", "/api/addons/models/claude").catch((e) => { claudeList = null; throw e; })),
  codexModels: () => (codexList ??= req<ModelOption[]>("GET", "/api/addons/codex/models").catch((e) => { codexList = null; throw e; })),
  setTicket: (id: string, patch: Partial<Pick<ModelTicket, "model" | "effort" | "codexModel" | "codexEffort">>) =>
    req<Ticket>("POST", `/api/addons/models/tickets/${encodeURIComponent(id)}`, patch),
  boardDefaults: (slug: string) => req<BoardDefaults>("GET", `/api/addons/models/boards/${encodeURIComponent(slug)}`),
  setBoardDefaults: (slug: string, patch: Partial<BoardDefaults>) => req<BoardDefaults>("PATCH", `/api/addons/models/boards/${encodeURIComponent(slug)}`, patch),
};
