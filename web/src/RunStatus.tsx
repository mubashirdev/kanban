import { useState } from "react";
import { api, NUDGE_TEXT, type StatusRow } from "./api";
import { timeAgo, waitedFor } from "./time";
import { useNow } from "./useNow";

const keyOf = (r: StatusRow) => `${r.profile}/${r.huddleId ?? r.id}`;
const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * The Inbox's Status section: one line per running ticket, chat and huddle on any board (stuck ones first). A tap
 * opens its last steps with Open, Stop and Nudge; Nudge asks the run for a 2-line status and shows the answer here.
 */
export function RunStatus({ rows, onOpen, menu = false }: {
  rows: StatusRow[];
  onOpen: (r: StatusRow) => void;
  /** Inside the desktop menu: buttons join its arrow-key order. */
  menu?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  // Nudges sent from here: the nudge time the row had before, so the answer shows once a newer one arrives.
  const [asked, setAsked] = useState<Record<string, string | null>>({});
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();
  if (!rows.length) return null;
  const role = menu ? "menuitem" : undefined;

  const nudge = async (r: StatusRow) => {
    setError(null);
    setAsked((a) => ({ ...a, [keyOf(r)]: r.nudge?.at ?? null }));
    try {
      if (r.huddleId) await api.postHuddle(r.profile, r.huddleId, `@main ${NUDGE_TEXT}`);
      else await api.nudge(r.profile, r.id);
    } catch (e) {
      setAsked(({ [keyOf(r)]: _, ...a }) => a);
      setError((e as Error).message);
    }
  };
  const stop = async (r: StatusRow) => {
    if (confirmStop !== keyOf(r)) {
      setConfirmStop(keyOf(r));
      return;
    }
    setConfirmStop(null);
    setError(null);
    try {
      if (r.huddleId) await api.huddleAction(r.profile, r.huddleId, "stop");
      else await api.stop(r.profile, r.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="run-status" aria-label="Running now">
      <div className="inbox-board">Running now · {rows.length}</div>
      {rows.map((r) => {
        const key = keyOf(r);
        const expanded = open === key;
        const waiting = key in asked && (!r.nudge || r.nudge.at === asked[key] || !r.nudge.answer);
        return (
          <div key={key} className={`run-row${expanded ? " open" : ""}`}>
            <button type="button" role={role} className="run-line" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : key)}
              title={`${r.title} · ${r.profileName} · ${r.agent}`}>
              <span className={`run-dot${r.stalledMinutes !== null ? " stuck" : ""}`} aria-hidden />
              <span className="run-title">{r.title}</span>
              <span className={`run-step${r.stalledMinutes !== null ? " stuck" : ""}`}>
                <span className="run-board">{r.profileName} · </span>
                {r.stalledMinutes !== null ? `Stuck ${r.stalledMinutes}m · ` : ""}{r.step}
              </span>
              <span className="run-meta">{r.startedAt ? `${waitedFor(r.startedAt, now)} · ` : ""}{money(r.costUsd)}</span>
            </button>
            {expanded && (
              <div className="run-detail">
                <div className="run-sub muted">
                  {r.profileName} · {r.agent}{r.kind === "chat" ? " · chat" : ""}
                  {r.stalledMinutes !== null && <span className="run-stuck"> · no output for {r.stalledMinutes} min</span>}
                </div>
                {r.steps.length > 0 && (
                  <ol className="run-steps">
                    {r.steps.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                )}
                {waiting ? (
                  <p className="run-answer muted">Asked. The answer shows here when it arrives.</p>
                ) : r.nudge?.answer ? (
                  <p className="run-answer"><span className="muted">Status {timeAgo(r.nudge.at)}: </span>{r.nudge.answer}</p>
                ) : null}
                {error && <p className="run-answer run-error">{error}</p>}
                <div className="run-actions">
                  <button type="button" role={role} className="btn small primary" onClick={() => onOpen(r)}>Open</button>
                  <button type="button" role={role} className={`btn small${confirmStop === key ? " danger" : ""}`} onClick={() => void stop(r)}
                    onBlur={() => setConfirmStop(null)}>
                    {confirmStop === key ? "Tap again to stop" : "Stop"}
                  </button>
                  {/* Codex reads new messages only after its run ends, so a Nudge would wait the whole run. */}
                  {r.agent !== "Codex" && (
                    <button type="button" role={role} className="btn small" disabled={waiting} onClick={() => void nudge(r)}
                      title={`Asks: "${NUDGE_TEXT}"`}>
                      Nudge
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
