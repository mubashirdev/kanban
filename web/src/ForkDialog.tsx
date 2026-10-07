import { useEffect, useState } from "react";
import { api, type ClaudeModel, type Ticket } from "./api";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { toast } from "./toast";

/** Copies a Claude chat into a new one, optionally on another model and with a first message (to compare answers). */
export function ForkDialog({ slug, ticket, onClose, onForked }: {
  slug: string; ticket: Ticket; onClose: () => void; onForked: (id: string) => void;
}) {
  const [models, setModels] = useState<ClaudeModel[]>([]);
  const [model, setModel] = useState("");
  const [text, setText] = useState("");
  const [lastMessage, setLastMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.claudeModels().then(setModels).catch(() => {});
    api.conversation(slug, ticket.id)
      .then((r) => setLastMessage(r.entries.findLast((e) => e.role === "user" && e.kind === "text" && !e.peer)?.text ?? ""))
      .catch(() => {});
  }, [slug, ticket.id]);

  const options = [
    { value: "", label: "Same model", hint: "" },
    ...models.filter((m) => m.value !== "default").map((m) => ({ value: m.value, label: m.displayName, hint: m.description })),
  ];

  const fork = async () => {
    setBusy(true);
    try {
      const copy = await api.fork(slug, ticket.id, { ...(model ? { model } : {}), ...(text.trim() ? { text: text.trim() } : {}) });
      onForked(copy.id);
      onClose();
    } catch (e: any) {
      toast(e.message, { tone: "error" });
      setBusy(false);
    }
  };

  return (
    <Modal title="Fork chat" onClose={onClose}>
      <div className="form fork-form">
        <p className="muted small">Starts a copy of this conversation. This chat stays as it is, so you can try another model or another direction side by side.</p>
        <label>
          Model for the copy
          <Select ariaLabel="Model for the copy" value={model} onChange={setModel} options={options} />
        </label>
        <label>
          First message (optional)
          <textarea rows={3} value={text} disabled={busy} placeholder="Leave empty to open the copy without asking anything" onChange={(e) => setText(e.target.value)} />
        </label>
        {lastMessage && !text && (
          <button type="button" className="link-btn small fork-repeat" onClick={() => setText(lastMessage)}>Repeat my last message</button>
        )}
        <div className="form-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={fork}>{busy ? "Forking…" : text.trim() ? "Fork and send" : "Fork"}</button>
        </div>
      </div>
    </Modal>
  );
}
