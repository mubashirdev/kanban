import { useEffect, useState } from "react";
import { api, type DefaultModels } from "./api";
import { CloseIcon, PlusIcon } from "./icons";
import { Modal } from "./Modal";

/** The chips a chat offers when the agent asks a question, until the user saves their own list. */
export const DEFAULT_QUICK_REPLIES = ["Yes, go ahead", "No", "Tell me more"];

/** Edit the chat's quick replies (Settings, or a long press on a chip). Saving none brings the defaults back. */
export function QuickRepliesDialog({ onClose, onSaved }: { onClose: () => void; onSaved?: (s: DefaultModels) => void }) {
  const [replies, setReplies] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api.settings().then((s) => setReplies(s.quickReplies ?? DEFAULT_QUICK_REPLIES), (e) => setError(e.message));
  }, []);

  const save = async (list: string[] | null) => {
    setBusy(true);
    setError("");
    try {
      const s = await api.updateSettings({ quickReplies: list });
      onSaved?.(s);
      onClose();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Quick replies" onClose={onClose}
      footer={
        <div className="form-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={() => save(null)}>Reset to defaults</button>
          <button type="button" className="btn primary" disabled={busy || !replies} onClick={() => save(replies!)}>{busy ? "Saving…" : "Save"}</button>
        </div>
      }>
      <div className="form quick-replies-form">
        <p className="muted small">One tap sends these when the agent asks you a question. Hold a chip in a chat to come back here.</p>
        {replies?.map((r, i) => (
          <div key={i} className="quick-reply-row">
            <input value={r} maxLength={200} aria-label={`Quick reply ${i + 1}`} autoFocus={i === replies.length - 1 && !r}
              onChange={(e) => setReplies(replies.map((x, j) => (j === i ? e.target.value : x)))} />
            <button type="button" className="icon-btn" aria-label={`Remove "${r}"`} onClick={() => setReplies(replies.filter((_, j) => j !== i))}>
              <CloseIcon />
            </button>
          </div>
        ))}
        {replies && replies.length < 12 && (
          <button type="button" className="btn small quick-reply-add" onClick={() => setReplies([...replies, ""])}>
            <PlusIcon size={14} /> Add a reply
          </button>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
