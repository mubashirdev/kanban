import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Profile, SessionEntry } from "../../api";
import { ConfirmDialog } from "../../ConfirmDialog";
import { Modal } from "../../Modal";
import { sessionLabel } from "../../SessionPicker";
import { fullTime, timeAgo } from "../../time";
import { Markdown } from "../../Transcript";
import { usePersistentState } from "../../usePersistentState";
import { AgentMark } from "../codex/AgentPicker";
import { terminalApi, type TerminalSession } from "./api";

const SHOWN = 5;
const LIST_POLL_MS = 15_000;
const LIVE_POLL_MS = 5_000;

const isTool = (e: SessionEntry) => e.kind === "tool" || e.kind === "agent";
const folderName = (cwd: string) => cwd.split("/").filter(Boolean).at(-1) ?? cwd;

/** Chats: the Claude sessions the user started in a terminal on this Mac, in any folder. Read one, then continue it here. */
export function OnThisMac({ profile, onOpenChat }: { profile: Profile; onOpenChat: (id: string) => void }) {
  const [expanded, setExpanded] = usePersistentState("muba.onThisMac", () => true, (v) => v, (v) => typeof v === "boolean");
  const [showAll, setShowAll] = useState(false);
  const [list, setList] = useState<TerminalSession[] | null>(null);
  const [error, setError] = useState("");
  const [readingId, setReadingId] = useState<string | null>(null);

  // Polled while shown and the page is visible, so a session started in a terminal shows up within seconds.
  useEffect(() => {
    if (!expanded) return;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      terminalApi.list(profile.slug).then((l) => { setList(l); setError(""); }, (e) => setError(e.message));
    };
    load();
    const timer = setInterval(load, LIST_POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [expanded, profile.slug]);

  const shown = showAll ? list ?? [] : (list ?? []).slice(0, SHOWN);
  const reading = list?.find((s) => s.id === readingId) ?? null;
  return (
    <section className="on-this-mac" aria-label="On this Mac">
      <button type="button" className="on-this-mac-head" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className="on-this-mac-chev" aria-hidden>{expanded ? "▾" : "▸"}</span>On this Mac
      </button>
      {expanded && (
        <>
          {error && <p className="chat-list-empty">{error}</p>}
          {!error && list === null && <p className="chat-list-empty">Loading…</p>}
          {list?.length === 0 && <p className="chat-list-empty">No Claude sessions from a terminal yet.</p>}
          {shown.length > 0 && (
            <ul>
              {shown.map((s) => <li key={s.id}><TerminalRow session={s} onOpen={() => setReadingId(s.id)} /></li>)}
            </ul>
          )}
          {!showAll && list && list.length > SHOWN && (
            <button type="button" className="link-btn small on-this-mac-more" onClick={() => setShowAll(true)}>Show all {list.length}</button>
          )}
        </>
      )}
      {reading && (
        <TerminalSessionDialog profile={profile} session={reading} onClose={() => setReadingId(null)}
          onOpenChat={(id) => { setReadingId(null); onOpenChat(id); }} />
      )}
    </section>
  );
}

function TerminalRow({ session: s, onOpen }: { session: TerminalSession; onOpen: () => void }) {
  const folder = folderName(s.cwd);
  return (
    <button type="button" className={`chat-row${s.needsYou ? " waiting" : s.live ? " running" : ""}`} onClick={onOpen} title={s.cwd}
      aria-label={`${sessionLabel(s)}, Claude in ${folder}${s.needsYou ? ", needs you" : s.live ? ", open in terminal" : ""}`}>
      <AgentMark agent="claude" />
      <span className="chat-row-main">
        <span className="chat-row-top">
          <span className="chat-row-title">{sessionLabel(s)}</span>
          <time className="chat-row-time" dateTime={s.lastActive}>{timeAgo(s.lastActive)}</time>
        </span>
        <span className="chat-row-preview">
          {s.needsYou ? <b>Needs you · </b> : s.live ? <><span className="live-dot" /> Open in terminal · </> : null}
          {folder}
        </span>
      </span>
    </button>
  );
}

type Page = { entries: SessionEntry[]; start: number };

/** One terminal session, read-only, newest messages at the bottom; Continue here turns it into a chat. */
function TerminalSessionDialog({ profile, session: s, onClose, onOpenChat }: {
  profile: Profile; session: TerminalSession; onClose: () => void; onOpenChat: (id: string) => void;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const keep = useRef<number | null>(null);

  // The newest page; while it's open in a terminal it is reloaded so the phone follows along.
  useEffect(() => {
    const load = () => terminalApi.conversation(s.id).then((r) => {
      setError("");
      // Keep earlier pages the user already loaded.
      setPage((prev) => (prev && prev.start < r.start ? { entries: [...prev.entries.slice(0, r.start - prev.start), ...r.entries], start: prev.start } : r));
    }, (e) => setError(e.message));
    load();
    if (!s.live) return;
    const timer = setInterval(load, LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [s.id, s.live]);

  useLayoutEffect(() => {
    const el = log.current;
    if (!el) return;
    if (keep.current !== null) {
      el.scrollTop = el.scrollHeight - keep.current;
      keep.current = null;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [page]);

  const earlier = async () => {
    if (!page || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const r = await terminalApi.conversation(s.id, page.start);
      keep.current = log.current ? log.current.scrollHeight - log.current.scrollTop : null;
      setPage({ entries: [...r.entries, ...page.entries], start: r.start });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingEarlier(false);
    }
  };

  const continueHere = async () => {
    const t = await terminalApi.continueHere(profile.slug, s.id);
    onOpenChat(t.id);
  };
  const onContinue = () => {
    if (s.ticket) return onOpenChat(s.ticket.id);
    if (s.live) return setConfirming(true);
    setContinuing(true);
    continueHere().catch((e) => setError(e.message)).finally(() => setContinuing(false));
  };

  // Tool calls in a row fold into one line, like in a chat.
  const blocks: SessionEntry[][] = [];
  for (const e of page?.entries ?? []) {
    const prev = blocks.at(-1);
    if (isTool(e) && prev && isTool(prev[0])) prev.push(e);
    else blocks.push([e]);
  }

  return (
    <Modal title={sessionLabel(s)} onClose={onClose} wide>
      <div className="form">
        <p className="muted small terminal-session-meta" title={s.cwd}>
          <AgentMark agent="claude" /> Claude in <b>{folderName(s.cwd)}</b> · {timeAgo(s.lastActive)}
          {s.needsYou ? <> · <b className="warn">needs you in the terminal</b></> : s.live ? <> · <span className="live-dot" /> open in terminal</> : null}
        </p>
        <div className="conversation terminal-session-log" ref={log} onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}>
          {page && page.start > 0 && (
            <button className="btn ghost small load-earlier" onClick={earlier} disabled={loadingEarlier}>{loadingEarlier ? "Loading…" : "Load earlier messages"}</button>
          )}
          {!page && !error && <p className="muted">Loading…</p>}
          {page?.entries.length === 0 && <p className="muted">No messages yet.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          {blocks.map((b) => isTool(b[0]) ? (
            <details key={b[0].uuid} className="conv-tools">
              <summary>{b.length === 1 ? b[0].text : `${b.length} tool calls · ${b.at(-1)!.text}`}</summary>
              <ul className="terminal-session-tools">{b.map((e) => <li key={e.uuid}>{e.text}</li>)}</ul>
            </details>
          ) : (
            <div key={b[0].uuid} className={`conv-msg ${b[0].role}`}>
              <div className="conv-head">
                <b>{b[0].role === "user" ? "You" : "Claude"}</b>
                {b[0].at && <time className="muted small" dateTime={b[0].at} title={fullTime(b[0].at)}>{timeAgo(b[0].at)}</time>}
              </div>
              {b[0].text && <Markdown text={b[0].text} />}
            </div>
          ))}
        </div>
        <div className="form-actions terminal-session-actions">
          <span className="muted small">{s.ticket ? "Already a chat on this board." : "Read-only until you continue it here."}</span>
          <button className="btn primary" onClick={onContinue} disabled={continuing}>{continuing ? "Opening…" : s.ticket ? "Open chat" : "Continue here"}</button>
        </div>
      </div>
      {confirming && (
        <ConfirmDialog title="Still open in a terminal" confirmLabel="Continue here anyway" busyLabel="Opening…" tone="primary"
          onCancel={() => setConfirming(false)} onConfirm={continueHere}>
          <p>This session is still open in a terminal on your Mac. If you keep using both, they write to the same conversation and each misses what the other said.</p>
          <p>For a clean handover, close it there first (Ctrl+D or /exit).</p>
        </ConfirmDialog>
      )}
    </Modal>
  );
}
