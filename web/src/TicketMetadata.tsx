import { useEffect, useState } from "react";
import { api, type Ticket } from "./api";
import { AgentSettings } from "./AgentSettings";
import { PRIORITIES, TEMPLATES } from "./ticketTemplates";
export function TicketMetadata({
  slug,
  ticket,
  onError,
}: {
  slug: string;
  ticket: Ticket;
  onError: (message: string) => void;
}) {
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [labels, setLabels] = useState((ticket.labels ?? []).join(", "));
  useEffect(
    () => setLabels((ticket.labels ?? []).join(", ")),
    [ticket.id, JSON.stringify(ticket.labels)]
  );
  const save = async (
    patch: Partial<Pick<Ticket, "priority" | "kind" | "labels">>
  ) => {
    setBusy(true);
    try {
      await api.updateTicket(slug, ticket.id, patch);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ticket-properties" aria-label="Ticket properties">
      <button
        className="btn small"
        type="button"
        onClick={() => setSettings(true)}
      >
        Agent: {ticket.agent === "codex" ? "Codex" : "Claude"}
      </button>
      {settings && (
        <AgentSettings
          slug={slug}
          ticket={ticket}
          onClose={() => setSettings(false)}
        />
      )}
      <label>
        Priority
        <select
          disabled={busy}
          value={ticket.priority ?? "normal"}
          onChange={(e) =>
            save({ priority: e.target.value as Ticket["priority"] })
          }
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p[0].toUpperCase() + p.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Type
        <select
          disabled={busy}
          value={ticket.kind ?? "task"}
          onChange={(e) => save({ kind: e.target.value as Ticket["kind"] })}
        >
          {TEMPLATES.map((t) => (
            <option key={t.kind} value={t.kind}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save({
            labels: labels
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          });
        }}
      >
        <label>
          Labels
          <input
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            placeholder="frontend, auth"
            maxLength={330}
          />
        </label>
        <button
          className="btn small"
          disabled={busy || labels === (ticket.labels ?? []).join(", ")}
        >
          Save labels
        </button>
      </form>
    </section>
  );
}
