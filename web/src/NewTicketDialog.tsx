import { PRIORITIES, TEMPLATES } from "./ticketTemplates";
import { useEffect, useRef, useState } from "react";
import { api, type ClaudeSession, type Status, type TicketMode, type Ticket, type TicketTemplate } from "./api";
import { useCursorAvailable } from "./AgentMark";
import { DescriptionEditor } from "./DescriptionEditor";
import { useImagePaste } from "./imagePaste";
import { Modal } from "./Modal";
import { SessionPicker, sessionLabel } from "./SessionPicker";
import { StarToggle } from "./StarToggle";

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
    important?: boolean;
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
  const [important, setImportant] = useState(false);
  const [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [labels, setLabels] = useState("");
  const [agent, setAgent] = useState<NonNullable<Ticket["agent"]>>("claude"),
    [kind, setKind] = useState<NonNullable<Ticket["kind"]>>("task"),
    [priority, setPriority] =
      useState<NonNullable<Ticket["priority"]>>("normal");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const cursorAvailable = useCursorAvailable();
  const images = useImagePaste(setBody),
    template = TEMPLATES.find((t) => t.kind === kind)!;
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [saved, setSaved] = useState<TicketTemplate[]>([]),
    [editingSaved, setEditingSaved] = useState(false),
    [saving, setSaving] = useState<{ name: string; scope: string } | null>(null);
  useEffect(() => { api.templates(slug).then(setSaved).catch(() => {}); }, [slug]);
  const applyTemplate = (t: TicketTemplate) => {
    setTitle(t.title);
    setBody(t.body);
    setKind(t.kind);
    setPriority(t.priority);
  };
  const removeTemplate = async (t: TicketTemplate) => {
    try {
      await api.deleteTemplate(t.id);
      setSaved((list) => list.filter((x) => x.id !== t.id));
    } catch (e: any) {
      setError(e.message);
    }
  };
  const saveTemplate = async () => {
    if (!saving) return;
    setError("");
    try {
      const t = await api.createTemplate({ name: saving.name, scope: saving.scope, title: title.trim(), body, kind, priority });
      setSaved((list) => [...list, t].sort((a, b) => a.name.localeCompare(b.name)));
      setSaving(null);
    } catch (e: any) {
      setError(e.message);
    }
  };
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
        ...(important ? { important } : {}),
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
        {saved.length > 0 && (
          <div className="saved-templates" role="group" aria-label="Your templates">
            <span className="muted small">Start from</span>
            {saved.map((t) => (
              <button key={t.id} type="button" className={`chip${editingSaved ? " removing" : ""}`} disabled={busy}
                title={editingSaved ? `Delete "${t.name}"` : t.scope === "global" ? "On all boards" : "On this board"}
                aria-label={editingSaved ? `Delete template ${t.name}` : `Use template ${t.name}`}
                onClick={() => (editingSaved ? removeTemplate(t) : applyTemplate(t))}>
                {t.name}{editingSaved && " ×"}
              </button>
            ))}
            <button type="button" className="link-btn small" onClick={() => setEditingSaved((v) => !v)}>{editingSaved ? "Done" : "Edit"}</button>
          </div>
        )}
        <div className="field">
          <label htmlFor="new-ticket-title">Title</label>
          <div className="title-row">
            <input
              id="new-ticket-title"
              autoFocus
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                kind === "bug" ? "What is broken?" : "What needs to happen?"
              }
            />
            <StarToggle on={important} onChange={setImportant} />
          </div>
        </div>
        <label>
          Description
          <DescriptionEditor
            slug={slug}
            value={body}
            setValue={setBody}
            images={images}
            inputRef={bodyRef}
            dictate
            rows={5}
            placeholder="Context, expected result, and acceptance criteria…"
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
        {saving ? (
          <div className="save-template">
            <label>
              Template name
              <input autoFocus value={saving.name} maxLength={60} placeholder="QA ticket"
                onChange={(e) => setSaving({ ...saving, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveTemplate(); } }} />
            </label>
            <label>
              Show it on
              <select value={saving.scope} onChange={(e) => setSaving({ ...saving, scope: e.target.value })}>
                <option value={slug}>This board</option>
                <option value="global">All boards</option>
              </select>
            </label>
            <div className="save-template-actions">
              <button type="button" className="btn ghost small" onClick={() => setSaving(null)}>Cancel</button>
              <button type="button" className="btn small" disabled={!saving.name.trim()} onClick={saveTemplate}>Save template</button>
            </div>
          </div>
        ) : (
          <button type="button" className="link-btn small save-template-open" disabled={busy || (!title.trim() && !body.trim())}
            title="Keep this title, description, type and priority to start from next time"
            onClick={() => setSaving({ name: title.trim().slice(0, 60), scope: slug })}>
            Save as template
          </button>
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
              {cursorAvailable && <option value="cursor">Cursor</option>}
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
