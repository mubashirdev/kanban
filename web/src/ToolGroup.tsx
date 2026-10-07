import type { ToolDetail } from "./api";
import { CheckIcon, ChevronRightIcon, CloseIcon, ExternalIcon, FileCodeIcon, FileTextIcon, SearchIcon, SparkIcon, TerminalIcon } from "./icons";
import { describeStep, summarizeSteps, type Step } from "./toolSteps";

const KIND_ICON = { read: FileTextIcon, edit: FileCodeIcon, run: TerminalIcon, search: SearchIcon, web: ExternalIcon, other: SparkIcon } as const;

function StepIcon({ kind }: { kind: Step["kind"] }) {
  const Icon = KIND_ICON[kind];
  return <Icon size={kind === "other" ? 12 : 15} />;
}

const took = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

/** Added lines green, removed red; a Codex patch's file headers stay quiet. */
function Diff({ text }: { text: string }) {
  return (
    <pre className="step-diff">
      {text.split("\n").map((line, i) => (
        <span key={i} className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("*** ") || line.startsWith("@@") ? "hdr" : undefined}>{line}{"\n"}</span>
      ))}
    </pre>
  );
}

function StepResult({ detail }: { detail?: ToolDetail }) {
  if (detail?.ok === undefined) return null;
  return (
    <span className={`step-status ${detail.ok ? "ok" : "fail"}`} title={detail.ok ? "Done" : "Failed"}>
      {detail.ok ? <CheckIcon size={12} /> : <CloseIcon size={12} />}
      {detail.ms !== undefined && <span className="step-time">{took(detail.ms)}</span>}
    </span>
  );
}

/** A run of tool steps folded into one row: what the agent did, at a glance; tap to see each step. */
export function ToolGroup({ texts, details, working }: { texts: string[]; details?: (ToolDetail | undefined)[]; working: boolean }) {
  const steps = texts.map(describeStep);
  return (
    <details className="tool-group">
      <summary>
        <span className="tool-lead">{working ? <span className="spinner" /> : <StepIcon kind={steps.at(-1)!.kind} />}</span>
        <span className="tool-summary">{summarizeSteps(texts)}</span>
        <ChevronRightIcon className="tool-chevron" size={14} />
      </summary>
      <ul>
        {steps.map((step, i) => {
          const detail = details?.[i];
          return (
            <li key={i} className={`tool-step kind-${step.kind}${detail?.ok === false ? " failed" : ""}`}>
              <span className="tool-lead"><StepIcon kind={step.kind} /></span>
              <span className="tool-step-text">
                <span className="step-label">{step.label}</span>
                {step.detail && <code className="step-detail">{step.detail}</code>}
                {detail?.diff && <Diff text={detail.diff} />}
                {detail?.output && (
                  <details className="step-output">
                    <summary>Output</summary>
                    <pre>{detail.output}</pre>
                  </details>
                )}
              </span>
              <StepResult detail={detail} />
            </li>
          );
        })}
      </ul>
    </details>
  );
}
