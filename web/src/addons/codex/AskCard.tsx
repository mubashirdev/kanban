import { useEffect, useState } from "react";
import type { Ticket } from "../../api";
import { askOf, codexApi } from "./api";
import { AgentSwitch } from "./AgentPicker";

/** Codex paused mid-run to ask before going outside its sandbox: answer it here, on the ticket or the phone. */
export function CodexAskCard({ ticket, onError }: { ticket: Ticket; onError: (message: string) => void }) {
  const ask = askOf(ticket);
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [ask?.id]);
  if (!ask) return null;
  const answer = (allow: boolean, always = false) => {
    setBusy(true);
    codexApi.answer(ticket.id, ask.id, allow, always).catch((e) => {
      setBusy(false);
      onError(e.message);
    });
  };
  return (
    <div className="codex-ask" role="alertdialog" aria-label="Codex asks for permission">
      <div className="codex-ask-title">{ask.kind === "command" ? "Codex wants to run a command" : "Codex wants to edit files outside the folder"}</div>
      <div className="codex-ask-sub">It's waiting for your answer</div>
      {ask.reason && <div className="codex-ask-reason">{ask.reason}</div>}
      {ask.detail && <code className="codex-ask-detail">{ask.detail}</code>}
      <button className="btn primary" disabled={busy} onClick={() => answer(true)}>Allow</button>
      <button className="btn" disabled={busy} onClick={() => answer(true, true)}>Always allow in this chat</button>
      <button className="btn codex-deny" disabled={busy} onClick={() => answer(false)}>Deny</button>
    </div>
  );
}

/** Huddle roster: a teammate runs on Claude or Codex (model "codex" on the roster line). */
export function RosterAgentSwitch({ model, onChange, disabled }: { model: string | null | undefined; onChange: (model: string | null) => void; disabled?: boolean }) {
  return (
    <AgentSwitch value={model === "codex" ? "codex" : "claude"} disabled={disabled}
      onChange={(a) => onChange(a === "codex" ? "codex" : null)} />
  );
}
