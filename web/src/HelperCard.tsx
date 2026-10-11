import type { HelperRun } from "./api";
import { CheckIcon, ChevronRightIcon, CloseIcon } from "./icons";
import { ToolGroup } from "./ToolGroup";
import { describeStep } from "./toolSteps";
import { Markdown } from "./Transcript";

const ENDED = { done: "Finished", failed: "Failed", stopped: "Stopped" } as const;

/** A helper agent Claude started: its task and what it is doing now; tap to see its steps and its report.
 *  `live` = the ticket's run is still going; a helper still "running" after the run ended was cut off. */
export function HelperCard({ helper, live }: { helper: HelperRun; live: boolean }) {
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
