import { useEffect, useState } from "react";
import { api, type AgentStatus, type Ticket } from "./api";
import { Modal } from "./Modal";

export function AgentSettings({
  slug,
  ticket,
  onClose,
}: {
  slug: string;
  ticket: Ticket;
  onClose: () => void;
}) {
  const [agent, setAgent] = useState(ticket.agent ?? "claude");
  const [custom, setCustom] = useState(false);
  const [model, setModel] = useState(ticket.codexModel ?? "");
  const [effort, setEffort] = useState(ticket.codexEffort ?? "");
  const [models, setModels] = useState<
    { value: string; displayName: string; efforts: string[] }[]
  >([]);
  useEffect(() => {
    let active = true;
    api
      .codexModels()
      .then((value) => {
        if (active) setModels(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api
      .agents()
      .then((value) => {
        if (active) setAgents(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <Modal title={ticket.standalone ? "Codex settings" : "Ticket agent"} onClose={onClose}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await api.updateTicket(slug, ticket.id, {
              agent,
              ...(agent === "codex"
                ? {
                    codexModel: model.trim() || null,
                    codexEffort: (effort || null) as Ticket["codexEffort"],
                  }
                : {}),
            });
            onClose();
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {/* A session's agent is fixed: its whole conversation lives in that agent. */}
        {!ticket.standalone && <label>
          Agent
          <select
            value={agent}
            disabled={busy || ticket.running || !!ticket.workdir}
            onChange={(e) => setAgent(e.target.value as "claude" | "codex")}
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </label>}
        {ticket.running && !ticket.standalone && (
          <p className="muted small">
            Stop the current run before switching agents.
          </p>
        )}
        {ticket.workdir && (
          <p className="muted small">
            This ticket is linked to an existing Claude session.
          </p>
        )}
        {agents && (
          <p className="muted small">
            {agents.find((a) => a.id === agent)?.available
              ? `${
                  agent === "codex" ? "Codex" : "Claude"
                } is installed. Sign in with its CLI before running work.`
              : `${
                  agent === "codex" ? "Codex" : "Claude"
                } is not installed. Install it in Connections first.`}
          </p>
        )}
        {agent === "codex" && (
          <>
            <label>
              Model
              {models.length > 0 && (
                <select
                  disabled={busy}
                  value={
                    custom || (model && !models.some((m) => m.value === model))
                      ? "__custom"
                      : model
                  }
                  onChange={(e) => {
                    if (e.target.value === "__custom") {
                      setCustom(true);
                      setModel("");
                    } else {
                      setCustom(false);
                      setModel(e.target.value);
                      setEffort("");
                    }
                  }}
                >
                  <option value="">Use Codex configuration</option>
                  {models.map((m) => (
                    <option value={m.value} key={m.value}>
                      {m.displayName}
                    </option>
                  ))}
                  <option value="__custom">Custom model ID…</option>
                </select>
              )}
              {(custom ||
                !models.length ||
                (model && !models.some((m) => m.value === model))) && (
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  maxLength={100}
                  placeholder="Use Codex configuration"
                  pattern="[a-zA-Z0-9._:-]+"
                  disabled={busy}
                />
              )}
            </label>
            <label>
              Reasoning effort
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
                disabled={busy}
              >
                <option value="">Use Codex configuration</option>
                {(
                  models.find((m) => m.value === model)?.efforts ?? [
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "max",
                    "ultra",
                  ]
                ).map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <p className="muted small">
              Choices come from the installed CLI’s model cache. Model support
              depends on your Codex account.{ticket.standalone ? "" : " Planning uses a read-only sandbox."}
              {" "}Messages sent during a run are queued for the next turn.
            </p>
          </>
        )}
        {!ticket.standalone && <p className="muted small">
          Each agent keeps a separate conversation. Ticket files and properties
          are shared.
        </p>}
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        <button className="btn primary" disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </button>
      </form>
    </Modal>
  );
}
