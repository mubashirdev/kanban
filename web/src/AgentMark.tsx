import { useEffect, useState } from "react";
import { api, type Ticket } from "./api";
import { ClaudeMarkIcon, CodexMarkIcon, CursorMarkIcon } from "./icons";

const MARKS = { claude: ClaudeMarkIcon, codex: CodexMarkIcon, cursor: CursorMarkIcon };

/** The agent's badge: Claude is a clay starburst, Codex a graphite prompt, Cursor a pointer on a dark square. */
export function AgentMark({ agent = "claude", size = "normal" }: { agent?: Ticket["agent"]; size?: "normal" | "small" }) {
  const Mark = MARKS[agent];
  const px = size === "small" ? 11 : 16;
  return (
    <span className={`agent-mark ${agent}${size === "small" ? " small" : ""}`} aria-hidden>
      <Mark size={px} />
    </span>
  );
}

/** The agent's name as users see it. */
export const agentLabel = (agent?: Ticket["agent"]) => (agent === "codex" ? "Codex" : agent === "cursor" ? "Cursor" : "Claude");

/** Cursor is offered only when its CLI is installed. */
export function useCursorAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    api.agents().then((list) => setAvailable(!!list.find((a) => a.id === "cursor")?.available), () => {});
  }, []);
  return available;
}
