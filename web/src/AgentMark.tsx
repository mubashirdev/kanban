import type { Ticket } from "./api";
import { ClaudeMarkIcon, CodexMarkIcon } from "./icons";

/** The agent's badge: Claude is a clay starburst, Codex a graphite prompt. */
export function AgentMark({ agent, size = "normal" }: { agent?: Ticket["agent"]; size?: "normal" | "small" }) {
  const codex = agent === "codex";
  const px = size === "small" ? 11 : 16;
  return (
    <span className={`agent-mark ${codex ? "codex" : "claude"}${size === "small" ? " small" : ""}`} aria-hidden>
      {codex ? <CodexMarkIcon size={px} /> : <ClaudeMarkIcon size={px} />}
    </span>
  );
}
