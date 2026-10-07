// Pure helpers for the header usage pill (kept out of the component so tests can import them).

export interface UsageWindow {
  key: string;
  label: string;
  percent: number;
  resetsAt: string | null;
}

export interface ExtraUsage { usedDollars: number; limitDollars: number | null; limitReached: boolean; enabled: boolean }

export type UsageResult =
  | { windows: UsageWindow[]; plan?: string | null; extra?: ExtraUsage | null; fetchedAt: string }
  | { error: string; fetchedAt: string };

export type UsageTone = "ok" | "warn" | "err";

/** Amber from 80%, red from 95%. */
export function usageTone(percent: number): UsageTone {
  if (percent >= 95) return "err";
  if (percent >= 80) return "warn";
  return "ok";
}

/** The pill takes the colour of the fullest window. */
export function worstTone(windows: UsageWindow[]): UsageTone {
  return usageTone(Math.max(0, ...windows.map((w) => w.percent)));
}

const pct = (n: number) => `${Math.round(n)}%`;

/** "Usage · 5h 42% · week 81%" */
export function pillText(windows: UsageWindow[]): string {
  const short: Record<string, string> = { five_hour: "5h", seven_day: "week" };
  const parts = windows.filter((w) => short[w.key]).map((w) => `${short[w.key]} ${pct(w.percent)}`);
  return ["Usage", ...(parts.length ? parts : windows.slice(0, 2).map((w) => `${w.label} ${pct(w.percent)}`))].join(" · ");
}

function inWords(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "Resets 4:10 PM (in 2h 15m)" within a day, "Resets Thu 9:00 AM" further out. */
export function resetText(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  const ms = at.getTime() - now;
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "Resets now";
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (ms < 24 * 3600_000) return `Resets ${time} (in ${inWords(ms)})`;
  return `Resets ${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

export interface CliUsage { intro: string | null; windows: { label: string; percent: number; resets: string | null }[]; rest: string }

/**
 * Claude Code's `/usage` text ("Current session: 1% used · resets Oct 7 at 12:40am (…)") as data,
 * so the chat can draw it like the board's usage view. Null when the text isn't that report.
 */
export function parseCliUsage(text: string): CliUsage | null {
  const lines = text.trim().split("\n");
  const windows: CliUsage["windows"] = [];
  let last = -1;
  lines.forEach((line, i) => {
    const m = /^\s*(Current [^:]+):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets (.+?))?\s*$/.exec(line);
    if (!m) return;
    windows.push({ label: m[1], percent: Math.min(100, Number(m[2])), resets: m[3] ? `Resets ${m[3].replace(/\s*\([^)]*\)\s*$/, "")}` : null });
    last = i;
  });
  if (!windows.length) return null;
  const first = lines.findIndex((l) => /^\s*Current [^:]+:/.test(l));
  const intro = lines.slice(0, first).join(" ").trim() || null;
  return { intro, windows, rest: lines.slice(last + 1).join("\n").trim() };
}
