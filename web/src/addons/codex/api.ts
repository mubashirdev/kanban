import type { Ticket } from "../../api";

export type AgentId = "claude" | "codex";

/** Codex paused before a command or an edit outside its sandbox (src/server/addons/codex/asks.ts). */
export interface CodexAsk {
  id: string;
  kind: "command" | "edit";
  detail: string;
  reason: string;
  at: string;
}

/** The Codex add-on's fields on a ticket (Leo's Ticket type doesn't list them). */
type CodexTicket = Ticket & { agent?: AgentId; codexAsk?: CodexAsk | null };

export const agentOf = (t: Ticket): AgentId => ((t as CodexTicket).agent === "codex" ? "codex" : "claude");
/** The name the chat shows on the agent's replies. */
export const agentName = (t: Ticket) => (agentOf(t) === "codex" ? "Codex" : "Claude");
export const askOf = (t: Ticket): CodexAsk | null => (t as CodexTicket).codexAsk ?? null;

const base = (id: string) => `/api/addons/codex/tickets/${encodeURIComponent(id)}`;

async function post(url: string, body: unknown): Promise<Ticket> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-ckanban-source": "ui" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `${r.status} ${r.statusText}`);
  return data;
}

export const codexApi = {
  setAgent: (id: string, agent: AgentId) => post(`${base(id)}/agent`, { agent }),
  answer: (id: string, askId: string, allow: boolean, always = false) => post(`${base(id)}/permission`, { askId, allow, always }),
};
