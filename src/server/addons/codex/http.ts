import type { AgentId } from "../../agents";
import type { Board } from "../../board";
import { HUDDLE_HEADER } from "../../huddle-roster";
import { RUN_HEADER } from "../../scheduler";
import type { Store } from "../../store";
import { answerAsk, AskGoneError, forgetAlways } from "./asks";
import { codexModels } from "./catalog";
import { agentOf, patchTicket } from "./state";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const error = (status: number, message: string) => json({ error: message }, status);

const isAgent = (v: unknown): v is AgentId => v === "claude" || v === "codex";

/**
 * Switch who works on a ticket. The next message starts a new conversation with the new agent: a Codex ticket
 * forgets its Codex thread, and a ticket going back to Claude gets a new Claude session.
 */
export function setTicketAgent(store: Store, slug: string, id: string, agent: AgentId) {
  const t = store.getTicket(slug, id);
  if (!t || agentOf(t) === agent) return t;
  forgetAlways(slug, id);
  const fresh = t.sessionStarted || t.runCount > 0 ? { sessionId: null, sessionStarted: false } : {};
  return patchTicket(slug, id, { agent, codexSessionId: null, ...(agent === "claude" ? fresh : {}) });
}

/** A new ticket from the New ticket form: `agent` in its body picks who works on it (Leo's create ignores it). */
export function agentOnCreate(store: Store, slug: string, id: string, body: any) {
  if (body?.agent === "codex") setTicketAgent(store, slug, id, "codex");
}

/**
 * The Codex add-on's routes: GET /api/addons/codex/models, POST /api/addons/codex/tickets/:id/agent|permission. Only the user may use them:
 * board runs and huddle teammates can't answer permission asks or switch agents.
 */
export async function codexRoutes(req: Request, parts: string[], deps: { store: Store; board: Board }): Promise<Response | null> {
  if (parts[0] !== "addons" || parts[1] !== "codex") return null;
  if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) return error(403, "only the user can do this");
  const [, , what, id, action] = parts;
  if (req.method === "GET" && what === "models" && parts.length === 3) return json(codexModels());
  // Browsers always send Origin on a POST (Leo's gate already checked it matches); a bare curl from a run doesn't.
  if (req.method === "POST" && !req.headers.get("origin")) return error(403, "only the user can do this");
  if (req.method !== "POST" || what !== "tickets" || parts.length !== 5 || !/^t_\w+$/.test(id)) return error(404, "not found");
  // Ticket ids are unique across boards, so the UI doesn't need to know the board (Leo's ticket menu doesn't).
  const slug = deps.store.listProfiles().find((p) => deps.store.getTicket(p.slug, id))?.slug;
  if (!slug) return error(404, `ticket ${id} not found`);
  const b: any = await req.json().catch(() => null);
  if (action === "agent") {
    if (!isAgent(b?.agent)) return error(400, "agent must be claude or codex");
    if (deps.board.isRunning(slug, id)) return error(409, "Wait until the current reply is done, then switch");
    return json(setTicketAgent(deps.store, slug, id, b.agent));
  }
  if (action === "permission") {
    try {
      answerAsk(slug, id, String(b?.askId ?? ""), b?.allow === true, b?.always === true);
    } catch (e) {
      if (e instanceof AskGoneError) return error(409, e.message);
      throw e;
    }
    return json(deps.store.getTicket(slug, id));
  }
  return error(404, "not found");
}
