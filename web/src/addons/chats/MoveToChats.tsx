import type { Ticket } from "../../api";
import { ChatIcon } from "../../icons";
import { toast } from "../../toast";
import { chatsApi } from "./api";

/** Ticket menu row: a board ticket becomes a chat (off the board, read only until switched). */
export function MoveToChats({ ticket, working }: { ticket: Ticket; working: boolean }) {
  const move = () => chatsApi.move(ticket.id, "chats").then(() => toast("Moved to Chats.", { tone: "ok" }), (e) => toast(e.message, { tone: "error" }));
  return (
    <button role="menuitem" className="menu-item" disabled={working} onClick={move}>
      <span className="menu-icon" aria-hidden><ChatIcon size={14} /></span>
      <span className="menu-label">Move to Chats</span>
      <span className="menu-hint">{working ? "Wait until Claude is done" : "off the board"}</span>
    </button>
  );
}
