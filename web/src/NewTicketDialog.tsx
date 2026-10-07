import { PRIORITIES, TEMPLATES } from "./ticketTemplates";
import { useState } from "react";
import type { ClaudeSession, Status, TicketMode, Ticket } from "./api";
import { useImagePaste } from "./imagePaste";
import { Modal } from "./Modal";
import { SessionPicker, sessionLabel } from "./SessionPicker";

export function NewTicketDialog({
  slug,
  folder,
  onClose,
  onCreate,
}: {
  slug: string;
  folder: string;
  onClose: () => void;
  onCreate: (input: {
    title: string;
    body: string;
    status: Status;
    sessionId?: string;
    mode?: TicketMode;
    agent?: Ticket["agent"];
    priority?: Ticket["priority"];
    kind?: Ticket["kind"];
    labels?: string[];
  }) => Promise<void>;
}) {
  const [mode, setMode] = useState<TicketMode>("interview");
  const [session, setSession] = useState<ClaudeSession | null>(null),
    [picking, setPicking] = useState(false);
  const [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [labels, setLabels] = useState("");
  const [agent, setAgent] = useState<"claude" | "codex">("claude"),
    [kind, setKind] = useState<NonNullable<Ticket["kind"]>>("task"),
    [priority, setPriority] =
      useState<NonNullable<Ticket["priority"]>>("normal");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const images = useImagePaste(setBody),
    template = TEMPLATES.find((t) => t.kind === kind)!;
  const startStatus: Status = mode === "interview" ? "planning" : "ready";
  const submit = async (status: Status) => {
    if (busy || !title.trim() || images.uploading) return;
    setBusy(true);
    setError("");
    try {
      await onCreate({
        title: title.trim(),
        body,
        status,
        mode,
        agent,
        kind,
        priority,
        labels: labels
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        sessionId: session?.id,
      });
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      footer={
        <div className="form-actions ticket-create-actions">
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !title.trim() || images.uploading}
            onClick={() => submit("backlog")}
          >
            Save to backlog
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !title.trim() || images.uploading}
            onClick={() => submit(startStatus)}
          >
            {busy
              ? "Creating…"
              : images.uploading
              ? "Uploading…"
              : mode === "interview"
              ? "Start planning"
              : "Start work"}
          </button>
        </div>
      }
      title="New ticket"
      onClose={onClose}
      guard={!busy && (!!title.trim() || !!body.trim())}
    >
      <form
        className="form new-ticket-form"
        onSubmit={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit(startStatus);
          }
        }}
      >
        <label>
          Title
          <input
            autoFocus
            value={title}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={
              kind === "bug" ? "What is broken?" : "What needs to happen?"
            }
          />
        </label>
        <label>
          Description
          <textarea
            rows={5}
            value={body}
            disabled={busy}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Context, expected result, and acceptance criteria…"
            className={images.dragOver ? "drop-target" : undefined}
            {...images.handlers}
          />
          <span className="muted small">
            {template.hint} · Markdown and pasted images supported
          </span>
        </label>
        <div className="ticket-form-grid">
          <label>
            Ticket type
            <select
              value={kind}
              disabled={busy}
              onChange={(e) => {
                const next = TEMPLATES.find((t) => t.kind === e.target.value)!;
                if (!body.trim() || body === template.body) setBody(next.body);
                setKind(next.kind);
              }}
            >
              {TEMPLATES.map((t) => (
                <option key={t.kind} value={t.kind}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select
              value={priority}
              disabled={busy}
              onChange={(e) => setPriority(e.target.value as typeof priority)}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p[0].toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {images.error && (
          <p className="form-error" role="alert">
            {images.error}
          </p>
        )}
        <fieldset className="ticket-workflow" disabled={busy}>
          <legend>How to start</legend>
          <div
            className="workflow-choices"
            role="radiogroup"
            aria-label="Starting workflow"
          >
            <button
              type="button"
              role="radio"
              aria-checked={mode === "interview"}
              className={mode === "interview" ? "selected" : ""}
              onClick={() => setMode("interview")}
            >
              <strong>Plan first</strong>
              <span>
                {kind === "bug"
                  ? "Investigate the cause and plan the fix"
                  : "Clarify requirements and propose an approach"}
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "auto"}
              className={mode === "auto" ? "selected" : ""}
              onClick={() => setMode("auto")}
            >
              <strong>Start implementation</strong>
              <span>
                {kind === "bug"
                  ? "Reproduce, fix, and verify the bug"
                  : "Work autonomously and report the result"}
              </span>
            </button>
          </div>
          <p className="muted small">
            {mode === "interview"
              ? "Planning is read-only. Review the approach, then choose Start work when ready."
              : "Starts when an agent slot is available. Your agent may change project files."}
          </p>
          <label>
            Agent
            <select
              value={agent}
              disabled={busy || !!session}
              onChange={(e) => setAgent(e.target.value as typeof agent)}
            >
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </label>
        </fieldset>
        <details className="ticket-extra">
          <summary>Labels & existing session</summary>
          <label>
            Labels
            <input
              value={labels}
              disabled={busy}
              maxLength={330}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="frontend, authentication"
            />
          </label>
          {session ? (
            <div className="session-chip">
              <span>{sessionLabel(session)}</span>
              <button
                type="button"
                className="link-btn"
                onClick={() => setSession(null)}
              >
                Remove
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="link-btn"
              disabled={busy}
              onClick={() => {
                setAgent("claude");
                setPicking(true);
              }}
            >
              Link an existing Claude session…
            </button>
          )}
        </details>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
      {picking && (
        <SessionPicker
          slug={slug}
          folder={folder}
          onClose={() => setPicking(false)}
          onPick={(s) => {
            setSession(s);
            setAgent("claude");
            if (!title.trim())
              setTitle(s.title ?? s.firstPrompt?.slice(0, 80) ?? "");
            setPicking(false);
          }}
        />
      )}
    </Modal>
  );
}
