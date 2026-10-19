import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Profile, type Ticket } from "../../api";
import { autoGrow } from "../../autoGrow";
import { Chat } from "../../Chat";
import { ConfirmDialog } from "../../ConfirmDialog";
import { enterSends } from "../../enterSends";
import { BoardIcon, ChevronLeftIcon, CloseIcon, MoreIcon, TrashIcon } from "../../icons";
import { useLayer } from "../../layers";
import { Modal } from "../../Modal";
import { plainPreview, timeAgo } from "../../time";
import { toast } from "../../toast";
import { useNow } from "../../useNow";
import { usePersistentState } from "../../usePersistentState";
import { AgentMark, AgentSwitch } from "../codex/AgentPicker";
import { agentName, agentOf, type AgentId } from "../codex/api";
import { accessOf, chatsApi, type Access } from "./api";
import { chatList, isUnread, lastAt } from "./chatList";
import { OnThisMac } from "./OnThisMac";

const ACCESS: { id: Access; label: string; hint: string }[] = [
  { id: "read", label: "Read only", hint: "It can look at files and answer, but won't change them." },
  { id: "edit", label: "Can edit", hint: "It works directly in your folder, like in a terminal." },
];
const failed = (e: Error) => toast(e.message, { tone: "error" });

function AccessSwitch({ value, onChange, disabled }: { value: Access; onChange: (a: Access) => void; disabled?: boolean }) {
  return (
    <div className="segmented access-switch" role="radiogroup" aria-label="What it may do">
      {ACCESS.map((a) => (
        <button key={a.id} type="button" role="radio" aria-checked={value === a.id} className={value === a.id ? "on" : ""} disabled={disabled}
          title={a.hint} onClick={() => onChange(a.id)}>{a.label}</button>
      ))}
    </div>
  );
}

function ChatRow({ ticket, onOpen }: { ticket: Ticket; onOpen: () => void }) {
  const last = ticket.session?.lastMessage;
  const unread = isUnread(ticket);
  const state = ticket.running ? "running" : unread ? "unread" : "";
  return (
    <button className={`chat-row ${state}`} onClick={onOpen} aria-label={`${ticket.title}, ${agentName(ticket)}${unread ? ", new reply" : ""}`}>
      <AgentMark agent={agentOf(ticket)} />
      <span className="chat-row-main">
        <span className="chat-row-top">
          <span className="chat-row-title">{ticket.title}</span>
          <time className="chat-row-time" dateTime={lastAt(ticket)}>{timeAgo(lastAt(ticket))}</time>
        </span>
        <span className="chat-row-preview">
          {ticket.running ? <><span className="spinner" /> {ticket.lastActivity ?? `${agentName(ticket)} is working…`}</>
            : ticket.error ? <b>Reply failed</b>
            : last ? <>{last.role === "user" ? "You: " : ""}{plainPreview(last.text)}</>
            : "No messages yet"}
        </span>
      </span>
      {unread && <span className="unread-dot" aria-hidden />}
    </button>
  );
}

type SwipeAction = { label: string; danger?: boolean; run: () => void };
const ACTION_WIDTH = 76;

/** Swipe a chat left for quick actions, like Mail on iPhone; a tap anywhere on the row closes them again. */
function SwipeRow({ actions, children }: { actions: SwipeAction[]; children: ReactNode }) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; base: number; sideways: boolean | null } | null>(null);
  const width = actions.length * ACTION_WIDTH;
  return (
    <div className="swipe-row">
      <div className="swipe-actions" style={{ width }} aria-hidden={offset === 0}>
        {actions.map((a) => (
          <button key={a.label} type="button" tabIndex={offset ? 0 : -1} className={`swipe-action${a.danger ? " danger" : ""}`}
            onClick={() => { setOffset(0); a.run(); }}>{a.label}</button>
        ))}
      </div>
      <div className={`swipe-content${dragging ? " dragging" : ""}`} style={{ transform: `translateX(${-offset}px)` }}
        onTouchStart={(e) => { const t = e.touches[0]; drag.current = { x: t.clientX, y: t.clientY, base: offset, sideways: null }; }}
        onTouchMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const t = e.touches[0];
          const dx = d.x - t.clientX;
          // Decide once per touch: sideways opens the actions, up and down scrolls the list.
          if (d.sideways === null && Math.abs(dx) + Math.abs(t.clientY - d.y) > 8) {
            d.sideways = Math.abs(dx) > Math.abs(t.clientY - d.y);
            setDragging(d.sideways);
          }
          if (d.sideways) setOffset(Math.min(width, Math.max(0, d.base + dx)));
        }}
        onTouchEnd={() => {
          const sideways = drag.current?.sideways;
          drag.current = null;
          setDragging(false);
          if (sideways) setOffset((o) => (o > width / 2 ? width : 0));
        }}
        onClickCapture={(e) => { if (offset > 0) { e.stopPropagation(); setOffset(0); } }}>
        {children}
      </div>
    </div>
  );
}

/** Asks before a chat is deleted; files and the agent's own history stay. */
function DeleteChat({ slug, ticket, onDone, onCancel }: { slug: string; ticket: Ticket; onDone: () => void; onCancel: () => void }) {
  return (
    <ConfirmDialog title={`Delete "${ticket.title}"?`} confirmLabel="Delete chat" busyLabel="Deleting…" onCancel={onCancel}
      onConfirm={async () => { await api.deleteTicket(slug, ticket.id); onDone(); }}>
      <p>Removes it from Chats.{ticket.running ? ` ${agentName(ticket)} will be stopped.` : ""} The conversation stays in {agentName(ticket)}'s own history, and files it changed stay as they are.</p>
    </ConfirmDialog>
  );
}

/**
 * Chats: conversations off the board, as a messenger. Phones show the list (a chat opens full screen); wide screens
 * show the list on the left and the open chat, or a new-chat box, on the right.
 */
export function ChatsView({ profile, tickets, openId, wide, starting, onStarting, onOpen, onClose, onOpenTicket }: {
  profile: Profile; tickets: Ticket[]; openId: string | null; wide: boolean;
  /** The phone's new-chat sheet is open (the + button in the top bar). */
  starting: boolean; onStarting: (on: boolean) => void;
  onOpen: (id: string) => void; onClose: () => void; onOpenTicket: (id: string) => void;
}) {
  useNow();
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<Ticket | null>(null);
  const actionsFor = (t: Ticket): SwipeAction[] => [
    ...(t.running ? [{ label: "Stop", run: () => { api.stop(profile.slug, t.id).catch(failed); } }] : []),
    ...(isUnread(t) ? [{ label: "Read", run: () => { chatsApi.setRead(t.id, true).catch(failed); } }] : []),
    ...(!isUnread(t) && !t.running && t.session?.lastMessage?.role === "assistant" ? [{ label: "Unread", run: () => { chatsApi.setRead(t.id, false).catch(failed); } }] : []),
    { label: "Delete", danger: true, run: () => setDeleting(t) },
  ];
  const chats = chatList(tickets, "");
  const shown = chatList(tickets, query);
  const open = chats.find((t) => t.id === openId) ?? null;
  const started = (id: string) => { onStarting(false); onOpen(id); };
  return (
    <div className={`chats${wide ? " wide" : ""}`}>
      <section className="chat-list" aria-label="Chats">
        <div className="chat-list-head">
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats" />
        </div>
        {shown.length === 0 ? (
          <p className="chat-list-empty">{query.trim() ? "No chats match." : "No chats yet. Start one to ask Claude or Codex anything about this folder."}</p>
        ) : (
          <ul>
            {shown.map((t) => (
              <li key={t.id} className={t.id === openId && wide ? "active" : undefined}>
                <SwipeRow actions={actionsFor(t)}><ChatRow ticket={t} onOpen={() => onOpen(t.id)} /></SwipeRow>
              </li>
            ))}
          </ul>
        )}
        {!query.trim() && <OnThisMac profile={profile} onOpenChat={onOpen} />}
      </section>
      {wide && (
        <div className="chat-pane">
          {open ? <ChatPanel key={open.id} profile={profile} ticket={open} tickets={tickets} onClose={onClose} onOpenTicket={onOpenTicket} embedded />
            : (
              <div className="chat-pane-new">
                <h2>New chat in {profile.name}</h2>
                <ChatStarter key={profile.slug} profile={profile} onStarted={started} />
              </div>
            )}
        </div>
      )}
      {!wide && open && <ChatPanel key={open.id} profile={profile} ticket={open} tickets={tickets} onClose={onClose} onOpenTicket={onOpenTicket} />}
      {!wide && starting && (
        <Modal title={`New chat in ${profile.name}`} onClose={() => onStarting(false)}>
          <div className="form"><ChatStarter key={profile.slug} profile={profile} onStarted={started} /></div>
        </Modal>
      )}
      {deleting && <DeleteChat slug={profile.slug} ticket={deleting} onCancel={() => setDeleting(null)}
        onDone={() => { if (deleting.id === openId) onClose(); setDeleting(null); }} />}
    </div>
  );
}

/** A new chat: who answers, what it may do, and the first message. */
function ChatStarter({ profile, onStarted }: { profile: Profile; onStarted: (id: string) => void }) {
  const [agent, setAgent] = usePersistentState<AgentId>("muba.chat.agent", () => "claude", () => false, (v) => v === "claude" || v === "codex");
  const [access, setAccess] = usePersistentState<Access>("muba.chat.access", () => "read", () => false, (v) => v === "read" || v === "edit");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const name = agent === "codex" ? "Codex" : "Claude";
  useEffect(() => autoGrow(box.current, 6), [text]);

  const start = async () => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    try {
      const t = await chatsApi.start(profile.slug, { text: message, agent, access });
      setText("");
      onStarted(t.id);
    } catch (e: any) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="chat-starter" onSubmit={(e) => { e.preventDefault(); void start(); }}>
      <textarea ref={box} rows={3} autoFocus value={text} disabled={busy} onChange={(e) => setText(e.target.value)} aria-label="First message"
        placeholder={access === "read" ? `Ask ${name} about this folder…` : `Tell ${name} what to do…`}
        onKeyDown={(e) => { if (enterSends(e)) { e.preventDefault(); void start(); } }} />
      <div className="starter-foot">
        <AgentSwitch value={agent} onChange={setAgent} />
        <AccessSwitch value={access} onChange={setAccess} />
        <button type="submit" className="btn primary" disabled={!text.trim() || busy}>{busy ? <span className="spinner" /> : "Start chat"}</button>
      </div>
      <p className="starter-hint">Works in <code>{profile.path}</code>. {ACCESS.find((a) => a.id === access)!.hint}</p>
    </form>
  );
}

/** One chat: full screen on a phone, the right pane on wide screens. Leo's chat with our header. */
function ChatPanel({ profile, ticket, tickets, onClose, onOpenTicket, embedded = false }: {
  profile: Profile; ticket: Ticket; tickets: Ticket[]; onClose: () => void; onOpenTicket: (id: string) => void; embedded?: boolean;
}) {
  const slug = profile.slug;
  const [title, setTitle] = useState(ticket.title);
  const [deleting, setDeleting] = useState(false);
  useLayer(onClose, { active: !embedded && !deleting });
  useEffect(() => setTitle(ticket.title), [ticket.title]);
  // Looking at the chat reads its replies.
  const lastReply = ticket.session?.lastMessage?.role === "assistant" ? ticket.session.lastMessage.at : null;
  useEffect(() => {
    if (isUnread(ticket)) chatsApi.setRead(ticket.id, true).catch(() => {});
  }, [lastReply, ticket.running]);

  const saveTitle = () => {
    const next = title.trim();
    if (!next || next === ticket.title) return setTitle(ticket.title);
    api.updateTicket(slug, ticket.id, { title: next }).catch(failed);
  };
  const toBoard = async () => {
    try {
      await chatsApi.move(ticket.id, "board");
      onClose();
      toast("Moved to the board's Backlog.", { tone: "ok" });
    } catch (e: any) { failed(e); }
  };

  const panel = (
    <aside className={`panel chat-panel${embedded ? " embedded" : ""}`} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label={ticket.title}>
      <header className="panel-head chat-panel-head">
        {!embedded && <button className="icon-btn" onClick={onClose} aria-label="Back to chats"><ChevronLeftIcon size={22} /></button>}
        <AgentMark agent={agentOf(ticket)} />
        <input className="title-input" value={title} aria-label="Chat name" onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); else if (e.key === "Escape") { setTitle(ticket.title); e.currentTarget.blur(); } }} />
        <ChatMenu working={!!ticket.running} onToBoard={toBoard} onDelete={() => setDeleting(true)} />
        {embedded && <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close"><CloseIcon /></button>}
      </header>
      <div className="chat-panel-bar">
        <AccessSwitch value={accessOf(ticket)} onChange={(a) => chatsApi.setAccess(ticket.id, a).catch(failed)} />
        <span className="muted small">{ACCESS.find((a) => a.id === accessOf(ticket))!.hint}</span>
      </div>
      <div className="panel-main chat-panel-main">
        <Chat slug={slug} ticket={ticket} tickets={tickets} onOpenTicket={onOpenTicket} onError={(m) => toast(m, { tone: "error" })} />
      </div>
      {deleting && <DeleteChat slug={slug} ticket={ticket} onCancel={() => setDeleting(false)} onDone={onClose} />}
    </aside>
  );
  if (embedded) return panel;
  return <div className="drawer-wrap chat-wrap">{panel}</div>;
}

function ChatMenu({ working, onToBoard, onDelete }: { working: boolean; onToBoard: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useLayer(() => setOpen(false), { active: open });
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };
  return (
    <div className="ticket-menu-wrap" ref={root}>
      <button className={`icon-btn more-btn ${open ? "on" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label="Chat actions" onClick={() => setOpen((v) => !v)}>
        <MoreIcon size={16} />
      </button>
      {open && (
        <div className="inbox-menu ticket-menu" role="menu" aria-label="Chat actions">
          <button role="menuitem" className="menu-item" disabled={working} onClick={pick(onToBoard)}>
            <span className="menu-icon" aria-hidden><BoardIcon size={14} /></span>
            <span className="menu-label">Move to board</span>
            {working && <span className="menu-hint">Wait until it's done</span>}
          </button>
          <div className="menu-sep" role="separator" />
          <button role="menuitem" className="menu-item danger" onClick={pick(onDelete)}>
            <span className="menu-icon" aria-hidden><TrashIcon size={14} /></span>
            <span className="menu-label">Delete chat…</span>
          </button>
        </div>
      )}
    </div>
  );
}
