import { useEffect, useState } from "react";
import { api, type ClaudeModel } from "./api";
import { Modal } from "./Modal";

export function ModelPicker({ slug, id, current, onClose, onSaved }: {
  slug: string; id: string; current: string | null; onClose: () => void; onSaved: (model: string | null) => void;
}) {
  const [models, setModels] = useState<ClaudeModel[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setError(""); setModels(null);
    api.commands(slug, id, retry > 0).then((catalog) => { if (!cancelled) setModels(catalog.models ?? []); }, (failure) => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [slug, id, retry]);
  const select = async (model: string | null) => {
    if (saving) return;
    setSaving(true); setError("");
    try { await api.setModel(slug, id, model); onSaved(model); }
    catch (failure: any) { setError(failure.message); setSaving(false); }
  };
  const options: ClaudeModel[] = [{ value: "", displayName: "Board default", description: "Use this board’s model setting" }, ...(models ?? [])];
  return <Modal title="Choose Claude model" onClose={saving ? () => {} : onClose}>
    <div className="model-picker">
      <p className="muted">Applies to this ticket’s next reply or run. Your current reply continues on its existing model.</p>
      {error && <div className="form-error" role="alert">{error} <button className="link-btn" disabled={saving} onClick={() => setRetry((n) => n + 1)}>Try again</button></div>}
      {!models && !error ? <p role="status"><span className="spinner" /> Loading available models…</p> : <div className="model-options" role="listbox" aria-label="Claude models" aria-busy={saving}>
        {options.map((model) => <button type="button" role="option" key={model.value} aria-selected={(current ?? "") === model.value} disabled={saving} onClick={() => select(model.value || null)}>
          <span><b>{model.displayName}</b><small>{model.description}</small></span><span aria-hidden="true">{(current ?? "") === model.value ? "✓" : ""}</span>
        </button>)}
      </div>}
      <p className="muted small">Other tickets and your Claude defaults stay unchanged.</p>
    </div>
  </Modal>;
}
