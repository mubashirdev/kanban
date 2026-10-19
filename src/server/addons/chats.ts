import { BRAND } from "../../../web/src/addons/brand";
import type { Board } from "../board";
import type { Bus } from "../events";
import { HUDDLE_HEADER } from "../huddle-roster";
import { QUESTIONS_FORMAT, type ChatMode } from "../prompts";
import { RUN_HEADER } from "../scheduler";
import type { Store } from "../store";
import type { Ticket } from "../types";
import { setTicketAgent } from "./codex/http";
import { attachedStore, ticketRef } from "./codex/state";

/**
 * Chats: conversations off the board. A chat is a ticket with `standalone: true` (the same fields our old version
 * saved, so its chats still show up). It stays in Backlog, never moves, runs in the board folder (no copy of the
 * folder, no pull request), and gets the user's messages as typed.
 */
export interface ChatFields {
  standalone?: boolean;
  /** "read": it may look around but not change files. Missing: read. */
  access?: "read" | "edit";
  /** When the user last looked at it: a reply after this is unread. */
  readAt?: string | null;
}

type ChatTicket = Ticket & ChatFields;

export const isChat = (t: unknown): boolean => !!(t as ChatFields | null | undefined)?.standalone;
export const accessOf = (t: unknown): "read" | "edit" => ((t as ChatFields | null | undefined)?.access === "edit" ? "edit" : "read");

/**
 * How a chat runs a message (Leo's chatFor asks first): as typed, quietly (the card never moves, no slot, no result
 * line), read-only like a Planning chat unless it may edit. Null for a board ticket.
 */
export function chatTurn(t: unknown, msg: { text: string; slash?: "prompt" | "local" }):
  { text: string; mode: ChatMode; raw: true; quiet: true; slash?: "prompt" | "local" } | null {
  if (!isChat(t)) return null;
  return { text: msg.text, mode: accessOf(t) === "edit" ? "act" : "refine", raw: true, quiet: true, ...(msg.slash ? { slash: msg.slash } : {}) };
}

/** What a chat's agent is told on every turn (its access can change between turns). */
export function chatSystemPrompt(access: "read" | "edit"): string {
  return `You are chatting with the user through the ${BRAND.name} app, often on their phone. This is a plain chat, not a board ticket: there is no copy of the folder, pull request or result line to report.
Keep replies short and easy to read on a small screen.
${access === "read"
    ? "Access right now: read only. Read code and answer, but do not change files, also not with shell commands."
    : "Access right now: can edit. You may change files in this folder when the user asks."} The user can switch this at any time; this line is always current, even if earlier turns said otherwise.
${QUESTIONS_FORMAT}`;
}

/** A chat's run gets the chat prompt added to Claude's system prompt (Codex reads it from the same flag). */
export function withChatPrompt(args: string[], env: Record<string, string> | undefined): string[] {
  const ref = ticketRef(env?.CKANBAN_TICKET);
  const t = ref ? attachedStore()?.getTicket(ref.slug, ref.id) : null;
  if (!isChat(t)) return args;
  const prompt = chatSystemPrompt(accessOf(t));
  const i = args.indexOf("--append-system-prompt");
  if (i < 0) return [...args, "--append-system-prompt", prompt];
  return args.map((a, n) => (n === i + 1 ? `${a}\n\n${prompt}` : a));
}

/** A short title from the first message, like a chat app names a new thread. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0].replace(/^\/\S+\s*/, "").trim() || text.trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const error = (status: number, message: string) => json({ error: message }, status);

/**
 * The Chats add-on's routes, only for the user (not board runs or huddle teammates):
 * - POST /api/addons/chats/boards/:slug {text, agent, access}: start a chat with its first message.
 * - POST /api/addons/chats/tickets/:id/access {access}: Read only or Can edit, for the next message.
 * - POST /api/addons/chats/tickets/:id/read {read}: mark it read or unread.
 * - POST /api/addons/chats/tickets/:id/move {to: "chats" | "board"}: a board ticket becomes a chat, or back.
 */
export async function chatRoutes(req: Request, parts: string[], deps: { store: Store; board: Board; bus: Bus }): Promise<Response | null> {
  if (parts[0] !== "addons" || parts[1] !== "chats") return null;
  if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) return error(403, "only the user can do this");
  // Browsers always send Origin on a POST (Leo's gate already checked it matches); a bare curl from a run doesn't.
  if (req.method !== "POST" || !req.headers.get("origin")) return error(403, "only the user can do this");
  const { store, board, bus } = deps;
  const [, , what, key, action] = parts;
  const b: any = await req.json().catch(() => null);
  const patch = (slug: string, id: string, fields: Partial<ChatTicket>) => {
    const t = store.updateTicket(slug, id, fields as Partial<Ticket>);
    bus.emit({ type: "ticket.updated", profile: slug, ticket: t });
    return t;
  };

  if (what === "boards" && parts.length === 4) {
    if (!store.getProfile(key)) return error(404, `board ${key} not found`);
    const text = String(b?.text ?? "").trim();
    if (!text) return error(400, "message is empty");
    const t = await board.createTicket(key, { title: titleFrom(text), body: "", status: "backlog" });
    patch(key, t.id, { standalone: true, access: b?.access === "edit" ? "edit" : "read", readAt: new Date().toISOString() });
    if (b?.agent === "codex") setTicketAgent(store, key, t.id, "codex");
    return json(await board.chat(key, t.id, text));
  }

  if (what !== "tickets" || parts.length !== 5 || !/^t_\w+$/.test(key)) return error(404, "not found");
  // Ticket ids are unique across boards, so the UI doesn't need to name the board.
  const slug = store.listProfiles().find((p) => store.getTicket(p.slug, key))?.slug;
  const t = slug ? store.getTicket(slug, key) : null;
  if (!slug || !t) return error(404, `ticket ${key} not found`);
  if (action === "access") {
    if (!isChat(t)) return error(400, "only chats have an access setting");
    if (b?.access !== "read" && b?.access !== "edit") return error(400, "access must be read or edit");
    return json(patch(slug, key, { access: b.access }));
  }
  if (action === "read") {
    // Any time before the last reply makes it unread again.
    return json(patch(slug, key, { readAt: b?.read === false ? new Date(0).toISOString() : new Date().toISOString() }));
  }
  if (action === "move") {
    if (board.isRunning(slug, key)) return error(409, "Wait until the current reply is done, then move it");
    if (b?.to === "chats") return json(patch(slug, key, { standalone: true, access: "read", readAt: new Date().toISOString(), status: "backlog" }));
    if (b?.to === "board") return json(patch(slug, key, { standalone: false, access: undefined, readAt: undefined, status: "backlog" }));
    return error(400, "to must be chats or board");
  }
  return error(404, "not found");
}
