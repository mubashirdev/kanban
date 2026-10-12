import { useEffect, useState } from "react";
import type { HelperRun } from "./api";
import { CheckIcon, ChevronRightIcon, CloseIcon } from "./icons";
import { ToolGroup } from "./ToolGroup";
import { duration } from "./time";
import { describeStep } from "./toolSteps";
import { Markdown } from "./Transcript";

const ENDED = { done: "Finished", failed: "Failed", stopped: "Stopped" } as const;

/** Live time since the helper started, in the app's one format ("2m 14s", "1h 5m"). */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="helper-time">{duration(since, now)}</span>;
}

/** A helper agent Claude started: its task, what it is doing now and for how long; tap to see its steps and its report.
 *  `live` = the ticket's run is still going; a helper still "running" after the run ended was cut off. */
export function HelperCard({ helper, since, live }: { helper: HelperRun; since: string; live: boolean }) {
  const status = helper.status === "running" && !live ? "stopped" : helper.status;
  const count = helper.steps.length;
  const last = helper.steps.at(-1);
  const now = status === "running" ? (last ? describeStep(last).label : "Starting…") : ENDED[status];
  return (
    <details className={`helper-card ${status}`}>
      <summary>
        <span className="tool-lead">
          {status === "running" ? <span className="spinner" /> : status === "done" ? <CheckIcon size={14} /> : <CloseIcon size={13} />}
        </span>
        <span className="helper-text">
          <span className="helper-title">
            {helper.description}
            {helper.type && helper.type !== "general-purpose" && <span className="helper-type">{helper.type}</span>}
          </span>
          <span className="helper-now">{now}{count > 0 && ` · ${count} step${count > 1 ? "s" : ""}`}</span>
        </span>
        {status === "running" && since && <Elapsed since={since} />}
        <ChevronRightIcon className="tool-chevron" size={14} />
      </summary>
      <div className="helper-body">
        {count > 0 && <ToolGroup texts={helper.steps} />}
        {helper.result ? <Markdown text={helper.result} />
          : <p className="muted small">{status === "running" ? "Its report shows here when it finishes." : "No report."}</p>}
      </div>
    </details>
  );
}
