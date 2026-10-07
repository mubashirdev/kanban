import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useLayer } from "./layers";
import { Modal } from "./Modal";
import { fullTime, timeAgo, useNow } from "./time";
import { parseCliUsage, pillText, resetText, usageTone, worstTone, type UsageResult } from "./usage";
import { Markdown } from "./Transcript";

const dollars = (n: number) => `$${n.toFixed(2)}`;

/** Header pill with Claude plan usage; loads once on page open, then only on Refresh. */
export function UsagePill({ compact = false, openRequest = 0 }: { compact?: boolean; openRequest?: number }) {
  const [usage, setUsage] = useState<UsageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const now = useNow();

  const load = useCallback(() => {
    setLoading(true);
    api.usage()
      .then(setUsage)
      .catch((e: Error) => setUsage({ error: e.message || "Could not reach the board server", fetchedAt: new Date().toISOString() }))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  useEffect(() => { if (openRequest) setOpen(true); }, [openRequest]);

  useLayer(() => {
    setOpen(false);
    pill.current?.focus();
  }, { active: open && !compact });
  useEffect(() => {
    if (!open || compact) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, compact]);

  const failed = !!usage && "error" in usage;
  const windows = usage && !("error" in usage) ? usage.windows : [];
  const tone = failed || !windows.length ? "ok" : worstTone(windows);
  const label = !usage ? "Usage …" : failed ? "Usage unavailable" : windows.length ? pillText(windows) : "Usage · no data";

  const content = (
    <>
      {usage && "error" in usage && <p className="usage-error">{usage.error}</p>}
      {!usage && <p className="muted small">Loading…</p>}
      {usage && !failed && usage.plan && <p className="usage-plan">Using your {usage.plan}</p>}
      {usage && !failed && !windows.length && <p className="muted small">No usage limits reported for this account.</p>}
      {windows.map((w) => {
        const t = usageTone(w.percent);
        const reset = resetText(w.resetsAt, now);
        return (
          <div key={w.key} className="usage-row">
            <div className="usage-top"><span>{w.label}</span><b>{Math.round(w.percent)}% used</b></div>
            <div className="usage-bar"><i className={t} style={{ width: `${w.percent}%` }} /></div>
            {reset && <div className="usage-sub" title={w.resetsAt ? fullTime(w.resetsAt) : undefined}>{reset}</div>}
          </div>
        );
      })}
      {usage && !failed && usage.extra && (
        <div className="usage-row usage-extra">
          <div className="usage-top">
            <span>Extra usage</span>
            <b>{dollars(usage.extra.usedDollars)}{usage.extra.limitDollars !== null ? ` of ${dollars(usage.extra.limitDollars)}` : ""}</b>
          </div>
          <div className="usage-sub">{usage.extra.limitReached ? "Monthly limit reached" : usage.extra.enabled ? "On: used after the plan limits" : "Off"}</div>
        </div>
      )}
      <div className="usage-foot">
        <span title={usage ? fullTime(usage.fetchedAt) : undefined}>
          {usage ? `Updated ${timeAgo(usage.fetchedAt)}` : ""}
        </span>
        <button className="btn small" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "↻ Refresh"}</button>
      </div>
    </>
  );

  if (compact) return open ? (
    <Modal title="Claude plan usage" onClose={() => setOpen(false)}>
      <div className="usage-content">{content}</div>
    </Modal>
  ) : null;

  return (
    <div className="usage" ref={root}>
      <button ref={pill} className={`pill usage-pill${tone === "ok" ? "" : ` ${tone}`}`} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((v) => !v)} title="Claude plan usage">
        {label}
      </button>
      {open && (
        <div className="usage-pop" role="dialog" aria-label="Claude plan usage">
          <h4>Claude plan usage</h4>
          {content}
        </div>
      )}
    </div>
  );
}

/** Claude Code's /usage reply drawn as bars; null for any other message. */
export function CliUsageCard({ text }: { text: string }) {
  const usage = parseCliUsage(text);
  if (!usage) return null;
  return (
    <div className="usage-card">
      <h4>Claude plan usage</h4>
      {usage.intro && <p className="usage-plan">{usage.intro}</p>}
      {usage.windows.map((w) => (
        <div key={w.label} className="usage-row">
          <div className="usage-top"><span>{w.label}</span><b>{Math.round(w.percent)}% used</b></div>
          <div className="usage-bar"><i className={usageTone(w.percent)} style={{ width: `${w.percent}%` }} /></div>
          {w.resets && <div className="usage-sub">{w.resets}</div>}
        </div>
      ))}
      {usage.rest && (
        <details className="usage-more">
          <summary>{usage.rest.split("\n")[0].replace(/\?$/, "")}</summary>
          <Markdown text={"```\n" + usage.rest.split("\n").slice(1).join("\n").trim() + "\n```"} />
        </details>
      )}
    </div>
  );
}
