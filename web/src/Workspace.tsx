import { useEffect, useState } from "react";
import { api, COLUMNS, type Ticket } from "./api";
import { CheckIcon, ClockIcon, SlidersIcon } from "./icons";
import { timeAgo } from "./time";
import { PRIORITIES, TEMPLATES } from "./ticketTemplates";
import { Modal } from "./Modal";

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export type WorkspaceFilter = { priority: string; kind: string; label: string };
export const EMPTY_FILTER: WorkspaceFilter = {
  priority: "",
  kind: "",
  label: "",
};
type SavedView = {
  flags?: string[];
  id: string;
  name: string;
  filter: WorkspaceFilter;
  query: string;
  layout: "board" | "list";
};
export function WorkspaceControls({
  slug,
  tickets,
  filter,
  onFilter,
  layout,
  onLayout,
  query,
  onQuery,
  flags,
  onFlags,
  flagOptions = [],
}: {
  slug: string;
  tickets: Ticket[];
  filter: WorkspaceFilter;
  onFilter: (filter: WorkspaceFilter) => void;
  layout: "board" | "list";
  onLayout: (v: "board" | "list") => void;
  query: string;
  onQuery: (q: string) => void;
  flags: string[];
  onFlags: (flags: string[]) => void;
  /** Quick filters (Needs you, Running, Has PR): chips on wide screens, inside this sheet on phones. */
  flagOptions?: { id: string; label: string; count: number }[];
}) {
  const compact = true,
    key = "esa.views." + slug;
  const [views, setViews] = useState<SavedView[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(v)
        ? v
            .filter(
              (x) =>
                x &&
                typeof x.id === "string" &&
                typeof x.name === "string" &&
                typeof x.query === "string" &&
                x.filter &&
                ["priority", "kind", "label"].every(
                  (k) => typeof x.filter[k] === "string"
                ) &&
                ["board", "list"].includes(x.layout) &&
                (!x.flags ||
                  (Array.isArray(x.flags) &&
                    x.flags.every((f: unknown) =>
                      ["you", "running", "pr"].includes(f as string)
                    )))
            )
            .slice(0, 20)
        : [];
    } catch {
      return [];
    }
  });
  const [editing, setEditing] = useState(false),
    [saving, setSaving] = useState(false),
    [name, setName] = useState(""),
    [selected, setSelected] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    const v = views.find((v) => v.id === selected);
    if (
      v &&
      (v.query !== query ||
        v.layout !== layout ||
        JSON.stringify(v.filter) !== JSON.stringify(filter) ||
        JSON.stringify(v.flags ?? []) !== JSON.stringify(flags))
    )
      setSelected("");
  }, [filter, query, layout, flags.join(",")]);
  const labels = [...new Set(tickets.flatMap((t) => t.labels ?? []))].sort();
  const activeCount = Object.values(filter).filter(Boolean).length + flags.length;
  const persist = (next: SavedView[]) => {
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setViews(next);
      setError("");
      return true;
    } catch {
      setError(
        "This browser could not save your view. Check that local storage is allowed."
      );
      return false;
    }
  };
  const toggleFlag = (id: string) => onFlags(flags.includes(id) ? flags.filter((f) => f !== id) : [...flags, id]);
  const layoutToggle = (
    <div className="view-toggle" role="group" aria-label="Board layout">
      <button aria-pressed={layout === "board"} onClick={() => onLayout("board")}>Kanban</button>
      <button aria-pressed={layout === "list"} onClick={() => onLayout("list")}>List</button>
    </div>
  );
  const options = (
    <>
      {flagOptions.length > 0 && (
        <div className="sheet-chips" role="group" aria-label="Show only">
          {flagOptions.map((f) => (
            <button key={f.id} type="button" className={`chip${flags.includes(f.id) ? " on" : ""}`} aria-pressed={flags.includes(f.id)} onClick={() => toggleFlag(f.id)}>
              {f.label}{f.count > 0 && <span className="chip-count">{f.count}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="sheet-layout"><span>Layout</span>{layoutToggle}</div>
      <label className="control-select">
        <span className={compact ? "" : "sr-only"}>Priority</span>
        <select
          aria-label="Priority filter"
          value={filter.priority}
          onChange={(e) => onFilter({ ...filter, priority: e.target.value })}
        >
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p[0].toUpperCase() + p.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <label className="control-select">
        <span className={compact ? "" : "sr-only"}>Type</span>
        <select
          aria-label="Type filter"
          value={filter.kind}
          onChange={(e) => onFilter({ ...filter, kind: e.target.value })}
        >
          <option value="">All types</option>
          {TEMPLATES.map((t) => (
            <option key={t.kind} value={t.kind}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {labels.length > 0 && (
        <label className="control-select">
          <span className={compact ? "" : "sr-only"}>Label</span>
          <select
            aria-label="Label filter"
            value={filter.label}
            onChange={(e) => onFilter({ ...filter, label: e.target.value })}
          >
            <option value="">All labels</option>
            {labels.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
      )}
      <label className="control-select">
        <span className={compact ? "" : "sr-only"}>Saved views</span>
        <select
          aria-label="Saved views"
          value={selected}
          onChange={(e) => {
            const v = views.find((v) => v.id === e.target.value);
            setSelected(e.target.value);
            if (v) {
              onFilter(v.filter);
              onQuery(v.query);
              onLayout(v.layout);
              onFlags(v.flags ?? []);
            }
          }}
        >
          <option value="">None</option>
          {views.map((v) => (
            <option value={v.id} key={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className="btn small"
        disabled={views.length >= 20}
        onClick={() => {
          setEditing(false);
          setSaving(true);
        }}
      >
        Save current view
      </button>
      {selected && (
        <button
          className="link-btn small"
          onClick={() => {
            if (persist(views.filter((v) => v.id !== selected)))
              setSelected("");
          }}
        >
          Remove view
        </button>
      )}
    </>
  );
  return (
    <div className="workspace-controls">
      <span className="wide-only">{layoutToggle}</span>
      {compact ? (
        <button
          className="btn small mobile-filter-button"
          aria-label={`Filters${activeCount ? `, ${activeCount} on` : ""}`}
          title="Filters, layout and saved views"
          onClick={() => setEditing(true)}
        >
          <SlidersIcon size={16} />
          <span className="filter-label">Filters</span>
          {activeCount > 0 && <span className="chip-count">{activeCount}</span>}
        </button>
      ) : (
        options
      )}
      {error && !editing && !saving && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {compact && editing && (
        <Modal title="Filters & views" onClose={() => setEditing(false)}>
          <div className="form workspace-filter-form">
            {options}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button
                className="btn ghost"
                onClick={() => {
                  onFilter(EMPTY_FILTER);
                  onQuery("");
                  onFlags([]);
                  setSelected("");
                }}
              >
                Reset filters
              </button>
              <button className="btn primary" onClick={() => setEditing(false)}>
                Done
              </button>
            </div>
          </div>
        </Modal>
      )}
      {saving && (
        <Modal title="Save this view" onClose={() => setSaving(false)}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              const id = crypto.randomUUID();
              if (
                !persist([
                  ...views,
                  { id, name: name.trim(), filter, query, layout, flags },
                ])
              )
                return;
              setSelected(id);
              setSaving(false);
              setName("");
            }}
          >
            <label>
              View name
              <input
                autoFocus
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                placeholder="Urgent frontend bugs"
              />
            </label>
            <p className="muted">
              Saves this board’s search, filters, and layout on this device.
            </p>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <button className="btn primary" disabled={!name.trim()}>
              Save view
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
export function TicketList({
  tickets,
  onOpen,
  title = "Tickets",
}: {
  tickets: Ticket[];
  onOpen: (id: string) => void;
  title?: string;
}) {
  const sorted = [...tickets].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );
  return (
    <section className="workspace-scroll" aria-label={title}>
      <div className="workspace-heading">
        <h2>{title}</h2>
        <span className="muted">{tickets.length} {tickets.length === 1 ? "ticket" : "tickets"}</span>
      </div>
      {sorted.length === 0 ? (
        <div className="workspace-empty">
          <CheckIcon size={28} />
          <h3>No tickets here</h3>
          <p>Tickets matching this view will appear here.</p>
        </div>
      ) : (
        <div className="ticket-list">
          {sorted.map((t) => (
            <div key={t.id} className="ticket-list-row">
              <button
                className="ticket-list-open"
                onClick={() => onOpen(t.id)}
                aria-label={`Open ${t.title}`}
              >
                <span>{t.title}</span>
                <span className="muted small">
                  {[COLUMNS.find((c) => c.id === t.status)?.label, t.priority && t.priority !== "normal" && t.priority !== "none" ? `${capital(t.priority)} priority` : null, ...(t.labels ?? [])].filter(Boolean).join(", ")}
                </span>
              </button>
              <span className="muted small">{timeAgo(t.updatedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
const STATUS_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label]));
const OUTCOME_LABEL: Record<string, string> = { done: "Finished", failed: "Run failed", blocked: "Blocked", stopped: "Stopped", needs_input: "Waiting for answers" };

/** The server logs changes as "key: value"; show them as plain sentences. */
function describeChange(change: string): string {
  const [key, ...rest] = change.split(": ");
  const value = rest.join(": ");
  if (key === "Created ticket") return "Created";
  if (key === "status") return `Moved to ${STATUS_LABEL[value] ?? value}`;
  if (key === "outcome") return value === "none" ? "Outcome cleared" : OUTCOME_LABEL[value] ?? capital(value);
  if (key === "agent") return `Agent: ${value === "codex" ? "Codex" : "Claude"}`;
  if (key === "labels") return value ? `Labels: ${value}` : "Labels cleared";
  return `${capital(key)}: ${capital(value)}`;
}

/** Recent changes on this board, newest first. Boards older than the log fall back to each ticket's latest state. */
export function WorkspaceActivity({ slug, tickets, onOpen }: { slug: string; tickets: Ticket[]; onOpen: (id: string) => void }) {
  const [items, setItems] = useState<{ id: string; title: string; at: string; changes: string[] }[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const load = () => api.workspaceActivity(slug).then(
      (x) => { if (active) { setItems(x); setError(""); } },
      (e) => { if (active) setError(e.message); });
    load();
    const timer = setInterval(load, 15000);
    return () => { active = false; clearInterval(timer); };
  }, [slug]);
  const fallback = [...tickets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30).map((t) => ({
    id: t.id, title: t.title, at: t.updatedAt,
    changes: [t.standalone ? "Session" : STATUS_LABEL[t.status] ?? t.status, ...(t.outcome ? [OUTCOME_LABEL[t.outcome] ?? t.outcome] : [])],
  }));
  const shown = items?.length ? items.map((item) => ({ ...item, changes: item.changes.map(describeChange) })) : fallback;
  if (error && !items) return <p role="alert" className="form-error">{error}</p>;
  if (!items) return <p className="muted" role="status">Loading activity…</p>;
  if (!shown.length) return <p className="muted">Nothing has happened on this board yet. New tickets and moves show up here.</p>;
  return (
    <ol className="activity-timeline">
      {shown.map((item, i) => (
        <li key={item.at + item.id + i}>
          <ClockIcon />
          <div>
            <button className="link-btn" onClick={() => onOpen(item.id)}>{item.title}</button>
            <p>{item.changes.join(", ")} <time className="muted" dateTime={item.at}>· {timeAgo(item.at)}</time></p>
          </div>
        </li>
      ))}
    </ol>
  );
}
