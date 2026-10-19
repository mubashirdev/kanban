import { useState } from "react";
import type { Ticket } from "../../api";
import { agentOf, codexApi, type AgentId } from "./api";

const HINT = "Codex asks you before it runs commands or edits outside the folder.";

/** The agent's small mark: Claude a clay star, Codex a dark prompt. */
export function AgentMark({ agent }: { agent: AgentId }) {
  return <span className={`agent-mark ${agent}`} aria-hidden>{agent === "codex" ? ">_" : "✳"}</span>;
}

/** Claude | Codex, in Leo's segmented style. */
export function AgentSwitch({ value, onChange, disabled }: { value: AgentId; onChange: (a: AgentId) => void; disabled?: boolean }) {
  return (
    <div className="segmented agent-switch" role="radiogroup" aria-label="Who works on it">
      {(["claude", "codex"] as const).map((a) => (
        <button key={a} type="button" role="radio" aria-checked={value === a} disabled={disabled}
          className={value === a ? "on" : ""} onClick={() => onChange(a)}>
          <AgentMark agent={a} />{a === "codex" ? "Codex" : "Claude"}
        </button>
      ))}
    </div>
  );
}

/** The New ticket form's "Who works on it" field; `payload` goes into the create request. */
export function useAgentPicker() {
  const [agent, setAgent] = useState<AgentId>("claude");
  return {
    payload: agent === "codex" ? { agent } : {},
    field: (
      <div className="field">
        <div className="field-label">Who works on it</div>
        <AgentSwitch value={agent} onChange={setAgent} />
        {agent === "codex" && <span className="muted small">{HINT}</span>}
      </div>
    ),
  };
}

/** Ticket menu row: switch who works on this ticket (not while it is working). */
export function AgentRow({ ticket, working }: { ticket: Ticket; working: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const agent = agentOf(ticket);
  const pick = (a: AgentId) => {
    if (a === agent) return;
    setError(null);
    codexApi.setAgent(ticket.id, a).catch((e) => setError(e.message));
  };
  return (
    <div className="menu-item agent-row">
      <span className="menu-label">Who works on it</span>
      <AgentSwitch value={agent} onChange={pick} disabled={working} />
      <span className="menu-hint">
        {error ?? (working ? "Wait until it's done to switch" : "Switching starts a new conversation for the next message.")}
      </span>
    </div>
  );
}

/** Board card: a Codex ticket shows the Codex mark and name. */
export function CodexCardMark({ ticket }: { ticket: Ticket }) {
  if (agentOf(ticket) !== "codex") return null;
  return (
    <div className="card-meta card-agent">
      <AgentMark agent="codex" /><span className="pill">Codex</span>
    </div>
  );
}
