import { useEffect, useState } from "react";
import { api, type DayUsage } from "./api";
import { Modal } from "./Modal";

const dayLabel = (date: string, index: number) =>
  index === 0 ? "Today" : index === 1 ? "Yesterday" : new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" });

const duration = (seconds: number) => (seconds < 60 ? `${Math.round(seconds)}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${(seconds / 3600).toFixed(1)}h`);

const money = (usd: number) => usd.toLocaleString("en-US", { style: "currency", currency: "USD" });

export function DailyCostDialog({ onClose }: { onClose: () => void }) {
  const [days, setDays] = useState<DayUsage[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api.dailyUsage().then((d) => (Array.isArray(d) ? setDays(d) : setError("Couldn’t load usage."))).catch((e) => setError((e as Error).message)); }, []);
  const maxCost = Math.max(0.01, ...(days ?? []).map((d) => d.costUsd));
  const total = (days ?? []).reduce((sum, d) => sum + d.costUsd, 0);

  return (
    <Modal title="Daily cost" onClose={onClose}>
      <div className="daily-cost">
        {error && <div className="form-error">{error}</div>}
        {!days && !error && <p className="muted">Loading…</p>}
        {days && (
          <>
            <p className="daily-total"><b>{money(total)}</b> <span className="muted">in the last {days.length} days</span></p>
            <ul className="daily-list">
              {days.map((d, i) => d.claudeRuns + d.codexRuns === 0 ? (
                <li key={d.date} className="daily-row quiet">
                  <span className="daily-day">{dayLabel(d.date, i)}</span>
                  <span>No runs</span>
                </li>
              ) : (
                <li key={d.date}>
                  <div className="daily-row">
                    <span className="daily-day">{dayLabel(d.date, i)}</span>
                    <span className="daily-amount">{money(d.costUsd)}</span>
                  </div>
                  <div className="daily-bar" aria-hidden><span style={{ width: `${(d.costUsd / maxCost) * 100}%` }} /></div>
                  <div className="daily-meta muted">{d.claudeRuns} Claude · {d.codexRuns} Codex runs · {duration(d.seconds)}</div>
                </li>
              ))}
            </ul>
            <p className="muted small">Cost covers Claude runs only; Codex doesn’t report a cost.</p>
          </>
        )}
      </div>
    </Modal>
  );
}
