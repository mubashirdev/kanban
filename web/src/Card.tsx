import { useEffect, useState } from "react";
import { safeHref, waitsForSlot, type Status, type Ticket } from "./api";
import { AgentMark } from "./AgentMark";
import { CheckIcon, ClockIcon, PlayIcon } from "./icons";
import { ResourceChip, resourceWait } from "./Needs";
import { elapsed, fullTime, plainPreview, timeAgo, useNow } from "./time";

/** Live running time: ticks every second for the first minute, then every 30s. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now);
  const fresh = now - new Date(since).getTime() < 60_000;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), fresh ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [fresh]);
  return <span className="badge-time" title={`Started ${fullTime(since)}`}> · {elapsed(since, now)}</span>;
}

function workingBadge(label: string, since?: string | null) {
  return <span className="badge running"><span className="spinner" /> {label}{since && <Elapsed since={since} />}</span>;
}

// Shown by the badge already, so the activity line would only repeat it.
const QUIET_ACTIVITY = new Set(["Starting…", "Claude is replying…"]);

export function outcomeBadge(t: Ticket) {
  if (waitsForSlot(t)) return <span className="badge queued" title="Your reply starts when a run slot is free">Queued</span>;
  if (t.status === "in_progress") return workingBadge("Running", t.runStartedAt);
  if (t.running) return workingBadge("Replying", t.runStartedAt);
  if (t.error?.startsWith("corrupt")) return <span className="badge failed">Corrupt file</span>;
  switch (t.outcome) {
    case "blocked": return <span className="badge blocked">Blocked</span>;
    case "needs_input": return <span className="badge blocked">Needs your input</span>;
    case "failed": return <span className="badge failed">Failed</span>;
    case "stopped": return <span className="badge stopped">Stopped</span>;
    case "done": return t.status === "review" ? <span className="badge ok">Ready for review</span> : null;
    default: return null;
  }
}

/** queued: 1-based place in the queue for a free run slot (status `ready`). held: a pending daemon restart holds it. */
const QUICK_ACTIONS: Partial<Record<Status, { label: string; to: Status }>> = {
  backlog: { label: "Run", to: "ready" },
  planning: { label: "Run", to: "ready" },
  review: { label: "Done", to: "done" },
};

export function Card({ ticket, onClick, dragging, queued, held, onQuick }: { ticket: Ticket; onClick?: () => void; dragging?: boolean; queued?: number; held?: boolean; onQuick?: (to: Status) => void }) {
  const working = (ticket.status === "in_progress" && !waitsForSlot(ticket)) || !!ticket.running;
  const quick = QUICK_ACTIONS[ticket.status];
  const att = working ? null : ticket.attention ?? null;
  const waitFor = resourceWait(ticket);
  const badge = att ? null
    : waitFor.length ? <span className="badge wait" title={`Waiting for ${waitFor.join(", ")}: another ticket is using it`}>waiting</span>
    : queued && !working ? (held
      ? <span className="badge queued" title="A daemon restart is pending; queued tickets start right after it">Waits for restart</span>
      : <span className="badge queued" title="Starts when a run slot is free">Queued · #{queued}</span>)
    : outcomeBadge(ticket);
  const showActivity = working && ticket.lastActivity && !QUIET_ACTIVITY.has(ticket.lastActivity);
  const last = ticket.session?.lastMessage;
  const preview = last ? plainPreview(last.text) : "";
  // Run / Done: one tap, as a small round button beside the title.
  const quickButton = quick && onQuick && !working && (!att || att.kind === "review") ? (
    <button type="button" className="kc-act" aria-label={quick.label === "Done" ? "Mark done" : "Run now"} title={quick.label === "Done" ? "Mark done" : "Run now"}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onQuick(quick.to); }}>
      {quick.label === "Done" ? <CheckIcon size={16} strokeWidth={2.2} /> : <PlayIcon size={15} />}
    </button>
  ) : null;
  useNow();
  const lastAt = ticket.session ? ticket.session.lastMessage?.at || ticket.session.updatedAt : null;
  return (
    <article
      className={`card ${dragging ? "dragging" : ""} ${queued && !working ? "is-queued" : ""} ${working ? "is-running" : ""} ${att ? `needs-you att-${att.kind}` : ""}`}
      onClick={onClick}>
      {(ticket.kind && ticket.kind !== "task" || ticket.priority && !["normal","none"].includes(ticket.priority) || ticket.labels?.length) && <div className="card-properties">{ticket.kind && ticket.kind !== "task" && <span className="ticket-label">{ticket.kind}</span>}{ticket.priority && !["normal","none"].includes(ticket.priority) && <span className={`priority-tag priority-${ticket.priority}`}>{ticket.priority}</span>}{ticket.labels?.slice(0,3).map(label=><span key={label} className="ticket-label">{label}</span>)}{(ticket.labels?.length ?? 0)>3 && <span className="muted small">+{ticket.labels!.length-3}</span>}</div>}
      <div className="kc-head">
        <div className="kc-title" title={ticket.title}>{ticket.title}</div>
        {quickButton}
      </div>
      {showActivity ? (
        <div className="kc-preview" title={ticket.lastActivity!}>{ticket.lastActivity}</div>
      ) : preview && (
        <div className="kc-preview" title={last!.text}>{last!.role === "user" ? "You: " : ""}{preview}</div>
      )}
      <div className="kc-foot">
        {att && <span className={`kc-status att-${att.kind}`} title={ticket.error ?? undefined}><span className="kc-dot" aria-hidden />{att.label}</span>}
        {ticket.plan && ticket.plan.state !== "done" && (
          <span className={`badge plan ${ticket.plan.state}`} title="This ticket runs a plan of child tickets">
            Plan {ticket.plan.state === "finishing" ? "final check" : ticket.plan.state}
          </span>
        )}
        {ticket.scheduleId && (
          <span className="badge sched" title="Created by a schedule" aria-label="Scheduled">
            <ClockIcon size={11} strokeWidth={1.8} />
          </span>
        )}
        {ticket.needs?.map((n) => <ResourceChip key={n} name={n} held={!!ticket.resources?.holding} />)}
        {badge}
        {ticket.prUrl && (
          <a className="badge pr" href={safeHref(ticket.prUrl)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            PR #{ticket.prUrl.split("/").pop()}
          </a>
        )}
        {ticket.workdir && (ticket.terminalOpen
          ? <span className="badge running" title="This ticket's Claude session is open in a terminal"><span className="live-dot" /> In terminal</span>
          : <span className="badge stopped" title="Linked to an existing Claude session">session</span>)}
        <span className="kc-end">
          <AgentMark agent={ticket.agent} size="small" />
          {lastAt && !working && <time dateTime={lastAt} title={fullTime(lastAt)}>{timeAgo(lastAt)}</time>}
        </span>
      </div>
    </article>
  );
}
