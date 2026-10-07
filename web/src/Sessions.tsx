import { useEffect, useMemo, useRef, useState } from "react";
import { api, copy, type ClaudeSession, type Profile, type Ticket } from "./api";
import { autoGrow } from "./autoGrow";
import { rememberFirstMessage } from "./drafts";
import { Chat, withoutAgentNotes } from "./Chat";
import { ConfirmDialog } from "./ConfirmDialog";
import { ForkDialog } from "./ForkDialog";
import { AgentMark } from "./AgentMark";
import { ArrowUpIcon, ChevronLeftIcon, CloseIcon, ColumnsIcon, CopyIcon, HistoryIcon, MoreIcon, SplitIcon, TrashIcon } from "./icons";
import { useLayer } from "./layers";
import { Modal } from "./Modal";
import { ReviewPanel } from "./ReviewPanel";
import { sessionLabel } from "./SessionPicker";
import { timeAgo, useNow } from "./time";
import { toast } from "./toast";
import { usePersistentState } from "./usePersistentState";

type Agent = NonNullable<Ticket["agent"]>;
type Access = NonNullable<Ticket["access"]>;

const AGENTS: { id: Agent; label: string }[] = [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }];
const ACCESS: { id: Access; label: string; hint: string }[] = [
  { id: "read", label: "Read only", hint: "It can look at code and answer, but won't change files." },
  { id: "edit", label: "Can edit", hint: "It works directly in your repo folder, like in a terminal." },
];

export const agentName = (t: Pick<Ticket, "agent">) => (t.agent === "codex" ? "Codex" : "Claude");
/** Claude gets a spark on coral, Codex a prompt on blue, so the two are told apart at a glance. */
const lastAt = (t: Ticket) => t.session?.lastMessage?.at ?? t.createdAt;
/** Markdown marks read as noise in a one-line preview. */
const plainText = (text: string) => withoutAgentNotes(text).replace(/```[\s\S]*?(```|$)/g, " ").replace(/^\s*\|.*$/gm, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, "[image]").replace(/[`*_#>]+/g, "").replace(/\s+/g, " ").trim();
/** A short title from the first message, like a chat app names a new thread. */
const titleFrom = (text: string) => {
  const line = text.trim().split("\n")[0].replace(/^\/\S+\s*/, "").trim() || text.trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
};

function SessionCard({ ticket, onOpen }: { ticket: Ticket; onOpen: () => void }) {
  const last = ticket.session?.lastMessage;
  const att = ticket.attention;
  const state = ticket.running ? "running" : att?.kind === "reply" ? "unread" : att ? "waiting" : null;
  return (
    <button className={`chat-row ${state ?? ""}`} onClick={onOpen}
      aria-label={`${ticket.title}, ${agentName(ticket)}${state === "unread" ? ", new reply" : state === "waiting" ? `, ${att!.label}` : ""}`}>
      <AgentMark agent={ticket.agent} />
      <span className="chat-row-main">
        <span className="chat-row-top">
          <span className="chat-row-title">{ticket.title}</span>
          <time className="chat-row-time" dateTime={lastAt(ticket)}>{timeAgo(lastAt(ticket))}</time>
        </span>
        <span className="chat-row-preview">
          {ticket.running ? <><span className="spinner" /> {ticket.lastActivity ?? `${agentName(ticket)} is working…`}</>
            : att && att.kind !== "reply" ? <b>{att.label}</b>
            : last ? <>{last.role === "user" ? "You: " : ""}{plainText(last.text)}</>
            : "No messages yet"}
        </span>
      </span>
      {state === "unread" && <span className="unread-dot" aria-hidden />}
    </button>
  );
}

/**
 * Chats mode: sessions as a messenger. Phones show the thread list (a thread opens full screen);
 * wide screens show the list on the left and the open chat, or a new-chat box, on the right.
 */
export function ChatsView({ profile, sessions, tickets, openId, wide, onOpen, onClose, onOpenTicket }: {
  profile: Profile; sessions: Ticket[]; tickets: Ticket[]; openId: string | null; wide: boolean;
  onOpen: (id: string) => void; onClose: () => void; onOpenTicket: (id: string) => void;
}) {
  useNow();
  const [query, setQuery] = useState("");
  const [resuming, setResuming] = useState(false);
  const q = query.trim().toLowerCase();
  const threads = sessions
    .filter((t) => !q || `${t.title}\n${t.session?.lastMessage?.text ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => lastAt(b).localeCompare(lastAt(a)));
  const open = wide ? sessions.find((t) => t.id === openId) ?? null : null;
  return (
    <div className={`chats${wide ? " wide" : ""}`}>
      <section className="chat-list" aria-label="Chats">
        <div className="chat-list-head">
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats" />
        </div>
        {threads.length === 0 ? (
          <p className="chat-list-empty">{q ? "No chats match." : "No chats yet. Start one to ask Claude or Codex anything about this repo."}</p>
        ) : (
          <ul>
            {threads.map((t) => (
              <li key={t.id} className={t.id === openId && wide ? "active" : undefined}><SessionCard ticket={t} onOpen={() => onOpen(t.id)} /></li>
            ))}
          </ul>
        )}
        <button className="link-btn small chat-resume" onClick={() => setResuming(true)}><HistoryIcon size={14} /> Resume a session from a terminal</button>
      </section>
      {wide && (
        <div className="chat-pane">
          {open ? (
            <SessionView key={open.id} profile={profile} ticket={open} tickets={tickets} onClose={onClose} onOpenTicket={onOpenTicket} embedded />
          ) : (
            <div className="chat-pane-new">
              <h2>New chat in {profile.name}</h2>
              <SessionStarter key={profile.slug} profile={profile} onStarted={onOpen} />
            </div>
          )}
        </div>
      )}
      {resuming && <ResumeDialog profile={profile} onClose={() => setResuming(false)} onResumed={(id) => { setResuming(false); onOpen(id); }} />}
    </div>
  );
}

/** Start a chat, or pick up one begun in a terminal. */
export function NewSessionDialog({ profile: initial, profiles, onClose, onStarted }: {
  profile: Profile; profiles: Profile[]; onClose: () => void; onStarted: (id: string, slug: string) => void;
}) {
  const [resuming, setResuming] = useState(false);
  // Any repo with a board, so starting a chat elsewhere doesn't mean switching boards first.
  const [slug, setSlug] = useState(initial.slug);
  const profile = profiles.find((p) => p.slug === slug) ?? initial;
  const started = (id: string) => onStarted(id, profile.slug);
  if (resuming) return <ResumeDialog profile={profile} onClose={() => setResuming(false)} onResumed={started} />;
  return (
    <Modal title="New chat" onClose={onClose}>
      <div className="form new-session">
        {profiles.length > 1 && (
          <label className="session-repo">
            <span>Repo</span>
            <select value={slug} onChange={(e) => setSlug(e.target.value)}>
              {profiles.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
            </select>
          </label>
        )}
        <SessionStarter key={profile.slug} profile={profile} onStarted={started} />
        <button type="button" className="btn resume-link" onClick={() => setResuming(true)}><HistoryIcon size={15} /> Resume a session from a terminal</button>
      </div>
    </Modal>
  );
}

export function SessionStarter({ profile, onStarted }: { profile: Profile; onStarted: (id: string) => void }) {
  const [agent, setAgent] = usePersistentState<Agent>("esa.session.agent", () => "claude", () => false, (v) => v === "claude" || v === "codex");
  const [access, setAccess] = usePersistentState<Access>("esa.session.access", () => "read", () => false, (v) => v === "read" || v === "edit");
  const [isolated, setIsolated] = usePersistentState<boolean>("esa.session.isolated", () => false, () => false, (v) => typeof v === "boolean");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  // Only an editing session can change files, so only it needs a separate checkout.
  const worktree = access === "edit" && isolated;
  const name = agent === "codex" ? "Codex" : "Claude";
  useEffect(() => autoGrow(box.current, 6), [text]);

  const start = async () => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    try {
      const t = await api.createTicket(profile.slug, { title: titleFrom(message), body: "", status: "backlog", standalone: true, access, agent, isolated: worktree });
      rememberFirstMessage(t.id, message);
      await api.chat(profile.slug, t.id, message);
      setText("");
      onStarted(t.id);
    } catch (e: any) {
      toast(e.message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="session-starter" onSubmit={(e) => { e.preventDefault(); void start(); }}>
      <label className="sr-only" htmlFor="session-starter-input">First message</label>
      <textarea id="session-starter-input" ref={box} rows={3} autoFocus value={text} disabled={busy} onChange={(e) => setText(e.target.value)}
        placeholder={access === "read" ? `Ask ${name} about this repo…` : `Tell ${name} what to do…`}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); void start(); } }} />
      <div className="starter-foot">
        <div className="segmented" role="radiogroup" aria-label="Agent">
          {AGENTS.map((a) => (
            <button type="button" key={a.id} role="radio" aria-checked={agent === a.id} onClick={() => setAgent(a.id)}>
              <AgentMark agent={a.id} size="small" />{a.label}
            </button>
          ))}
        </div>
        <div className="segmented" role="radiogroup" aria-label="What it may do">
          {ACCESS.map((a) => (
            <button type="button" key={a.id} role="radio" aria-checked={access === a.id} title={a.hint} onClick={() => setAccess(a.id)}>{a.label}</button>
          ))}
        </div>
        {access === "edit" && (
          <div className="segmented" role="radiogroup" aria-label="Where it works">
            <button type="button" role="radio" aria-checked={!isolated} title="Changes land in your repo folder" onClick={() => setIsolated(false)}>Folder</button>
            <button type="button" role="radio" aria-checked={isolated} title="Its own branch in a separate copy" onClick={() => setIsolated(true)}>Worktree</button>
          </div>
        )}
        <button type="submit" className="btn primary send-round" disabled={!text.trim() || busy} aria-label={`Start session with ${name}`}>
          {busy ? <span className="spinner" /> : <ArrowUpIcon size={18} />}<span className="starter-send-label">Start chat</span>
        </button>
      </div>
      <p className="starter-hint">{worktree ? "It works on its own branch in a separate copy, so your folder stays untouched." : ACCESS.find((a) => a.id === access)!.hint}</p>
    </form>
  );
}

/** Pick up a Claude or Codex conversation started elsewhere (terminal, IDE) in this folder. */
function ResumeDialog({ profile, onClose, onResumed }: { profile: Profile; onClose: () => void; onResumed: (id: string) => void }) {
  const [agent, setAgent] = useState<Agent>("claude");
  const [list, setList] = useState<ClaudeSession[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    setList(null); setError("");
    (agent === "codex" ? api.codexSessions(profile.slug) : api.sessions(profile.slug)).then(setList, (e) => setError(e.message));
  }, [agent, profile.slug]);
  const needle = q.trim().toLowerCase();
  const shown = (list ?? []).filter((s) => !needle || `${s.title ?? ""} ${s.firstPrompt ?? ""}`.toLowerCase().includes(needle));

  const resume = async (s: ClaudeSession) => {
    try {
      const t = await api.createTicket(profile.slug, {
        title: sessionLabel(s).slice(0, 80), body: "", status: "backlog", standalone: true, access: "read", agent,
        ...(agent === "codex" ? { codexSessionId: s.id } : { sessionId: s.id }),
      });
      onResumed(t.id);
    } catch (e: any) { setError(e.message); }
  };

  return (
    <Modal title="Resume an earlier session" onClose={onClose} wide>
      <div className="form">
        <div className="segmented" role="radiogroup" aria-label="Agent">
          {AGENTS.map((a) => <button type="button" key={a.id} role="radio" aria-checked={agent === a.id} onClick={() => setAgent(a.id)}>{a.label}</button>)}
        </div>
        <p className="muted small" style={{ margin: 0 }}>{agent === "codex" ? "Codex" : "Claude Code"} conversations started in <code>{profile.path}</code>.</p>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name…" aria-label="Search sessions" />
        <div className="picker-list sessions" role="listbox">
          {error && <div className="picker-empty">{error}</div>}
          {!error && list === null && <div className="picker-empty">Loading…</div>}
          {list !== null && !shown.length && <div className="picker-empty">{list.length ? "No match." : "No earlier sessions in this folder."}</div>}
          {shown.map((s) => (
            <button key={s.id} type="button" className="session-row" disabled={!!s.ticket} onClick={() => resume(s)}
              title={s.ticket ? `Already open as "${s.ticket.title}"` : s.id}>
              <div className="session-main">
                <span className="session-title">{sessionLabel(s)}</span>
                {s.title && s.firstPrompt && <span className="session-sub">{s.firstPrompt}</span>}
              </div>
              <div className="session-meta">
                {s.ticket && <span className="badge stopped">open: {s.ticket.title}</span>}
                <span className="muted small">{timeAgo(s.lastActive)}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** One session, full screen on a phone: the chat, and the changes it made. */
export function SessionView({ profile, ticket, tickets, onClose, onOpenTicket, embedded = false }: {
  profile: Profile; ticket: Ticket; tickets: Ticket[]; onClose: () => void; onOpenTicket: (id: string) => void;
  /** Shown in the right pane of Chats on wide screens instead of as a sliding panel. */
  embedded?: boolean;
}) {
  const slug = profile.slug;
  const [tab, setTab] = useState<"chat" | "changes">("chat");
  const [title, setTitle] = useState(ticket.title);
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [forking, setForking] = useState(false);
  const onError = (message: string) => toast(message, { tone: "error" });
  useLayer(onClose, { active: !embedded && !menu && !confirmDelete && !forking });
  useEffect(() => setTitle(ticket.title), [ticket.title]);

  // Looking at the session marks its latest reply as read.
  const lastReply = ticket.session?.lastMessage?.at;
  useEffect(() => {
    if (ticket.running || !lastReply || (ticket.readAt && ticket.readAt >= lastReply)) return;
    // The reply's own time, from the server's clock: the phone's clock may run behind.
    api.updateTicket(slug, ticket.id, { readAt: lastReply }).catch(() => {});
  }, [lastReply, ticket.running]);

  const saveTitle = () => {
    const next = title.trim();
    if (!next || next === ticket.title) return setTitle(ticket.title);
    api.updateTicket(slug, ticket.id, { title: next }).catch((e) => onError(e.message));
  };
  const setAccess = (access: Access) => {
    if (access !== ticket.access) api.updateTicket(slug, ticket.id, { access }).catch((e) => onError(e.message));
  };
  const toBoard = async () => {
    setMenu(false);
    try {
      await api.updateTicket(slug, ticket.id, { standalone: false });
      toast("Moved to the board's Backlog.", { tone: "ok" });
    } catch (e: any) { onError(e.message); }
  };

  const panel = (
      <aside className={`panel session-panel${embedded ? " embedded" : ""}`} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label={ticket.title}>
        <header className="panel-head session-head">
          <button className="icon-btn back-btn" onClick={onClose} aria-label="Back to chats"><ChevronLeftIcon size={20} /></button>
          <AgentMark agent={ticket.agent} />
          <input className="title-input" value={title} aria-label="Session name" onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); else if (e.key === "Escape") { setTitle(ticket.title); e.currentTarget.blur(); } }} />
          <div className="segmented compact" role="radiogroup" aria-label="What it may do">
            {ACCESS.map((a) => (
              <button type="button" key={a.id} role="radio" aria-checked={(ticket.access ?? "read") === a.id} disabled={!!ticket.running}
                title={ticket.running ? "Stop the agent to change this" : a.hint} onClick={() => setAccess(a.id)}>{a.id === "read" ? "Read" : "Edit"}</button>
            ))}
          </div>
          <div className="session-menu">
            <button className="icon-btn" aria-label="Session actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}><MoreIcon /></button>
            {menu && <SessionMenu ticket={ticket} onClose={() => setMenu(false)} onToBoard={toBoard} onFork={() => { setMenu(false); setForking(true); }} onDelete={() => { setMenu(false); setConfirmDelete(true); }} />}
          </div>
          <button className="icon-btn close-btn" onClick={onClose} aria-label="Close" title="Close (Esc)"><CloseIcon /></button>
        </header>
        <div className="panel-body details-closed">
          <div className="panel-main">
            <nav className="tabs" role="tablist" aria-label="Session">
              <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
                Chat {ticket.running && <span className="dot" />}
              </button>
              <button role="tab" aria-selected={tab === "changes"} className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>Changes</button>
            </nav>
            {tab === "changes"
              ? <div className="panel-scroll"><ReviewPanel slug={slug} ticket={ticket} onError={onError} onOutputs={() => setTab("chat")} /></div>
              : <Chat slug={slug} ticket={ticket} tickets={tickets} onOpenTicket={onOpenTicket} onError={onError} />}
          </div>
        </div>
        {forking && <ForkDialog slug={slug} ticket={ticket} onClose={() => setForking(false)} onForked={onOpenTicket} />}
        {confirmDelete && (
          <ConfirmDialog title={`Delete "${ticket.title}"?`} confirmLabel="Delete session" busyLabel="Deleting…" onCancel={() => setConfirmDelete(false)}
            onConfirm={async () => { await api.deleteTicket(slug, ticket.id); onClose(); }}>
            <p>Removes it from Sessions.{ticket.running ? ` ${agentName(ticket)} will be stopped.` : ""} The conversation stays in {agentName(ticket)}'s own history, and files it changed stay as they are.</p>
          </ConfirmDialog>
        )}
      </aside>
  );
  if (embedded) return panel;
  return <div className="drawer-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>{panel}</div>;
}

function SessionMenu({ ticket, onClose, onToBoard, onFork, onDelete }: { ticket: Ticket; onClose: () => void; onToBoard: () => void; onFork: () => void; onDelete: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useLayer(onClose);
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (e: PointerEvent) => { if (!root.current?.parentElement?.contains(e.target as Node)) onClose(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  return (
    <div className="inbox-menu session-menu-list" role="menu" aria-label="Session actions" ref={root}>
      <button role="menuitem" className="menu-item" onClick={onToBoard}><span className="menu-icon"><ColumnsIcon /></span><span className="menu-label">Move to board</span></button>
      {ticket.agent !== "codex" && (
        <button role="menuitem" className="menu-item" disabled={!!ticket.running} title={ticket.running ? "Stop Claude first" : "Copy this conversation into a new chat"} onClick={onFork}>
          <span className="menu-icon"><SplitIcon /></span><span className="menu-label">Fork chat…</span>
        </button>
      )}
      {ticket.resumeCommand && (
        <button role="menuitem" className="menu-item" onClick={() => { void copy(ticket.resumeCommand!); toast("Terminal command copied.", { tone: "ok" }); onClose(); }}>
          <span className="menu-icon"><CopyIcon /></span><span className="menu-label">Copy terminal command</span>
        </button>
      )}
      <div className="menu-sep" />
      <button role="menuitem" className="menu-item danger" onClick={onDelete}><span className="menu-icon"><TrashIcon /></span><span className="menu-label">Delete session</span></button>
    </div>
  );
}
