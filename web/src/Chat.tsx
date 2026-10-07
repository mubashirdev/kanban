import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, subscribe, type ClaudeCommand, type DefaultModels, type Effort, type NewTicketDraft, type SessionEntry, type Ticket } from "./api";
import { autoGrow } from "./autoGrow";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon, FileCodeIcon, ImageIcon, MicIcon, PlusIcon, SlashIcon, SlidersIcon } from "./icons";
import { useImagePaste } from "./imagePaste";
import { NewTicketsCard } from "./NewTicketsCard";
import { ProposalCard } from "./ProposalCard";
import { QuestionsForm } from "./QuestionsForm";
import { draftKey, formKey, takeFirstMessage } from "./drafts";
import { fullTime, timeAgo, useNow } from "./time";
import { toast } from "./toast";
import { Markdown } from "./Transcript";
import { usePersistentState } from "./usePersistentState";
import { useSlashCommands } from "./SlashCommands";
import { useFileMentions } from "./FileMentions";
import { useDictation, dictationSupported } from "./useDictation";
import { useMediaQuery } from "./useMediaQuery";
import { useLayer } from "./layers";
import { AgentSettings } from "./AgentSettings";
import { chipLabel, QuickPick } from "./QuickPick";
import { describeStep, summarizeSteps } from "./toolSteps";
import { CliUsageCard, UsagePill } from "./UsagePill";
import { parseCliUsage } from "./usage";
import { ClaudeSettings, type SettingKind } from "./ClaudeSettings";
import { CommandOptions } from "./CommandOptions";
import { prepareCommand } from "./commandSyntax";

type Block = { kind: "entry"; e: SessionEntry; index: number } | { kind: "tools"; items: SessionEntry[] };

function group(entries: SessionEntry[]): Block[] {
  const out: Block[] = [];
  entries.forEach((e, index) => {
    const prev = out.at(-1);
    if (e.kind === "tool") {
      if (prev?.kind === "tools") prev.items.push(e);
      else out.push({ kind: "tools", items: [e] });
    } else out.push({ kind: "entry", e, index });
  });
  return out;
}

/** What to show of a half-written reply: hide board blocks (questions/proposal JSON) and the result line. */
function liveView(text: string): { text: string; preparing: string | null } {
  const cut = text.indexOf("<ckanban-");
  const visible = (cut >= 0 ? text.slice(0, cut) : text).replace(/^CKANBAN_RESULT.*$/gm, "").trim();
  if (cut < 0) return { text: visible, preparing: null };
  const rest = text.slice(cut);
  return {
    text: visible,
    preparing: rest.startsWith("<ckanban-questions") ? "Preparing questions…"
      : rest.startsWith("<ckanban-mockup") ? "Drawing mockup…"
      : rest.startsWith("<ckanban-tickets") ? "Preparing tickets…"
      : rest.startsWith("<ckanban-ticket") ? "Preparing ticket proposal…" : null,
  };
}

const UNREADABLE = { questions: "questions", proposal: "ticket proposal", tickets: "proposed tickets" } as const;

/** What the Resend button sends: the same content again, through the matching tool. */
const RESEND = {
  questions: "The board couldn't read your questions. Please resend them with the ask_questions tool.",
  proposal: "The board couldn't read your ticket proposal. Please resend it with the propose_ticket tool.",
  tickets: "The board couldn't read your proposed tickets. Please resend them with the propose_tickets tool.",
} as const;

const REFINE = (s: Ticket["status"]) => s === "backlog" || s === "planning";

/** The server adds this line for the agent to messages with images (IMAGES_NOTE in src/server/attachments.ts). */
const IMAGES_NOTE = "Images in this message are local files; open them with the Read tool to see them.";
/** A message as the user wrote it: without the board's note to the agent. */
export const withoutAgentNotes = (text: string) => text.replaceAll(IMAGES_NOTE, "").trim();

// Image links reach the session as local file paths, so compare by file name.
const norm = (s: string) => withoutAgentNotes(s).replace(/\S*\/attachments\/([0-9a-f]{32}\.\w+)/g, "$1");
/** Whether a message the user sent is in the session file yet. */
const delivered = (entries: SessionEntry[], text: string) => entries.some((e) => e.role === "user" && norm(e.text) === norm(text));

/**
 * The ticket's single conversation with Claude, like the terminal: everything in the session
 * (terminal chat, board runs, messages typed here) in one timeline, plus a box to send more.
 */
/** Stop Claude with instant feedback: "Stopping…" from the click until the run is gone. */
export function useStop(slug: string, ticket: Ticket, working: boolean, onError: (m: string) => void) {
  const [clicked, setClicked] = useState(false);
  useEffect(() => {
    if (!working) setClicked(false);
  }, [working]);
  const stopping = working && (clicked || ticket.lastActivity === "Stopping…");
  const stop = () => {
    setClicked(true);
    api.stop(slug, ticket.id).catch((e) => {
      setClicked(false);
      onError(e.message);
    });
  };
  return { stopping, stop };
}

export function Chat({ slug, ticket, tickets, onOpenTicket, onOpenOutput, onError }: {
  slug: string;
  ticket: Ticket;
  /** The board's tickets, to tell which proposed new tickets already exist. */
  tickets: Ticket[];
  onOpenTicket: (id: string) => void;
  /** Show a file of the ticket's outputs folder (path relative to it) in the Outputs tab. */
  onOpenOutput?: (name: string) => void;
  onError: (m: string) => void;
}) {
  const [page, setPage] = useState<{ entries: SessionEntry[]; start: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Scrolled up: offer a jump back down; "fresh" = something new arrived meanwhile.
  const [jump, setJump] = useState<{ fresh: boolean } | null>(null);
  const [showWarnDetails, setShowWarnDetails] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  useNow();
  // Sent messages not yet in the session file (the server's queue covers ones Claude hasn't read).
  // steer: sent while Claude was working, so it waits for the server queue instead of joining the timeline.
  const [pending, setPending] = useState<{ text: string; steer: boolean }[]>(() => takeFirstMessage(ticket.id));
  const queued = ticket.queued ?? [];
  // Unsent text survives closing the drawer, switching tickets and reloads.
  const [draft, setDraft] = usePersistentState(draftKey(slug, ticket.id), () => "", (v) => !v.trim(), (v) => typeof v === "string");
  const codex = ticket.agent === "codex";
  const agentName = codex ? "Codex" : "Claude";
  const [settingsTab, setSettingsTab] = useState<SettingKind | null>(null);
  const [selectedCommand, setSelectedCommand] = useState<ClaudeCommand | null>(null);
  const [usageRequest, setUsageRequest] = useState(0);
  const commands = useSlashCommands({ agent: agentName, slug, id: ticket.id, draft, composer, onCommand: (command) => {
    if (command.insert) {
      setDraft((current) => command.insert! + current.replace(/^\s*\/[\w:./@-]*\s*/, ""));
      requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
    } else if (command.builtin && command.name === "clear") void clearConversation();
    else if (command.builtin && command.name === "usage") setUsageRequest((n) => n + 1);
    else if (command.builtin && ["model", "effort", "output-style", "config"].includes(command.name)) setSettingsTab(command.name === "effort" ? "effort" : command.name === "output-style" ? "outputStyle" : "model");
    else setSelectedCommand(command);
  } });
  const images = useImagePaste(setDraft);
  const mentions = useFileMentions({ slug, id: ticket.id, draft, setDraft, composer });
  const imageInput = useRef<HTMLInputElement>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Text Claude is writing right now (from the run's partial-message stream); not yet in the session file.
  const [live, setLive] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const keepOffset = useRef<number | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = !!ticket.running;
  const { stopping, stop } = useStop(slug, ticket, running, onError);
  const refine = ticket.standalone ? ticket.access !== "edit" : REFINE(ticket.status);
  const phone = useMediaQuery("(max-width: 767px)");
  const [moreOpen, setMoreOpen] = useState(false);
  const [picking, setPicking] = useState<"model" | "effort" | null>(null);
  const dictation = useDictation((text) => setDraft((d) => (d && !/\s$/.test(d) ? `${d} ${text}` : d + text)), onError);
  const micButton = dictationSupported && (
    <button type="button" className={`icon-btn composer-mic${dictation.listening ? " listening" : ""}`} aria-pressed={dictation.listening}
      aria-label={dictation.listening ? "Stop dictating" : "Dictate a message"} disabled={stopping} onClick={dictation.toggle}>
      <MicIcon size={18} />
    </button>
  );
  const [defaults, setDefaults] = useState<DefaultModels | null>(null);
  useEffect(() => { api.settings().then(setDefaults).catch(() => {}); }, [picking]);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  useEffect(() => {
    Promise.all([api.claudeModels(), api.codexModels()])
      .then(([claude, codex]) => setModelNames(Object.fromEntries([...claude, ...codex].map((m) => [m.value, m.displayName]))))
      .catch(() => {});
  }, []);
  const modelLabel = (value: string | null | undefined) => (value && modelNames[value]) || chipLabel(value, "Default model");
  const statusChips = (["model", "effort"] as const).map((kind) => (
    <span key={kind} className="status-pick">
      <button type="button" className="status-chip" aria-haspopup="menu" aria-expanded={picking === kind} disabled={stopping}
        onClick={() => { commands.close(); setPicking(picking === kind ? null : kind); }}>
        {kind === "model"
          ? modelLabel((codex ? ticket.codexModel : ticket.model === "default" ? null : ticket.model) ?? (codex ? defaults?.codexModel : defaults?.claudeModel))
          : chipLabel((codex ? ticket.codexEffort : ticket.effort) ?? (codex ? defaults?.codexEffort : defaults?.claudeEffort), "Auto effort")}
      </button>
      {picking === kind && <QuickPick slug={slug} ticket={ticket} kind={kind} onClose={() => setPicking(null)}
        onMore={() => setSettingsTab(codex || kind === "model" ? "model" : "effort")} />}
    </span>
  ));
  // Phones have no hint line under the box, so the placeholder says what the agent may do.
  const placeholder = running
    ? (codex ? "Queue a message for Codex’s next turn…" : phone ? "Steer Claude…" : "Steer Claude: it reads this at its next step…")
    : phone ? `Message ${agentName}${refine ? " (read only)" : ""}…`
    : ticket.standalone ? `Message ${agentName}…` : refine ? `Describe your idea or answer ${agentName}…` : `Ask ${agentName} to change or continue something…`;

  const loadTail = useCallback(async () => {
    if (!ticket.sessionId && !codex) return setPage({ entries: [], start: 0 });
    const r = await api.conversation(slug, ticket.id);
    setPage((prev) => {
      if (!prev || r.start <= prev.start) return { entries: r.entries, start: r.start };
      const idx = prev.entries.findIndex((e) => e.uuid === r.entries[0]?.uuid);
      return idx >= 0 ? { entries: [...prev.entries.slice(0, idx), ...r.entries], start: prev.start } : { entries: r.entries, start: r.start };
    });
  }, [slug, ticket.id, ticket.sessionId, codex]);

  const reload = useCallback(() => {
    setLoadError(null);
    loadTail().catch((e) => {
      setLoadError(e.message);
      setPage((p) => p ?? { entries: [], start: 0 });
    });
  }, [loadTail]);
  useEffect(() => {
    setPage(null);
    reload();
  }, [reload]);
  useLayoutEffect(() => autoGrow(composer.current), [draft]);

  // Live updates: session file changes (terminal) and run activity (board) both refresh the tail.
  useEffect(() => subscribe((e) => {
    if (e.type === "draft" && e.profile === slug && e.id === ticket.id) {
      if (e.text) setLive(e.text);
      // Message finished: swap the live copy for the saved one without a gap.
      else loadTail().catch(() => {}).finally(() => setLive(""));
      return;
    }
    const mine = (e.type === "session.updated" || e.type === "activity") && e.profile === slug && e.id === ticket.id;
    if (!mine || refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      loadTail().catch(() => {});
    }, 700);
  }), [slug, ticket.id, loadTail]);

  // A run just finished: pick up the final message even if no more events arrive.
  useEffect(() => {
    if (!running) loadTail().catch(() => {}).finally(() => setLive(""));
  }, [running]);

  // Claude read a queued message: keep its bubble until the session file shows it, so it doesn't blink out.
  const prevQueued = useRef(queued);
  useEffect(() => {
    // Peer messages show up in the session as another ticket's message, not as the user's bubble.
    const read = prevQueued.current.filter((q) => q.state === "queued" && !q.peer && !queued.some((n) => n.id === q.id)).map((q) => q.text);
    prevQueued.current = queued;
    if (read.length) setPending((ps) => [...ps, ...read.map((text) => ({ text, steer: false }))]);
  }, [ticket.queued]);

  const entries = page?.entries ?? [];
  // Drop optimistic bubbles once the session file contains the message.
  useEffect(() => {
    if (pending.some((p) => delivered(entries, p.text))) setPending((ps) => ps.filter((p) => !delivered(entries, p.text)));
  }, [entries, pending]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keepOffset.current !== null) {
      el.scrollTop = el.scrollHeight - keepOffset.current;
      keepOffset.current = null;
    } else if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    else setJump((j) => (j ? { fresh: true } : j));
  }, [page, pending, running, live]);

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stickToBottom.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setJump(null);
  };

  const clearConversation = async () => {
    commands.close();
    if (running) return onError(`Stop ${agentName} before starting a new conversation.`);
    try {
      await api.chat(slug, ticket.id, "/clear");
      setDraft("");
      // The composer still held "/clear" while the request ran, which reopened the menu.
      commands.select("", 0);
      setPage({ entries: [], start: 0 });
      toast("Started a new conversation.", { tone: "ok" });
    } catch (failure: any) { onError(failure.message); }
  };

  const send = async (text: string, preserveDraft = false) => {
    const t = text.trim();
    if (!t || stopping || images.uploading) return;
    if (/^\/(clear|new)$/.test(t)) return clearConversation();
    // Plan usage is the board's own data: show it at once instead of starting an agent run.
    if (t === "/usage" && !codex) { commands.close(); setDraft(""); setUsageRequest((n) => n + 1); return; }
    // Codex settings live on the ticket, not in the CLI: open the settings sheet whatever was typed after.
    if (codex && /^\/(model|effort)(\s|$)/.test(t)) { commands.close(); setSettingsTab("model"); return; }
    if (["/model", "/config", "/settings", "/effort", "/effort status", "/output-style"].includes(t)) { commands.close(); setSettingsTab(t.startsWith("/effort") ? "effort" : t === "/output-style" ? "outputStyle" : "model"); return; }
    if (/^\/model\s+\S/.test(t)) {
      try {
        const model = t.slice(6).trim();
        await api.setModel(slug, ticket.id, model);
        commands.close(); setDraft((current) => current.trim() === t ? "" : current);
        toast(`This ticket will use ${model} for its next reply.`, { tone: "ok" });
      } catch (failure: any) { onError(failure.message); }
      return;
    }
    if (/^\/effort\s+\S/.test(t)) {
      try {
        const effort = t.slice(7).trim();
        await api.setEffort(slug, ticket.id, effort === "auto" ? null : effort as Effort);
        commands.close(); setDraft((current) => current.trim() === t ? "" : current);
        toast(effort === "auto" ? "Effort: Auto" : `Effort: ${effort}`, { tone: "ok" });
      } catch (failure: any) { onError(failure.message); }
      return;
    }
    if (/^\/output-style\s+\S/.test(t)) {
      try {
        const style = t.slice(13).trim();
        await api.setOutputStyle(slug, ticket.id, style);
        commands.close(); setDraft((current) => current.trim() === t ? "" : current);
        toast(`Output style: ${style}`, { tone: "ok" });
      } catch (failure: any) { onError(failure.message); }
      return;
    }
    images.clearError();
    commands.close();
    stickToBottom.current = true;
    setPending((ps) => [...ps, { text: t, steer: running }]);
    if (!preserveDraft) setDraft("");
    try {
      const r = await api.chat(slug, ticket.id, t);
      // Steering: the server queue now shows it.
      if (r.queued?.some((q) => q.text === t)) setPending((ps) => ps.filter((p) => p.text !== t));
    } catch (e: any) {
      setPending((ps) => ps.filter((p) => p.text !== t));
      if (!preserveDraft) setDraft(t);
      onError(e.message);
    }
  };

  const loadEarlier = async () => {
    if (!page || page.start === 0) return;
    setLoadingEarlier(true);
    try {
      const r = await api.conversation(slug, ticket.id, page.start);
      keepOffset.current = scroller.current ? scroller.current.scrollHeight - scroller.current.scrollTop : null;
      setPage((prev) => ({ entries: [...r.entries, ...(prev?.entries ?? [])], start: r.start }));
    } finally {
      setLoadingEarlier(false);
    }
  };

  // A reply still on its way to the session file counts too, so the form doesn't offer "Send answers" again.
  const replying = pending.some((p) => !p.steer);
  const answeredAfter = (index: number) => replying || entries.slice(index + 1).some((e) => e.role === "user" && e.kind === "text" && !e.peer);
  const isApplied = (p: { title: string; description: string }) =>
    (!p.title || p.title === ticket.title) && (!p.description || p.description.trim() === ticket.body.trim());

  const empty = page !== null && !loadError && entries.length === 0 && !pending.length && !queued.length && !running;
  // The agent ended on a question and waits: offer one-tap answers instead of typing on a phone.
  const lastText = [...entries].reverse().find((e) => e.kind === "text" || e.role === "user");
  const asked = !running && !pending.length && !queued.length && lastText?.role === "assistant" &&
    /\?\s*$/.test(lastText.text.replace(/^.*CKANBAN_RESULT:.*$/m, "").trim().split("\n").filter(Boolean).pop() ?? "");
  const quickReplies = asked ? ["Yes, go ahead", "No", "Tell me more", ...(/\bcommit/i.test(lastText!.text) ? ["Commit"] : [])] : [];

  /** Who a ticket-to-ticket message is from or to, linking to that ticket when it still exists. */
  const peerLabel = (dir: "in" | "out", ticketId: string | null) => {
    const other = ticketId ? tickets.find((t) => t.id === ticketId) : undefined;
    const name = other ? other.title : ticketId ?? "another ticket";
    const link = other
      ? <button className="link-btn" onClick={() => onOpenTicket(other.id)} title={other.id}>{name}</button>
      : <span>{name}</span>;
    return dir === "in" ? <>From {link}'s Claude</> : <>Claude to {link}</>;
  };
  const childFor = (d: { title: string }) => tickets.find((t) => t.parentId === ticket.id && t.title === d.title);
  const createChild = async (d: NewTicketDraft) => {
    try {
      return await api.createTicket(slug, {
        title: d.title, body: d.description, status: "backlog", mode: "interview", parentId: ticket.id,
        ...(d.key ? { planKey: d.key } : {}), ...(d.dependsOn?.length ? { dependsOn: d.dependsOn } : {}),
      });
    } catch (err: any) {
      onError(err.message);
      return null;
    }
  };

  const applyProposal = async (p: { title: string; description: string }) => {
    const before = { title: ticket.title, body: ticket.body };
    try {
      await api.updateTicket(slug, ticket.id, {
        ...(p.title ? { title: p.title } : {}),
        ...(p.description ? { body: p.description } : {}),
      });
      toast("Applied to the ticket", {
        tone: "ok",
        action: {
          label: "Undo",
          run: () => api.updateTicket(slug, ticket.id, before).catch((err) => toast(`Undo failed: ${err.message}`, { tone: "error" })),
        },
      });
    } catch (err: any) {
      onError(err.message);
    }
  };

  return (
    <div className="chat">
      <div className="chat-log" ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
          stickToBottom.current = gap < 60;
          if (gap < 60) setJump(null);
          else if (gap > 240) setJump((j) => j ?? { fresh: false });
        }}>
        {page === null && <div className="muted"><span className="spinner" /> Loading the conversation…</div>}
        {loadError && (
          <div className="banner error inline load-error" role="alert">
            Couldn't load the conversation: {loadError}{" "}
            <button className="link-btn" onClick={reload}>Retry</button>
          </div>
        )}
        {page && page.start > 0 && (
          <button className="btn ghost small load-earlier" onClick={loadEarlier} disabled={loadingEarlier}>
            {loadingEarlier ? "Loading…" : `Load earlier (${page.start} more)`}
          </button>
        )}
        {empty && (
          <div className="chat-empty">
            {ticket.standalone ? (
              <p className="muted">{refine ? `Ask ${agentName} about this repo. It can read files but won’t change them.` : `Tell ${agentName} what to do. It works directly in your repo folder.`} Type / for commands.</p>
            ) : ticket.status === "backlog" ? (
              <>
                <p><b>Parked.</b> Move it to Planning when you want your agent to help shape it: it will ask a few questions, then propose a clear title and description.</p>
                <button className="btn" onClick={() => api.updateTicket(slug, ticket.id, { status: "planning" }).catch((e) => onError(e.message))}>
                  Move to Planning
                </button>
              </>
            ) : ticket.status === "planning" ? (
              <>
                {/* Only shown if the automatic start didn't happen (e.g. session was open in a terminal). */}
                <p><b>Shape this ticket with your agent.</b> Describe your idea below, or let your agent start the interview.</p>
                <button className="btn" onClick={() => send("Help me refine this ticket. Interview me about what's unclear, then propose an improved title and description.")}>
                  Start the interview
                </button>
              </>
            ) : (
              <p className="muted">No conversation yet. Move the card to In Progress to let your agent work on it, or send a message.</p>
            )}
          </div>
        )}
        {group(entries).map((b) => {
          if (b.kind === "tools") {
            return (
              <details key={b.items[0].uuid} className="conv-tools">
                <summary>{summarizeSteps(b.items.map((t) => t.text))}</summary>
                <ul>{b.items.map((t) => {
                  const step = describeStep(t.text);
                  return <li key={t.uuid}><span className="step-label">{step.label}</span>{step.detail && <code className="step-detail">{step.detail}</code>}</li>;
                })}</ul>
              </details>
            );
          }
          const e = b.e;
          if (e.kind === "board") {
            return <div key={e.uuid} className="chat-note">{e.text}{e.at && <span title={fullTime(e.at)}> · {timeAgo(e.at)}</span>}</div>;
          }
          if (e.peer) {
            return (
              <div key={e.uuid} className={`conv-msg peer ${e.peer.dir}`}>
                <div className="conv-head">
                  <b>{peerLabel(e.peer.dir, e.peer.ticketId)}</b>
                  {e.at && <time className="muted small" dateTime={e.at} title={fullTime(e.at)}>{timeAgo(e.at)}</time>}
                </div>
                <Markdown text={e.text} />
              </div>
            );
          }
          return (
            <div key={e.uuid} className={`conv-msg ${e.role}`}>
              <div className="conv-head">
                <b>{e.role === "user" ? "You" : agentName}</b>
                {e.at && <time className="muted small" dateTime={e.at} title={fullTime(e.at)}>{timeAgo(e.at)}</time>}
              </div>
              {e.text && e.role === "assistant" && parseCliUsage(e.text) ? <CliUsageCard text={e.text} />
                : e.text && <Markdown text={withoutAgentNotes(e.text.replace(/^.*CKANBAN_RESULT:.*$/m, ""))} />}
              {e.questions && (
                <QuestionsForm questions={e.questions} answered={answeredAfter(b.index)} disabled={running} onSubmit={(text) => send(text, true)}
                  onPreview={onOpenOutput && ((m) => onOpenOutput(`mockups/${m}`))}
                  storageKey={formKey(slug, ticket.id, e.uuid)} />
              )}
              {e.proposal && (
                <ProposalCard proposal={e.proposal} applied={isApplied(e.proposal)} onApply={() => applyProposal(e.proposal!)} />
              )}
              {e.newTickets && (
                <NewTicketsCard drafts={e.newTickets} created={childFor} onCreate={createChild} onOpen={onOpenTicket} />
              )}
              {e.mockups && (
                <div className="chat-mockups">
                  {e.mockups.map((m) => (
                    <button key={m} className="chat-mockup" onClick={() => onOpenOutput?.(`mockups/${m}`)} title="Preview in the Outputs tab">
                      <FileCodeIcon size={13} /> Mockup <b>{m}</b>
                    </button>
                  ))}
                </div>
              )}
              {e.unreadable && (
                <div className="chat-unreadable" role="status">
                  <span>Couldn't read {agentName}’s {UNREADABLE[e.unreadable]}.</span>
                  {!answeredAfter(b.index) && (
                    <button className="btn small" disabled={running} onClick={() => send(RESEND[e.unreadable!])}>Resend</button>
                  )}
                </div>
              )}
              {e.moved === "planning" && (
                <div className="chat-moved">
                  Moved to <b>Planning</b>: this was a planning request, so nothing was changed. Answer or refine here, then
                  drag the card to In Progress when you want your agent to do it.
                </div>
              )}
            </div>
          );
        })}
        {/* Replies sent while Claude wasn't working are part of the timeline: plain bubbles, before Claude's reply. */}
        {pending.filter((p) => !p.steer).map((p, i) => (
          <div key={i} className="conv-msg user">
            <Markdown text={p.text} />
          </div>
        ))}
        {ticket.interrupted?.partial && (
          <div className="conv-msg assistant interrupted">
            <div className="conv-head"><b>{agentName}</b><span className="muted small">interrupted by a board restart; {running ? "continuing below…" : "resumes when the board is back"}</span></div>
            <Markdown text={ticket.interrupted.partial} />
          </div>
        )}
        {live && (
          <div className="conv-msg assistant live" aria-live="polite">
            <div className="conv-head"><b>{agentName}</b><span className="muted small">writing…</span></div>
            {liveView(live).text && <Markdown text={liveView(live).text} />}
            {liveView(live).preparing && <div className="chat-typing"><span className="spinner" /> {liveView(live).preparing}</div>}
          </div>
        )}
        {running && !live && (
          <div className="chat-typing"><span className="spinner" /> {ticket.lastActivity && ticket.lastActivity !== "Starting…" ? ticket.lastActivity : ` ${agentName} is working…`}</div>
        )}
        {pending.filter((p) => p.steer && !queued.some((q) => q.text === p.text)).map((p, i) => (
          <div key={i} className="conv-msg user pending">
            <div className="conv-head"><b>You</b><span className="muted small">sending…</span></div>
            <Markdown text={p.text} />
          </div>
        ))}
        {queued.filter((q) => q.peer).map((q) => (
          <div key={q.id} className="conv-msg peer in pending">
            <div className="conv-head">
              <b>{peerLabel("in", q.text.match(/<ckanban-context[^>]* from="([^"]*)"/)?.[1] ?? null)}</b>
              <span className="muted small">{q.state === "queued" ? codex ? "queued · Codex reads this in its next turn" : "queued · Claude reads this at its next step" : `not sent · ${agentName} was stopped before reading it`}</span>
            </div>
            <Markdown text={q.text.split("<ckanban-context")[0].trim()} />
            {q.state === "unsent" && (
              <div className="queued-actions">
                <button className="btn primary small" disabled={stopping}
                  onClick={() => api.sendQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Send</button>
                <button className="btn ghost small"
                  onClick={() => api.discardQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Discard</button>
              </div>
            )}
          </div>
        ))}
        {queued.filter((q) => !q.peer).map((q) => (
          <div key={q.id} className={`conv-msg user pending${q.state === "unsent" ? " unsent" : ""}`}>
            <div className="conv-head">
              <b>You</b>
              <span className="muted small">{q.state === "queued" ? codex ? "queued · Codex reads this in its next turn" : "queued · Claude reads this at its next step" : `not sent · ${agentName} was stopped before reading it`}</span>
            </div>
            <Markdown text={q.text} />
            {q.state === "unsent" && (
              <div className="queued-actions">
                <button className="btn primary small" disabled={stopping}
                  onClick={() => api.sendQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Send</button>
                <button className="btn ghost small"
                  onClick={() => api.discardQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Discard</button>
              </div>
            )}
          </div>
        ))}
        {!running && ticket.error && !ticket.error.startsWith("corrupt") && (
          <div className="banner error inline">
            <pre>{ticket.error}</pre>
            {/model/i.test(ticket.error) && <button className="btn small" onClick={() => setSettingsTab("model")}>Choose model</button>}
          </div>
        )}
        {ticket.notice && (
          <div className="banner info inline notice" role="status">
            <span>{ticket.notice}</span>
            <button className="icon-btn" aria-label="Dismiss" title="Dismiss"
              onClick={() => api.updateTicket(slug, ticket.id, { notice: null }).catch((e) => onError(e.message))}><CloseIcon size={12} /></button>
          </div>
        )}
      </div>

      {/* Reserve space outside messages so navigation never covers an answer. */}
      {jump && (
        <div className="chat-jump">
          <button className={`jump-latest${jump.fresh ? " fresh" : ""}`} onClick={toBottom}>
            <ArrowDownIcon size={12} /> {jump.fresh ? "New messages" : "Jump to latest"}
          </button>
        </div>
      )}

      {ticket.terminalOpen && !running && (
        <div className="composer-warn">
          Also open in your terminal: type in one place at a time.{" "}
          <button className="link-btn small" aria-expanded={showWarnDetails} onClick={() => setShowWarnDetails((v) => !v)}>
            {showWarnDetails ? "Less" : "Why?"}
          </button>
          {showWarnDetails && (
            <div className="composer-warn-more">
              Sending here works, but if you type in both places at once the two conversations can get mixed up.
            </div>
          )}
        </div>
      )}
      <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => {
        const files = Array.from(e.currentTarget.files ?? []);
        e.currentTarget.value = "";
        if (files.length && composer.current) images.insert(composer.current, files);
      }} />
      {quickReplies.length > 0 && !draft.trim() && (
        <div className="quick-replies" role="group" aria-label="Quick replies">
          {quickReplies.map((reply) => <button key={reply} type="button" className="chip" onClick={() => send(reply)}>{reply}</button>)}
        </div>
      )}
      {phone ? (
        // Phones: one row like a messaging app. Extra actions sit behind +, and the one round button
        // is Stop while the agent works with nothing typed, otherwise Send.
        <div className="composer composer-card">
          {commands.popup}
          {mentions.popup}
          <textarea ref={composer} rows={phone ? 1 : 2} value={draft} disabled={stopping} className={images.dragOver ? "drop-target" : undefined} {...images.handlers} {...commands.aria} role="combobox" aria-label={`Message ${agentName}`}
            placeholder={placeholder}
            onFocus={commands.prefetch}
            onChange={(e) => { setDraft(e.target.value); commands.select(e.target.value, e.target.selectionStart); mentions.select(e.target.value, e.target.selectionStart); }}
            onSelect={(e) => { if (!settingsTab && !selectedCommand) commands.select(e.currentTarget.value, e.currentTarget.selectionStart); }}
            onKeyDown={(e) => {
              if (mentions.keyDown(e) || commands.keyDown(e)) return;
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia("(pointer: coarse)").matches) {
                e.preventDefault();
                send(draft);
              }
            }} />
          <div className="composer-bar">
          <div className="composer-more">
            <button type="button" className="icon-btn composer-plus" aria-label="More actions" aria-haspopup="menu" aria-expanded={moreOpen} disabled={stopping} onClick={() => setMoreOpen((v) => !v)}><PlusIcon size={20} /></button>
            {moreOpen && <ComposerMenu onClose={() => setMoreOpen(false)} items={[
              { label: "Attach images", icon: <ImageIcon size={18} />, onSelect: () => imageInput.current?.click() },
              { label: `${agentName} settings`, icon: <SlidersIcon size={18} />, onSelect: () => { commands.close(); setSettingsTab("model"); } },
              { label: "Commands", icon: <SlashIcon size={18} />, onSelect: commands.toggle },
            ]} />}
          </div>
            <div className="composer-status phone-status">{statusChips}</div>
          {micButton}
          {running && !draft.trim()
            ? <button type="button" className="btn danger send-round" aria-label={stopping ? "Stopping" : `Stop ${agentName}`} disabled={stopping} onClick={stop}><span className="stop-square" aria-hidden /></button>
            : <button type="button" className="btn primary send-round" aria-label={images.uploading ? "Uploading" : "Send"} disabled={!draft.trim() || stopping || images.uploading} onClick={() => send(draft)}>{images.uploading ? <span className="spinner" /> : <ArrowUpIcon size={18} />}</button>}
          </div>
        </div>
      ) : (
      <div className="composer">
        {commands.popup}
        {mentions.popup}
        <textarea ref={composer} rows={phone ? 1 : 2} value={draft} disabled={stopping} className={images.dragOver ? "drop-target" : undefined} {...images.handlers} {...commands.aria} role="combobox" aria-label={`Message ${agentName}`}
          placeholder={placeholder}
          onFocus={commands.prefetch}
          onChange={(e) => { setDraft(e.target.value); commands.select(e.target.value, e.target.selectionStart); mentions.select(e.target.value, e.target.selectionStart); }}
          onSelect={(e) => { if (!settingsTab && !selectedCommand) commands.select(e.currentTarget.value, e.currentTarget.selectionStart); }}
          onKeyDown={(e) => {
            if (mentions.keyDown(e) || commands.keyDown(e)) return;
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia("(pointer: coarse)").matches) {
              e.preventDefault();
              send(draft);
            }
          }} />
        {images.error && <div className="form-error">{images.error}</div>}
        <div className="composer-foot">
          {/* What the next reply runs with, at a glance; each opens its setting (like the CLI apps' status line). */}
          <span className="composer-status">
            <span className="muted small" title={refine ? `${agentName} won’t change files` : `${agentName} can change files`}>{refine ? (ticket.standalone ? "Read only" : "Refine mode") : "Can edit"}</span>
            {statusChips}
            <span className="muted small composer-keys">Enter to send · Shift+Enter for a new line</span>
          </span>
          <span className="composer-actions">
            <button type="button" className="btn small composer-icon" aria-label="Attach images" title="Attach images" disabled={stopping || images.uploading} onClick={() => imageInput.current?.click()}><ImageIcon size={18} /></button>
            {micButton}
            {running && <button className="btn danger small" disabled={stopping} onClick={stop}>{stopping ? "Stopping…" : "Stop"}</button>}
            <button className="btn primary small" disabled={!draft.trim() || stopping || images.uploading} onClick={() => send(draft)}>{images.uploading ? "Uploading…" : "Send"}</button>
          </span>
        </div>
      </div>
      )}
      {phone && images.error && <div className="form-error composer-error">{images.error}</div>}
      {usageRequest > 0 && <UsagePill compact openRequest={usageRequest} />}
      {settingsTab && codex && <AgentSettings slug={slug} ticket={ticket} onClose={()=>setSettingsTab(null)}/>}
      {settingsTab && !codex && <ClaudeSettings slug={slug} ticket={ticket} initialTab={settingsTab} onClose={() => setSettingsTab(null)} onSaved={(kind) => {
        setDraft((current) => [`/${kind === "outputStyle" ? "output-style" : kind}`, "/config", "/settings", "/effort status"].includes(current.trim()) ? "" : current);
      }} />}
      {selectedCommand && <CommandOptions command={selectedCommand} initial={(() => {
        const match = /^\s*\/([\w:./@-]+)(?:\s+(.*))?$/s.exec(draft);
        return match && [selectedCommand.name, ...selectedCommand.aliases].some((name) => name.startsWith(match[1])) ? match[2] ?? "" : "";
      })()} onClose={() => setSelectedCommand(null)} onPrepare={(text) => {
        setSelectedCommand(null); setDraft((current) => prepareCommand(current, text)); commands.close();
        requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
      }} onSend={(text) => {
        setSelectedCommand(null); commands.close();
        const preserve = !/^\s*\/[\w:./@-]*(?:\s|$)/.test(draft);
        void send(text, preserve);
      }} />}
    </div>
  );
}

/** The phone composer's + menu: actions that sit as buttons beside the box on wider screens. */
function ComposerMenu({ items, onClose }: { items: { label: string; icon: JSX.Element; onSelect: () => void }[]; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useLayer(onClose);
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => { if (!root.current?.parentElement?.contains(e.target as Node)) onClose(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  return (
    <div className="inbox-menu composer-menu" role="menu" aria-label="More actions" ref={root}>
      {items.map((item) => (
        <button key={item.label} role="menuitem" className="menu-item" onClick={() => { onClose(); item.onSelect(); }}>
          <span className="menu-icon">{item.icon}</span><span className="menu-label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
