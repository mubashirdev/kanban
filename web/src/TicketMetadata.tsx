import { useEffect, useState } from "react";
import { api, type Ticket } from "./api";
import { AgentSettings } from "./AgentSettings";
import { AgentMark } from "./AgentMark";
import { ChevronRightIcon } from "./icons";
import { PRIORITIES, TEMPLATES } from "./ticketTemplates";

const label = (s: string) => s[0].toUpperCase() + s.slice(1);
const parseLabels = (text: string) => text.split(",").map((s) => s.trim()).filter(Boolean);

/** Ticket settings as one grouped list, like iOS Settings: each row shows its value and changes in place. */
export function TicketMetadata({ slug, ticket, onError }: { slug: string; ticket: Ticket; onError: (message: string) => void }) {
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [labels, setLabels] = useState((ticket.labels ?? []).join(", "));
  useEffect(() => setLabels((ticket.labels ?? []).join(", ")), [ticket.id, JSON.stringify(ticket.labels)]);
  const save = async (patch: Partial<Pick<Ticket, "priority" | "kind" | "labels">>) => {
    setBusy(true);
    try {
      await api.updateTicket(slug, ticket.id, patch);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };
  // Labels save when you leave the field or press Return; no separate button.
  const saveLabels = () => {
    if (labels.trim() !== (ticket.labels ?? []).join(", ")) void save({ labels: parseLabels(labels) });
  };
  const codex = ticket.agent === "codex";
  return (
    <section className="detail-list" aria-label="Ticket settings">
      <button type="button" className="detail-row" onClick={() => setSettings(true)}>
        <span className="detail-key">Agent</span>
        <span className="detail-value"><AgentMark agent={ticket.agent} size="small" />{codex ? "Codex" : "Claude"}</span>
        <ChevronRightIcon className="icon detail-chevron" />
      </button>
      <label className="detail-row">
        <span className="detail-key">Priority</span>
        <select className="detail-select" disabled={busy} value={ticket.priority ?? "normal"}
          onChange={(e) => save({ priority: e.target.value as Ticket["priority"] })}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{label(p)}</option>)}
        </select>
        <ChevronRightIcon className="icon detail-chevron" />
      </label>
      <label className="detail-row">
        <span className="detail-key">Type</span>
        <select className="detail-select" disabled={busy} value={ticket.kind ?? "task"}
          onChange={(e) => save({ kind: e.target.value as Ticket["kind"] })}>
          {TEMPLATES.map((t) => <option key={t.kind} value={t.kind}>{t.name}</option>)}
        </select>
        <ChevronRightIcon className="icon detail-chevron" />
      </label>
      <label className="detail-row">
        <span className="detail-key">Labels</span>
        <input className="detail-input" value={labels} disabled={busy} placeholder="Add labels" maxLength={330}
          onChange={(e) => setLabels(e.target.value)} onBlur={saveLabels}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }} />
      </label>
      {settings && <AgentSettings slug={slug} ticket={ticket} onClose={() => setSettings(false)} />}
    </section>
  );
}
