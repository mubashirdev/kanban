import type { Status, Ticket } from "./api";
import { Modal } from "./Modal";

const MOVES: { to: Status; label: string }[] = [
  { to: "backlog", label: "Backlog" },
  { to: "planning", label: "Planning" },
  { to: "ready", label: "Run now" },
  { to: "review", label: "Review" },
  { to: "done", label: "Done" },
];

/** What long-pressing a card offers on a phone: open it, or send it to any lane. */
export function CardActions({ ticket, onOpen, onMove, onClose }: { ticket: Ticket; onOpen: () => void; onMove: (to: Status) => void; onClose: () => void }) {
  const working = ticket.status === "in_progress" || !!ticket.running;
  const moves = MOVES.filter((m) => m.to !== ticket.status && !(working && m.to === "ready"));
  return (
    <Modal title={ticket.title} onClose={onClose}>
      <div className="sheet-list">
        <button type="button" className="sheet-action primary" onClick={onOpen}>Open</button>
        {moves.map((m) => (
          <button type="button" key={m.to} className="sheet-action" onClick={() => onMove(m.to)}>{m.to === "ready" ? m.label : `Move to ${m.label}`}</button>
        ))}
      </div>
    </Modal>
  );
}
