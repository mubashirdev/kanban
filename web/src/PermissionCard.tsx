import { useState } from "react";
import { api, type PermissionAsk } from "./api";
import { ShieldAlertIcon } from "./icons";
import { Markdown } from "./Transcript";

/** "run a command", "edit a file": what the agent wants to do, in plain words. */
function wantsTo(tool: string): string {
  if (tool === "Bash") return "run a command";
  if (tool === "Write") return "create a file";
  if (tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") return "edit a file";
  if (tool === "WebFetch") return "open a web page";
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  return `use ${(mcp ? mcp[2] : tool).replace(/[_-]+/g, " ")}`;
}

/** Claude paused mid-run to ask for permission: allow or deny it here, like the desktop app's prompt. */
export function PermissionCard({ slug, id, ask, agent, readOnly, onError }: {
  slug: string; id: string; ask: PermissionAsk; agent: string;
  /** A read-only chat: approving the plan also turns edit access on. */
  readOnly: boolean;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const answer = (allow: boolean, always = false) => {
    setBusy(true);
    api.answerPermission(slug, id, ask.id, allow, always).catch((e) => {
      setBusy(false);
      onError(e.message);
    });
  };
  const plan = ask.tool === "ExitPlanMode";
  return (
    <div className="ask-card" role="alertdialog" aria-label={plan ? `${agent} asks to start on its plan` : `${agent} asks for permission`}>
      <div className="ask-title"><ShieldAlertIcon size={15} />{plan ? `${agent} has a plan and wants to start` : `${agent} wants to ${wantsTo(ask.tool)}`}</div>
      {plan ? ask.plan && <div className="ask-plan"><Markdown text={ask.plan} /></div>
        : ask.detail && <code className="ask-detail">{ask.detail}</code>}
      <div className="ask-actions">
        <button className="btn primary" disabled={busy} onClick={() => answer(true)}>{plan ? "Approve and start" : "Allow"}</button>
        {!plan && ask.canAlways && <button className="btn" disabled={busy} onClick={() => answer(true, true)}>Always allow in this chat</button>}
        <button className="btn" disabled={busy} onClick={() => answer(false)}>{plan ? "Keep planning" : "Deny"}</button>
      </div>
      {plan && <div className="ask-note">Approving lets {agent} edit files{readOnly ? " and turns on edit access for this chat" : " for the rest of this reply"}.</div>}
    </div>
  );
}
