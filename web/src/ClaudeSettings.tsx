import { useEffect, useId, useState } from "react";
import { api, type ClaudeCatalog, type Effort, type Ticket } from "./api";
import { Modal } from "./Modal";

const effortDescriptions: Record<Effort, string> = {
  low: "Quick exchanges and simple changes",
  medium: "Everyday work with a clear scope",
  high: "Careful reasoning and verification",
  xhigh: "Deeper reasoning for complex work",
  max: "The most intensive reasoning available",
};
const effortNames: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" };
export type SettingKind = "model" | "effort" | "outputStyle";
export function ClaudeSettings({ slug, ticket, initialTab, onClose, onSaved }: {
  slug: string; ticket: Ticket; initialTab: SettingKind; onClose: () => void;
  onSaved: (kind: SettingKind, value: string | null) => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const panelId = useId();
  const [catalog, setCatalog] = useState<ClaudeCatalog | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState(ticket.model ?? null);
  const [effort, setEffort] = useState(ticket.effort ?? null);
  const [outputStyle, setOutputStyle] = useState(ticket.outputStyle ?? null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setError(""); setCatalog(null);
    api.commands(slug, ticket.id, retry > 0).then((result) => { if (!cancelled) setCatalog(result); }, (failure) => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [slug, ticket.id, retry]);
  const select = async (value: string | null) => {
    if (saving) return;
    setSaving(true); setError(""); setSaved(false);
    try {
      if (tab === "model") { await api.setModel(slug, ticket.id, value); setModel(value); }
      else if (tab === "effort") { await api.setEffort(slug, ticket.id, value as Effort | null); setEffort(value as Effort | null); }
      else { await api.setOutputStyle(slug, ticket.id, value); setOutputStyle(value); }
      setSaved(true);
      onSaved(tab, value);
    } catch (failure: any) { setError(failure.message); }
    finally { setSaving(false); }
  };
  const modelMetadata = catalog?.models.find((item) => item.value === (model ?? catalog.defaultModel ?? "default"));
  const hasCapabilities = catalog?.models.some((item) => item.supportsEffort !== undefined);
  const levels = (catalog?.efforts ?? []).filter((level) => !hasCapabilities || !modelMetadata || modelMetadata.supportsEffort && (!modelMetadata.supportedEffortLevels || modelMetadata.supportedEffortLevels.includes(level)));
  const current = tab === "model" ? model : tab === "effort" ? effort : outputStyle;
  const options = tab === "model" ? [{ value: "", displayName: "Board default", description: "Use this board’s model setting" }, ...(catalog?.models ?? [])] : tab === "effort" ?
    [{ value: "", displayName: "Auto", description: "Use Claude’s configured default" }, ...levels.map((value) => ({ value, displayName: effortNames[value], description: effortDescriptions[value] }))] :
    [{ value: "", displayName: "Claude default", description: "Use Claude’s configured response style" }, ...(catalog?.outputStyles ?? []).map((value) => ({ value, displayName: value, description: "Installed Claude output style" }))];
  const tabs = ["model", "effort", "outputStyle"] as const;
  return <Modal title="Claude settings" onClose={saving ? () => {} : onClose}>
    <div className="claude-settings">
      <p className="muted">For this ticket’s next reply or run. An active reply keeps its current settings.</p>
      <div className="settings-summary"><span>Model <b>{model ? modelMetadata?.displayName ?? model : catalog?.defaultModel ? modelMetadata?.displayName ?? catalog.defaultModel : "Board default"}</b></span><span>Effort <b>{effort ? effortNames[effort] : "Auto"}</b></span><span>Output style <b>{outputStyle ?? "Claude default"}</b></span></div>
      <div className="tabs" role="tablist" aria-label="Claude settings" onKeyDown={(event) => {
        if (!saving && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault(); const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1)! : tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
          setTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab=${next}]`)?.focus();
        }
      }}>{tabs.map((name) => <button type="button" key={name} id={`${panelId}-${name}`} data-tab={name} role="tab" aria-selected={tab === name} aria-controls={panelId} tabIndex={tab === name ? 0 : -1} disabled={saving} onClick={() => setTab(name)}>{name === "model" ? "Model" : name === "effort" ? "Effort" : "Output style"}</button>)}</div>
      <div role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${tab}`}>
      {error && <div className="form-error" role="alert">{error} <button className="link-btn" disabled={saving} onClick={() => setRetry((n) => n + 1)}>Try again</button></div>}
      {!catalog && !error ? <p role="status"><span className="spinner" /> Loading available settings…</p> : catalog && <div className="model-options" role="listbox" aria-label={tab === "model" ? "Claude models" : tab === "effort" ? "Claude effort levels" : "Claude output styles"} aria-busy={saving}>
        {options.map((option) => <button type="button" role="option" key={option.value} aria-selected={(current ?? "") === option.value} disabled={saving} onClick={() => select(option.value || null)}>
          <span><b>{option.displayName}</b><small>{option.description}</small></span><span aria-hidden="true">{(current ?? "") === option.value ? "✓" : ""}</span>
        </button>)}
      </div>}
      {tab === "effort" && <p className="muted small">Claude limits effort to what your model and account support. Higher levels can use more tokens.</p>}
      {tab === "effort" && catalog && effort && !levels.includes(effort) && <p className="form-error" role="status">This model does not offer the saved effort level. Choose Auto, or switch models.</p>}
      </div>
      <p className="muted small" role="status">{saving ? "Saving…" : saved ? "Saved for this ticket." : "Choices save immediately for this ticket."}</p>
      <div className="dialog-actions"><button type="button" className="btn primary" disabled={saving} onClick={onClose}>Done</button></div>
    </div>
  </Modal>;
}
