import { useEffect, useState } from "react";
import { api, COLUMNS, type Ticket, type InboxItem } from "./api";
import { BellIcon, ChatIcon, CheckIcon, ClockIcon, ColumnsIcon, FileIcon } from "./icons";
import { timeAgo } from "./time";
import { PRIORITIES, TEMPLATES } from "./ticketTemplates";
import { Modal } from "./Modal";
export type WorkspacePage = "board" | "sessions" | "inbox" | "activity";
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
const PAGES: { id: WorkspacePage; label: string; icon: JSX.Element }[] = [
  { id: "board", label: "Board", icon: <ColumnsIcon size={18} /> },
  { id: "sessions", label: "Sessions", icon: <ChatIcon size={18} /> },
  { id: "inbox", label: "Inbox", icon: <BellIcon size={18} /> },
  { id: "activity", label: "Activity", icon: <ClockIcon size={18} /> },
];

/** Top tabs on desktop, a bottom tab bar on phones (see styles). Badges count what waits on you. */
export function WorkspaceNavigation({ page, onChange, count, sessions }: {
  page: WorkspacePage;
  onChange: (page: WorkspacePage) => void;
  count: number;
  sessions: number;
}) {
  const badge = (id: WorkspacePage) => (id === "inbox" ? count : id === "sessions" ? sessions : 0);
  return (
    <nav className="workspace-nav" aria-label="Workspace">
      {PAGES.map((p) => (
        <button key={p.id} aria-current={page === p.id ? "page" : undefined} onClick={() => onChange(p.id)}>
          {p.icon}
          {p.label}
          {badge(p.id) > 0 && <span className="need-chip" aria-label={`${badge(p.id)} need you`}>{badge(p.id)}</span>}
        </button>
      ))}
    </nav>
  );
}
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
  const options = (
    <>
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
          <option value="">Choose a saved view</option>
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
      <div className="view-toggle" role="group" aria-label="Board layout">
        <button
          aria-pressed={layout === "board"}
          onClick={() => onLayout("board")}
        >
          Kanban
        </button>
        <button
          aria-pressed={layout === "list"}
          onClick={() => onLayout("list")}
        >
          List
        </button>
      </div>
      {compact ? (
        <button
          className="btn small mobile-filter-button"
          onClick={() => setEditing(true)}
        >
          Filters & views
          {Object.values(filter).filter(Boolean).length > 0
            ? " · " + Object.values(filter).filter(Boolean).length
            : ""}
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
        <span className="muted">{tickets.length} tickets</span>
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
                  {COLUMNS.find((c) => c.id === t.status)?.label} ·{" "}
                  {t.priority ?? "normal"}
                  {t.labels?.length ? " · " + t.labels.join(", ") : ""}
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
export function WorkspaceInbox({
  items,
  onPick,
}: {
  items: InboxItem[];
  onPick: (item: InboxItem) => void;
}) {
  return (
    <section className="workspace-scroll" aria-label="Inbox">
      <div className="workspace-heading">
        <h2>Needs your attention</h2>
        <span className="muted">Across all boards</span>
      </div>
      {!items.length ? (
        <div className="workspace-empty">
          <CheckIcon size={28} />
          <h3>You’re all caught up</h3>
          <p>Questions, blocked work, and replies will appear here.</p>
        </div>
      ) : (
        <div className="ticket-list">
          {items.map((i) => (
            <button
              key={i.profile + "/" + i.id}
              className="attention-row"
              onClick={() => onPick(i)}
            >
              <span className="muted small">{i.profileName}</span>
              <strong>{i.title}</strong>
              <span className="attention-reason">{i.attention.label}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
export function WorkspaceActivity({
  slug,
  onOpen,
}: {
  slug: string;
  onOpen: (id: string) => void;
}) {
  const [items, setItems] = useState<
      { id: string; title: string; at: string; changes: string[] }[] | null
    >(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const load = () =>
      api
        .workspaceActivity(slug)
        .then((x) => {
          if (active) {
            setItems(x);
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    load();
    const timer = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [slug]);
  return (
    <section className="workspace-scroll" aria-label="Activity">
      <div className="workspace-heading">
        <h2>Activity</h2>
        <span className="muted">Recent ticket changes</span>
      </div>
      {error && <p role="alert">{error}</p>}
      {!items ? (
        <p className="muted">Loading activity…</p>
      ) : !items.length ? (
        <div className="workspace-empty">
          <ClockIcon size={28} />
          <h3>A fresh timeline</h3>
          <p>
            New tickets and status changes will appear here as work happens.
          </p>
        </div>
      ) : (
        <ol className="activity-timeline">
          {items.map((item, i) => (
            <li key={item.at + item.id + i}>
              <ClockIcon />
              <div>
                <button className="link-btn" onClick={() => onOpen(item.id)}>
                  {item.title}
                </button>
                <p>{item.changes.join(" · ")}</p>
                <time className="muted small" dateTime={item.at}>
                  {timeAgo(item.at)}
                </time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
