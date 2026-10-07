import { useState } from "react";
import { api, safeHref, type GitState, type Ticket } from "./api";
import { ExternalIcon } from "./icons";
import { toast } from "./toast";

const agentOf = (t: Ticket) => (t.agent === "codex" ? "Codex" : "Claude");

/** Commit, push and open a PR from the phone, like the desktop apps' Git bar. */
export function GitBar({ slug, ticket, git, onDone, onError }: {
  slug: string; ticket: Ticket; git: GitState; onDone: () => void; onError: (m: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const agent = agentOf(ticket);
  const running = !!ticket.running;
  const act = async (label: string, run: () => Promise<unknown>, done: string) => {
    setBusy(label);
    try {
      await run();
      toast(done, { tone: "ok" });
      onDone();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(null);
    }
  };
  const askAgent = () => act("ask", () => api.chat(slug, ticket.id,
    "Commit the current changes with a short conventional commit message that says why. Don't push."), `Asked ${agent} to commit.`);
  const onBase = git.branch === git.base;
  const canPush = !!git.branch && git.dirty === 0 && !!git.ahead;

  return (
    <section className="review-section git-bar" aria-label="Git">
      <p className="git-status">
        <span className="git-branch">{git.branch ?? "detached HEAD"}</span>
        <span className="muted">
          {[git.dirty ? `${git.dirty} uncommitted ${git.dirty === 1 ? "file" : "files"}` : "nothing to commit",
            git.ahead ? `${git.ahead} ${git.ahead === 1 ? "commit" : "commits"} to push` : null]
            .filter(Boolean).join(", ")}
        </span>
      </p>
      {git.dirty > 0 && (
        <form className="git-commit" onSubmit={(e) => { e.preventDefault(); if (message.trim()) void act("commit", () => api.gitAction(slug, ticket.id, "commit", message), "Committed."); }}>
          <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message" aria-label="Commit message" maxLength={500} disabled={!!busy || running} />
          <button className="btn primary" disabled={!message.trim() || !!busy || running}>{busy === "commit" ? "Committing…" : "Commit all"}</button>
          <button type="button" className="link-btn small" disabled={!!busy || running} onClick={askAgent}>Let {agent} write the message and commit</button>
        </form>
      )}
      <div className="git-actions">
        {canPush && (
          <button className="btn" disabled={!!busy || running} onClick={() => act("push", () => api.gitAction(slug, ticket.id, "push"), `Pushed ${git.branch}.`)}>
            {busy === "push" ? "Pushing…" : "Push"}
          </button>
        )}
        {ticket.prUrl ? (
          <a className="btn icon-label" href={safeHref(ticket.prUrl)} target="_blank" rel="noreferrer">Open pull request <ExternalIcon /></a>
        ) : !onBase && git.branch && git.dirty === 0 && git.ahead === 0 && git.upstream && (
          <button className="btn" disabled={!!busy || running} onClick={() => act("pr", () => api.gitAction(slug, ticket.id, "pr"), "Pull request created.")}>
            {busy === "pr" ? "Creating…" : `Create pull request into ${git.base}`}
          </button>
        )}
      </div>
      {running && <p className="muted small">Git actions wait until {agent} has finished.</p>}
    </section>
  );
}

/** One diff line: its number in the new file (null for removed lines and headers). */
function numbered(diff: string) {
  let next = 0;
  return diff.split("\n").map((text) => {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) { next = Number(hunk[1]); return { text, kind: "hunk", line: null as number | null }; }
    if (/^(\+\+\+|---|diff |index |new file|deleted file|similarity|rename )/.test(text)) return { text, kind: "meta", line: null };
    if (text.startsWith("+")) return { text, kind: "add", line: next++ };
    if (text.startsWith("-")) return { text, kind: "remove", line: null };
    return { text, kind: "context", line: text ? next++ : null };
  });
}

/** A file's diff; tap a line to leave a comment the agent then acts on, like the desktop apps' inline review. */
export function DiffView({ slug, ticket, file, diff }: { slug: string; ticket: Ticket; file: string; diff: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  // Git's header lines (diff --git, index, ---/+++) say nothing the file picker doesn't.
  const lines = numbered(diff).filter((l) => l.kind !== "meta");
  const send = async (i: number) => {
    const target = lines[i];
    setSending(true);
    try {
      const where = target.line ? `${file}:${target.line}` : file;
      await api.chat(slug, ticket.id, `Comment on \`${where}\`:\n\`\`\`\n${target.text}\n\`\`\`\n${note.trim()}`);
      toast(`Sent to ${agentOf(ticket)}.`, { tone: "ok" });
      setOpen(null);
      setNote("");
    } catch (e: any) {
      toast(e.message, { tone: "error" });
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="diff-view" aria-label={`Diff of ${file}`}>
      {lines.map((l, i) => (
        <div key={i}>
          <button type="button" className={`diff-line diff-${l.kind}${open === i ? " selected" : ""}`} disabled={l.kind === "meta"}
            onClick={() => { setOpen(open === i ? null : i); setNote(""); }} aria-label={l.line ? `Comment on line ${l.line}` : "Comment on this line"}>
            <span className="diff-num" aria-hidden>{l.line ?? ""}</span>
            <code>{l.text || " "}</code>
          </button>
          {open === i && (
            <form className="diff-comment" onSubmit={(e) => { e.preventDefault(); if (note.trim()) void send(i); }}>
              <textarea autoFocus rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={`Tell ${agentOf(ticket)} what to change here…`} aria-label="Comment" />
              <div className="diff-comment-actions">
                <button type="button" className="btn ghost small" onClick={() => setOpen(null)}>Cancel</button>
                <button className="btn primary small" disabled={!note.trim() || sending}>{sending ? "Sending…" : `Send to ${agentOf(ticket)}`}</button>
              </div>
            </form>
          )}
        </div>
      ))}
    </div>
  );
}
