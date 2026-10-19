import type { Ticket } from "../../api";
import type { AgentId } from "../codex/api";

export type Access = "read" | "edit";

/** The Chats add-on's fields on a ticket (Leo's Ticket type doesn't list them). */
export type ChatTicket = Ticket & { standalone?: boolean; access?: Access; readAt?: string | null };

export const accessOf = (t: Ticket): Access => ((t as ChatTicket).access === "edit" ? "edit" : "read");

async function post(url: string, body: unknown): Promise<Ticket> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-ckanban-source": "ui" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `${r.status} ${r.statusText}`);
  return data;
}

const ticket = (id: string) => `/api/addons/chats/tickets/${encodeURIComponent(id)}`;

export const chatsApi = {
  start: (slug: string, input: { text: string; agent: AgentId; access: Access }) => post(`/api/addons/chats/boards/${encodeURIComponent(slug)}`, input),
  setAccess: (id: string, access: Access) => post(`${ticket(id)}/access`, { access }),
  setRead: (id: string, read: boolean) => post(`${ticket(id)}/read`, { read }),
  move: (id: string, to: "chats" | "board") => post(`${ticket(id)}/move`, { to }),
};
