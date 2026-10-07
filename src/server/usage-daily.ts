import type { Store } from "./store";

export interface DayUsage {
  date: string;
  claudeRuns: number;
  codexRuns: number;
  /** Claude only: Codex runs don't report a cost. */
  costUsd: number;
  seconds: number;
}

const localDay = (d: Date) => d.toLocaleDateString("en-CA");

/** Finished runs, Claude cost and run time per local day over the last `days` days, newest first, across every board. */
export function dailyUsage(store: Store, days = 7, now = new Date()): DayUsage[] {
  const out = new Map<string, DayUsage>();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    out.set(localDay(d), { date: localDay(d), claudeRuns: 0, codexRuns: 0, costUsd: 0, seconds: 0 });
  }
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days + 1);
  cutoff.setHours(0, 0, 0, 0);

  for (const profile of store.listProfiles()) {
    for (const ticket of store.listTickets(profile.slug)) {
      const modified = Number(store.activityVersion(profile.slug, ticket.id)?.split(":")[0]);
      if (!modified || modified < cutoff.getTime()) continue;
      for (const entry of store.readActivity(profile.slug, ticket.id)) {
        if (entry.event?.type !== "result") continue;
        const bucket = out.get(localDay(new Date(entry.at)));
        if (!bucket) continue;
        if (entry.event.provider === "codex") bucket.codexRuns++;
        else bucket.claudeRuns++;
        bucket.costUsd += typeof entry.event.total_cost_usd === "number" ? entry.event.total_cost_usd : 0;
        bucket.seconds += typeof entry.event.duration_ms === "number" ? entry.event.duration_ms / 1000 : 0;
      }
    }
  }
  return [...out.values()];
}
