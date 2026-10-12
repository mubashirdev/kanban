import { useEffect, useRef, useState } from "react";
import { copy, type Ticket } from "./api";
import { BranchIcon, BugIcon, ChatIcon, CheckIcon, CloseIcon, CopyIcon, MoreIcon, PanelIcon, RefreshIcon, StarIcon, TerminalIcon, TrashIcon } from "./icons";
import { capInputText, parseCap } from "./capText";
import { useLayer } from "./layers";
import { costText } from "./usage";

/**
 * "⋯" menu in the ticket panel header: the session (resume command, branch, ID, linked session),
 * then Report a bug and Delete. On phones it also holds Details and the star, so the title gets the header room.
 * ↑↓ move, Esc closes only the menu.
 */
export function TicketMenu({ ticket, working, live, linkedLabel, boardCap, onCap, onBranch, onPickSession, onUnlink, onCheckPr, onToChats, onReportBug, onDelete, phone }: {
  ticket: Ticket;
  working: boolean;
  /** The session is open in a terminal right now. */
  live: boolean;
  /** Label of the linked Claude session, when there is one. */
  linkedLabel: string | null;
  /** The board's spending cap per run (null: none). */
  boardCap: number | null;
  /** Set this ticket's cap: an amount, 0 for none, null for the board's. */
  onCap: (usd: number | null) => Promise<unknown>;
  /** Branch the ticket (copy of its conversation + committed code); only offered once it has a conversation. */
  onBranch: () => void;
  onPickSession: () => void;
  onUnlink: () => void;
  onCheckPr: () => void;
  /** Turn the ticket into a chat (same conversation); plan tickets stay on the board. */
  onToChats: () => void;
  onReportBug: () => void;
  onDelete: () => void;
  /** Phones: the header's Details and star buttons, shown at the top of the menu instead. */
  phone?: { detailsOpen: boolean; onDetails: () => void; onImportant: (important: boolean) => void };
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const close = (focusButton = true) => {
    clearTimeout(closeTimer.current);
    setOpen(false);
    setCopied(null);
    if (focusButton) button.current?.focus();
  };
  useLayer(() => close(), { active: open });

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus());
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const onKey = (e: React.KeyboardEvent) => {
    const list = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") { e.preventDefault(); go(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(at - 1); }
  };
  // Copy, show "Copied" for a moment, then close.
  const copyItem = async (key: string, text: string) => {
    await copy(text);
    setCopied(key);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => close(), 700);
  };
  const pick = (fn: () => void) => () => { close(false); fn(); };

  const hasSession = !!(ticket.workdir && ticket.sessionId);
  const canLink = ticket.agent !== "codex" && !hasSession && !working && ticket.status !== "done" && ticket.runCount === 0;

  return (
    <div className="ticket-menu-wrap" ref={root}>
      <button ref={button} className={`icon-btn more-btn ${open ? "on" : ""}`} aria-haspopup="menu" aria-expanded={open}
        aria-label={live ? "Session and ticket actions (session open in terminal)" : "Session and ticket actions"}
        title="Session & ticket actions" onClick={() => (open ? close() : setOpen(true))}>
        <MoreIcon size={16} />
        {live && <span className="more-dot" aria-hidden />}
      </button>
      {open && (
        <div className="inbox-menu ticket-menu" role="menu" aria-label="Ticket actions" ref={menu} onKeyDown={onKey}>
          {phone && (
            <>
              <button role="menuitem" className="menu-item" onClick={pick(phone.onDetails)}>
                <span className="menu-icon" aria-hidden><PanelIcon size={14} /></span>
                <span className="menu-label">{phone.detailsOpen ? "Hide details" : "Show details"}</span>
              </button>
              <button role="menuitem" className="menu-item" onClick={pick(() => phone.onImportant(!ticket.important))}>
                <span className="menu-icon" aria-hidden><StarIcon size={14} filled={ticket.important} /></span>
                <span className="menu-label">{ticket.important ? "Unmark important" : "Mark as important"}</span>
                <span className="menu-hint">auto review before landing</span>
              </button>
              <div className="menu-sep" role="separator" />
            </>
          )}
          <div className="menu-heading">
            Session
            {live && <span className="badge ok live-badge"><span className="live-dot" /> open in terminal</span>}
          </div>
          {ticket.resumeCommand && (
            <button role="menuitem" className="term-block" disabled={working}
              title={working ? "Wait until the agent is done" : ticket.resumeCommand}
              onClick={() => copyItem("resume", ticket.resumeCommand!)}>
              <span className="term-bar">
                <span>Resume in your terminal</span>
                <span className="term-copy">{working ? "Wait until the agent is done" : copied === "resume" ? "Copied ✓" : "Click to copy"}</span>
              </span>
              <span className="term-line">{ticket.resumeCommand}</span>
            </button>
          )}
          {ticket.branch && (
            <button role="menuitem" className="menu-item" title={ticket.worktree ?? undefined} onClick={() => copyItem("branch", ticket.branch!)}>
              <span className="menu-icon" aria-hidden>{copied === "branch" ? <CheckIcon size={14} /> : <CopyIcon size={14} />}</span>
              <span className="menu-label">{copied === "branch" ? "Copied ✓" : "Copy branch"}</span>
              <span className="menu-value">{ticket.branch}</span>
            </button>
          )}
          <button role="menuitem" className="menu-item" onClick={() => copyItem("id", ticket.id)}>
            <span className="menu-icon" aria-hidden>{copied === "id" ? <CheckIcon size={14} /> : <CopyIcon size={14} />}</span>
            <span className="menu-label">{copied === "id" ? "Copied ✓" : "Copy ticket ID"}</span>
            <span className="menu-value">{ticket.id}</span>
          </button>
          {ticket.session && (
            <button role="menuitem" className="menu-item" disabled={working}
              title={working ? "Wait until Claude is done" : "New ticket in Planning with a copy of this conversation and its own branch off this one's committed code"}
              onClick={pick(onBranch)}>
              <span className="menu-icon" aria-hidden><BranchIcon size={14} /></span>
              <span className="menu-label">Branch ticket…</span>
              <span className="menu-hint">{working ? "Wait until Claude is done" : "copy chat + code"}</span>
            </button>
          )}
          {hasSession && !working && (
            <>
              <button role="menuitem" className="menu-item" onClick={pick(onPickSession)}>
                <span className="menu-icon" aria-hidden><TerminalIcon size={14} /></span>
                <span className="menu-label">Change linked session…</span>
                {linkedLabel && <span className="menu-value">{linkedLabel}</span>}
              </button>
              <button role="menuitem" className="menu-item" onClick={pick(onUnlink)}>
                <span className="menu-icon" aria-hidden><CloseIcon size={14} /></span>
                <span className="menu-label">Unlink session</span>
              </button>
            </>
          )}
          {canLink && (
            <button role="menuitem" className="menu-item" onClick={pick(onPickSession)}>
              <span className="menu-icon" aria-hidden><TerminalIcon size={14} /></span>
              <span className="menu-label">Link an existing Claude session…</span>
            </button>
          )}
          {ticket.prUrl && ticket.status === "review" && (
            <button role="menuitem" className="menu-item" onClick={pick(onCheckPr)}>
              <span className="menu-icon" aria-hidden><RefreshIcon size={14} /></span>
              <span className="menu-label">Check PR status now</span>
            </button>
          )}
          {!ticket.parentId && !ticket.plan && (
            <button role="menuitem" className="menu-item" disabled={working} title={working ? "Wait until the agent is done" : "Keeps the conversation; the chat starts read-only"}
              onClick={pick(onToChats)}>
              <span className="menu-icon" aria-hidden><ChatIcon size={14} /></span>
              <span className="menu-label">Move to chats</span>
              {working && <span className="menu-hint">Wait until the agent is done</span>}
            </button>
          )}
          <div className="menu-sep" role="separator" />
          <CapRow ticket={ticket} boardCap={boardCap} onCap={onCap} />
          <div className="menu-sep" role="separator" />
          <button role="menuitem" className="menu-item" title="Something wrong with Muba AI on this ticket? File a GitHub issue with its details attached"
            onClick={pick(onReportBug)}>
            <span className="menu-icon" aria-hidden><BugIcon size={14} /></span>
            <span className="menu-label">Report a bug in Muba AI</span>
          </button>
          <button role="menuitem" className="menu-item danger" onClick={pick(onDelete)}>
            <span className="menu-icon" aria-hidden><TrashIcon size={14} /></span>
            <span className="menu-label">Delete ticket…</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** The ticket's spending cap per run: typed, saved with Enter (empty: the board's, 0: none). */
function CapRow({ ticket, boardCap, onCap }: { ticket: Ticket; boardCap: number | null; onCap: (usd: number | null) => Promise<unknown> }) {
  const own = ticket.runCapUsd;
  const [text, setText] = useState(own === 0 ? "none" : capInputText(own));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const value = parseCap(text);
  const save = async () => {
    if (value === undefined || value === (own ?? null)) return;
    setState("saving");
    try {
      await onCap(value);
      setState("saved");
    } catch {
      setState("error");
    }
  };
  const board = boardCap ? `board: ${costText(boardCap)}` : "board: no cap";
  return (
    <label className="menu-item cap-row" title="Each work run of this ticket stops once it has spent this much (API-equivalent $). Empty: the board's cap; none: no cap.">
      <span className="menu-label">Spending cap per run</span>
      <span className="cap-input">
        $<input inputMode="decimal" aria-label="Spending cap per run in $" value={text} placeholder={board}
          aria-invalid={value === undefined}
          onChange={(e) => { setText(e.target.value); setState("idle"); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }} onBlur={save} />
      </span>
      <span className="menu-hint">{value === undefined ? "an amount, or none" : state === "saved" ? "Saved ✓" : state === "error" ? "Not saved" : state === "saving" ? "Saving…" : board}</span>
    </label>
  );
}
