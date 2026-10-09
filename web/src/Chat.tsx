import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, subscribe, type ClaudeCommand, type DefaultModels, type Effort, type NewTicketDraft, type OutputFile, type SessionEntry, type Ticket } from "./api";
import { autoGrow } from "./autoGrow";
import { branchTicket } from "./branch";
import { BranchCard } from "./BranchCard";
import { ArrowDownIcon, ArrowUpIcon, BoltIcon, BranchIcon, CloseIcon, FileCodeIcon, FileTextIcon, ImageIcon, MicIcon, PlusIcon, ShieldAlertIcon, ShieldIcon, SlashIcon, SlidersIcon } from "./icons";
import { useImagePaste } from "./imagePaste";
import { NewTicketsCard } from "./NewTicketsCard";
import { ProposalCard } from "./ProposalCard";
import { QuestionsForm } from "./QuestionsForm";
import { SetupRow } from "./SetupRow";
import { filesByReply } from "./fileCards";
import { baseName, copyFile, downloadFile } from "./share";
import { draftKey, formKey, takeFirstMessage } from "./drafts";
import { fullTime, timeAgo, useNow } from "./time";
import { toast } from "./toast";
import { Markdown } from "./Transcript";
import { usePersistentState } from "./usePersistentState";
import { useSlashCommands } from "./SlashCommands";
import { useFileMentions } from "./FileMentions";
import { useSnippetPicker } from "./SnippetPicker";
import { useDictation, dictationSupported } from "./useDictation";
import { useMediaQuery } from "./useMediaQuery";
import { useLayer } from "./layers";
import { AgentSettings } from "./AgentSettings";
import { AccessPick, chipLabel, QuickPick } from "./QuickPick";
import { ToolGroup } from "./ToolGroup";
import { CliUsageCard, UsagePill } from "./UsagePill";
import { parseCliUsage } from "./usage";
import { ClaudeSettings, type SettingKind } from "./ClaudeSettings";
import { CommandOptions } from "./CommandOptions";
import { prepareCommand } from "./commandSyntax";

/** m:ss (h:mm:ss past an hour) since `iso`. */
function clock(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  const mm = String(Math.floor((s % 3600) / 60)), ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/** Claude ended its turn to wait for background tasks; the run stays open and it resumes when they finish. */
/** What the agent is doing right now and for how long, like the desktop apps' "Working · 1m 12s". */
function WorkingRow({ text, since }: { text: string; since?: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const secs = since ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) : null;
  return (
    <div className="working-row" role="status">
      <span className="spinner" />
      <span className="working-text">{text}</span>
      {secs !== null && <span className="working-time">{secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}</span>}
    </div>
  );
}

function WaitingCard({ tasks }: { tasks: NonNullable<Ticket["waitingOn"]> }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="waiting-card" aria-live="polite">
      <div className="waiting-title"><span className="spinner" /> Waiting for {tasks.length === 1 ? "1 background task" : `${tasks.length} background tasks`}</div>
      <ul>
        {tasks.map((t) => (
          <li key={t.id}><span>{t.description}</span><span className="waiting-time" title={`Started ${fullTime(t.startedAt)}`}>{clock(t.startedAt, now)}</span></li>
        ))}
      </ul>
      <div className="waiting-note">Claude continues automatically when they finish.</div>
    </div>
  );
}

type Block = { kind: "entry"; e: SessionEntry; index: number } | { kind: "tools"; items: SessionEntry[] };

/** Copied history of a branched ticket: entries from before the branch point (at = the branch time). */
const before = (e: SessionEntry, at: string | undefined) => !!at && !!e.at && e.at < at;

/** Tool calls in a row fold into one block; a branch point (splitAt) starts a new one. */
function group(entries: SessionEntry[], splitAt?: string): Block[] {
  const out: Block[] = [];
  entries.forEach((e, index) => {
    const prev = out.at(-1);
    if (e.kind === "tool") {
      if (prev?.kind === "tools" && before(prev.items[0], splitAt) === before(e, splitAt)) prev.items.push(e);
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

/** Reply text compared loosely: no result line, whitespace collapsed. */
const flat = (s: string) => s.replace(/^.*CKANBAN_RESULT.*$/gm, "").replace(/\s+/g, " ").trim();

/** A finished live reply kept on screen until the conversation shows its saved copy. */
type Handoff = { text: string; flat: string; at: number; count: number };
const HANDOFF_RETRY_MS = 500;
const HANDOFF_MAX_MS = 5000;

/** Whether the loaded entries contain the saved copy of a finished live reply. */
function saved(entries: SessionEntry[], h: Handoff): boolean {
  // Only board blocks (questions, proposal…): nothing to compare, so wait for any new entry.
  if (!h.flat) return entries.length > h.count;
  const recent = entries.filter((e) => e.role === "assistant" && e.kind === "text" && !e.peer).slice(-30);
  return flat(recent.map((e) => e.text).join(" ")).includes(h.flat);
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

function kb(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

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
  const snippets = useSnippetPicker({ slug, ref: composer, setValue: setDraft, trigger: "$" });
  const imageInput = useRef<HTMLInputElement>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Text Claude is writing right now (from the run's partial-message stream); not yet in the session file.
  const [live, setLive] = useState("");
  // Replies that finished streaming but aren't in the loaded conversation yet.
  const [handoff, setHandoff] = useState<Handoff[]>([]);
  const entriesRef = useRef<SessionEntry[]>([]);
  // loadTail calls overlap (draft, activity, session watcher): a slower, older response must not win.
  const tailSeq = useRef(0);
  const tailApplied = useRef(0);
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
  const modelText = modelLabel((codex ? ticket.codexModel : ticket.model === "default" ? null : ticket.model) ?? (codex ? defaults?.codexModel : defaults?.claudeModel));
  const effortValue = (codex ? ticket.codexEffort : ticket.effort) ?? (codex ? defaults?.codexEffort : defaults?.claudeEffort) ?? null;
  const effortText = chipLabel(effortValue, "Auto");
  const [accessOpen, setAccessOpen] = useState(false);
  // Phones have no hint line under the box, so the placeholder says what the agent may do.
  const placeholder = running
    ? (codex ? "Queue a message for Codex’s next turn…" : phone ? "Steer Claude…" : "Steer Claude: it reads this at its next step…")
    : ticket.standalone ? `Work on ${slug}` : refine ? `Describe your idea or answer ${agentName}…` : `Ask ${agentName} to change or continue something…`;

  const loadTail = useCallback(async () => {
    if (!ticket.sessionId && !codex) return setPage({ entries: [], start: 0 });
    const seq = ++tailSeq.current;
    const r = await api.conversation(slug, ticket.id);
    if (seq < tailApplied.current) return;
    tailApplied.current = seq;
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
    setHandoff([]);
    reload();
  }, [reload]);
  useLayoutEffect(() => autoGrow(composer.current), [draft]);

  // Live updates: session file changes (terminal) and run activity (board) both refresh the tail.
  useEffect(() => subscribe((e) => {
    if (e.type === "draft" && e.profile === slug && e.id === ticket.id) {
      if (e.text) setLive(e.text);
      else if (e.final) {
        // Message finished: show all of it until the saved copy is loaded, then swap without a gap.
        const h = { text: e.final, flat: flat(liveView(e.final).text), at: Date.now(), count: entriesRef.current.length };
        setHandoff((hs) => [...hs, h]);
        setLive("");
        loadTail().catch(() => {});
      } else loadTail().catch(() => {}).finally(() => setLive(""));
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
  entriesRef.current = entries;
  // Finished replies still waiting for their saved copy; filtered here so both never show at once.
  const waitingHandoff = useMemo(() => handoff.filter((h) => !saved(entries, h)), [handoff, entries]);
  useEffect(() => {
    if (waitingHandoff.length !== handoff.length) setHandoff(waitingHandoff);
  }, [waitingHandoff, handoff]);
  // The saved copy can lag the stream (transcript written after stdout): poll briefly, then give up.
  const handingOff = handoff.length > 0;
  useEffect(() => {
    if (!handingOff) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setHandoff((hs) => (hs.some((h) => now - h.at >= HANDOFF_MAX_MS) ? hs.filter((h) => now - h.at < HANDOFF_MAX_MS) : hs));
      loadTail().catch(() => {});
    }, HANDOFF_RETRY_MS);
    return () => clearInterval(timer);
  }, [handingOff, loadTail]);
  // Output files for the cards under replies; refreshed whenever the conversation is.
  const [files, setFiles] = useState<OutputFile[]>([]);
  useEffect(() => {
    if (page) api.outputs(slug, ticket.id).then(setFiles).catch(() => {});
  }, [slug, ticket.id, page, running]);
  const cards = useMemo(() => filesByReply(entries, files), [entries, files]);
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
  }, [page, pending, running, live, waitingHandoff]);

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

  // After a failed or stopped run: send your last message again, or load it into the box to change it first.
  const retryButtons = ticket.lastPrompt && (
    <div className="run-actions">
      <button type="button" className="btn small" onClick={() => send(ticket.lastPrompt!, true)}>Retry</button>
      <button type="button" className="btn ghost small" onClick={() => { setDraft(ticket.lastPrompt!); composer.current?.focus(); }}>Edit and resend</button>
    </div>
  );
  // On iPhone a tap on a button blurs the text box first: the keyboard closes, the composer slides down
  // and the tap lands beside the button, so nothing is sent. Keeping focus keeps the button in place.
  const keepKeyboard = (e: React.PointerEvent | React.MouseEvent) => { if (document.activeElement === composer.current) e.preventDefault(); };
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

  // Only the first message of an agent's turn carries the name and time; the rest read as one reply.
  const continuesTurn = (i: number) => {
    const prev = blocks.slice(0, i).findLast((b) => b.kind === "entry");
    return prev?.kind === "entry" && prev.e.role === "assistant" && prev.e.kind === "text" && !prev.e.note && !prev.e.peer;
  };

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
        ...(d.needs?.length ? { needs: d.needs } : {}),
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

  /** One block of the conversation; old = copied history of a branched ticket (shown dimmed). */
  const renderBlock = (b: Block, old: boolean) => {
    const el = renderEntry(b, old);
    if (b.kind === "tools" || !b.e.setup) return el;
    return <Fragment key={b.e.uuid}><SetupRow setup={b.e.setup} old={old} />{el}</Fragment>;
  };
  const renderEntry = (b: Block, old: boolean) => {
          if (b.kind === "tools") {
            const tools = <ToolGroup key={b.items[0].uuid} texts={b.items.map((t) => t.text)} details={b.items.map((t) => t.tool)} />;
            return old ? <div key={b.items[0].uuid} className="inherited">{tools}</div> : tools;
          }
          const e = b.e;
          if (e.kind === "board") {
            return <div key={e.uuid} className={`chat-note${old ? " inherited" : ""}`}>{e.text}{e.at && <span title={fullTime(e.at)}> · {timeAgo(e.at)}</span>}</div>;
          }
          if (e.peer) {
            return (
              <div key={e.uuid} className={`conv-msg peer ${e.peer.dir}${old ? " inherited" : ""}`}>
                <div className="conv-head">
                  <b>{peerLabel(e.peer.dir, e.peer.ticketId)}</b>
                  {e.at && <time className="muted small" dateTime={e.at} title={fullTime(e.at)}>{timeAgo(e.at)}</time>}
                </div>
                <Markdown text={e.text} />
              </div>
            );
          }
          return (
            <div key={e.uuid} title={e.role === "user" && e.at ? fullTime(e.at) : undefined}
              className={`conv-msg ${e.role}${e.note ? " note" : ""}${e.role === "assistant" && continuesTurn(blocks.indexOf(b)) ? " continued" : ""}${old ? " inherited" : ""}`}>
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
              {e.branch && (
                <BranchCard reason={e.branch.reason} here={old} running={running} onOpen={onOpenTicket}
                  branch={tickets.find((t) => t.branchedFrom === ticket.id && !!t.branchPoint && t.branchPoint.at > e.at)}
                  onBranch={() => branchTicket(slug, ticket, onOpenTicket).then(() => {}, (err) => onError(err.message))} />
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
              {e.role === "assistant" && cards.get(e.uuid)?.map((f) => (
                <div key={f.name} className="chat-file">
                  <FileTextIcon size={14} />
                  <b title={f.name}>{baseName(f.name)}</b>
                  <span className="muted small">{kb(f.size)}</span>
                  <span className="chat-file-actions">
                    <button className="btn small" onClick={() => onOpenOutput?.(f.name)}>View</button>
                    {ticket.canCopyFile && <button className="btn small" onClick={() => copyFile(slug, ticket.id, f.name)}>Copy file</button>}
                    <button className="btn small" onClick={() => downloadFile(slug, ticket.id, f.name)}>Download</button>
                  </span>
                </div>
              ))}
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
  };

  // A branched ticket: a divider marks where the copied conversation ends.
  const bp = ticket.branchPoint ?? undefined;
  const branchedFrom = ticket.branchedFrom ? tickets.find((t) => t.id === ticket.branchedFrom) : undefined;
  const blocks = group(entries, bp?.at);
  // Divider before the first block after the branch point (after all of them while nothing new was said yet).
  const firstNew = bp ? blocks.findIndex((b) => !before(b.kind === "tools" ? b.items[0] : b.e, bp.at)) : -1;
  const dividerAt = !bp || page === null || page.start > 0 && firstNew === 0 ? -1 : firstNew < 0 ? blocks.length : firstNew;
  const divider = bp && (
    <div key={`branch-${bp.at}`} className="branch-divider" role="separator">
      <BranchIcon size={12} /> branched from {branchedFrom
        ? <button className="link-btn" onClick={() => onOpenTicket(branchedFrom.id)}>{branchedFrom.title}</button>
        : bp.sourceTitle} · <time dateTime={bp.at} title={fullTime(bp.at)}>{new Date(bp.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</time>
    </div>
  );

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
                <button className="btn primary" onClick={() => api.updateTicket(slug, ticket.id, { status: "planning" }).catch((e) => onError(e.message))}>
                  Move to Planning
                </button>
              </>
            ) : ticket.status === "planning" ? (
              <>
                {/* Only shown if the automatic start didn't happen (e.g. session was open in a terminal). */}
                <p><b>Shape this ticket with your agent.</b> Describe your idea below, or let your agent start the interview.</p>
                <button className="btn primary" onClick={() => send("Help me refine this ticket. Interview me about what's unclear, then propose an improved title and description.")}>
                  Start the interview
                </button>
              </>
            ) : (
              <p className="muted">No conversation yet. Move the card to In Progress to let your agent work on it, or send a message.</p>
            )}
          </div>
        )}
        {blocks.map((b, i) => {
          const first = b.kind === "tools" ? b.items[0] : b.e;
          return <Fragment key={first.uuid}>{i === dividerAt && divider}{renderBlock(b, before(first, bp?.at))}</Fragment>;
        })}
        {dividerAt === blocks.length && divider}
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
        {waitingHandoff.map((h) => (
          <div key={h.at} className="conv-msg assistant live">
            <div className="conv-head"><b>Claude</b></div>
            {liveView(h.text).text && <Markdown text={liveView(h.text).text} />}
            {liveView(h.text).preparing && <div className="chat-typing"><span className="spinner" /> {liveView(h.text).preparing}</div>}
          </div>
        ))}
        {live && (
          <div className="conv-msg assistant live" aria-live="polite">
            <div className="conv-head"><b>{agentName}</b><span className="muted small">writing…</span></div>
            {liveView(live).text && <Markdown text={liveView(live).text} />}
            {liveView(live).preparing && <div className="chat-typing"><span className="spinner" /> {liveView(live).preparing}</div>}
          </div>
        )}
        {running && !live && !!ticket.waitingOn?.length && <WaitingCard tasks={ticket.waitingOn} />}
        {running && !live && !ticket.waitingOn?.length && (
          <WorkingRow text={ticket.lastActivity && ticket.lastActivity !== "Starting…" ? ticket.lastActivity : `${agentName} is working…`} since={ticket.runStartedAt} />
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
            {q.state === "queued" && running && (
              <div className="queued-actions">
                <button className="btn small" disabled={stopping}
                  onClick={() => api.sendQueuedNow(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Send now</button>
              </div>
            )}
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
          <div className="banner error inline run-error" role="alert">
            <b>{agentName} stopped with an error</b>
            <pre>{ticket.error}</pre>
            {/model/i.test(ticket.error) && <button className="btn small" onClick={() => setSettingsTab("model")}>Choose model</button>}
            {retryButtons}
          </div>
        )}
        {!running && !ticket.error && ticket.outcome === "stopped" && ticket.lastPrompt && (
          <div className="banner info inline run-stopped" role="status">
            <span>{agentName} was stopped.</span>
            {retryButtons}
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
          <span className="warn-long">Also open in your terminal: type in one place at a time.</span>
          <span className="warn-short">Also open in your terminal.</span>{" "}
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
      {/* One card on phone and desktop, like the Codex app: the text on top, then +, the access shield,
          and on the right model, effort, dictation and one round button (Stop while the agent works). */}
      <div className="composer composer-card" onClick={(e) => { if (!(e.target as HTMLElement).closest("button, textarea, .quick-pick")) composer.current?.focus(); }}>
        {commands.popup}
        {mentions.popup}
        {snippets.popup}
        <textarea ref={composer} rows={1} value={draft} disabled={stopping} className={images.dragOver ? "drop-target" : undefined} {...images.handlers} {...commands.aria} role="combobox" aria-label={`Message ${agentName}`}
          placeholder={placeholder}
          onFocus={commands.prefetch}
          onChange={(e) => { setDraft(e.target.value); commands.select(e.target.value, e.target.selectionStart); mentions.select(e.target.value, e.target.selectionStart); }}
          onSelect={(e) => { if (!settingsTab && !selectedCommand) commands.select(e.currentTarget.value, e.currentTarget.selectionStart); snippets.handlers.onSelect(); }}
          onKeyDown={(e) => {
            if (snippets.onKeyDown(e) || mentions.keyDown(e) || commands.keyDown(e)) return;
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
          {ticket.standalone && (
            <span className="status-pick">
              <button type="button" className={`icon-btn composer-icon-btn access-shield${refine ? "" : " edit"}`} aria-haspopup="menu" aria-expanded={accessOpen}
                aria-label={refine ? `${agentName} can only read. Change access` : `${agentName} can edit files. Change access`}
                title={refine ? "Read only" : "Can edit"} onClick={() => { commands.close(); setAccessOpen((v) => !v); }}>
                {refine ? <ShieldIcon size={20} /> : <ShieldAlertIcon size={20} />}
              </button>
              {accessOpen && <AccessPick slug={slug} ticket={ticket} onClose={() => setAccessOpen(false)} />}
            </span>
          )}
          <span className="composer-spacer" />
          {(["model", "effort"] as const).map((kind) => (
            <span key={kind} className="status-pick">
              <button type="button" className="icon-btn composer-icon-btn" aria-haspopup="menu" aria-expanded={picking === kind} disabled={stopping}
                aria-label={kind === "model" ? `Model: ${modelText}` : `Reasoning effort: ${effortText}`} title={kind === "model" ? modelText : `Effort: ${effortText}`}
                onClick={() => { commands.close(); setPicking(picking === kind ? null : kind); }}>
                {kind === "model" ? <BoltIcon size={20} /> : <EffortGauge level={effortValue} />}
              </button>
              {picking === kind && <QuickPick slug={slug} ticket={ticket} kind={kind} onClose={() => setPicking(null)}
                onMore={() => setSettingsTab(codex || kind === "model" ? "model" : "effort")} />}
            </span>
          ))}
          {micButton}
          {running && !draft.trim()
            ? <button type="button" className="btn danger send-round" aria-label={stopping ? "Stopping" : `Stop ${agentName}`} disabled={stopping} onPointerDown={keepKeyboard} onMouseDown={keepKeyboard} onClick={stop}><span className="stop-square" aria-hidden /></button>
            : <button type="button" className="btn primary send-round" aria-label={images.uploading ? "Uploading" : "Send"} disabled={!draft.trim() || stopping || images.uploading} onPointerDown={keepKeyboard} onMouseDown={keepKeyboard} onClick={() => send(draft)}>{images.uploading ? <span className="spinner" /> : <ArrowUpIcon size={18} />}</button>}
        </div>
      </div>
      {images.error && <div className="form-error composer-error">{images.error}</div>}
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

/** Effort as a dial, like Codex: the arc fills further for more reasoning; grey when it follows the default. */
const EFFORT_SHARE: Record<string, number> = { low: 0.25, medium: 0.5, high: 0.75, xhigh: 0.88, max: 1, ultra: 1 };
function EffortGauge({ level }: { level: string | null }) {
  const share = level ? EFFORT_SHARE[level] ?? 0.5 : 0.5;
  // A 270° dial open at the bottom; the needle points along the filled part.
  const r = 8, length = 2 * Math.PI * r * 0.75;
  const angle = (135 + 270 * share) * (Math.PI / 180);
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="effort-gauge">
      <circle cx="11" cy="11" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${length} 100`} transform="rotate(135 11 11)" />
      <circle cx="11" cy="11" r={r} fill="none" stroke={level ? "var(--accent)" : "currentColor"} strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${length * share} 100`} transform="rotate(135 11 11)" />
      <line x1="11" y1="11" x2={11 + Math.cos(angle) * 4.5} y2={11 + Math.sin(angle) * 4.5} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="11" cy="11" r="1.6" fill="currentColor" />
    </svg>
  );
}
