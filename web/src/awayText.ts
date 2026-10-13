// Plain words for phone access (see src/server/away.ts), no React so tests can import them.

export interface TunnelStatus {
  state: "online" | "offline" | "none";
  since: string | null;
  url: string | null;
}

/** "21:04", or "Oct 12, 21:04" when it wasn't today. */
function clock(iso: string, now: Date): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export function phoneAccessLabel(t: TunnelStatus, now = new Date()): string {
  if (t.state === "online") return "Phone access: online";
  if (t.state === "offline") return t.since ? `Phone access: offline since ${clock(t.since, now)}` : "Phone access: offline";
  return "Phone access: not set up";
}

export const LID_COMMAND = "sudo pmset -a disablesleep 1";
export const LID_UNDO = "sudo pmset -a disablesleep 0";
