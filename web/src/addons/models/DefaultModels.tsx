import { useEffect, useState } from "react";
import { Modal } from "../../Modal";
import { Select } from "../../Select";
import { CLAUDE_EFFORTS, CODEX_EFFORTS, EFFORT_LABEL, modelsApi, type BoardDefaults, type ModelOption } from "./api";

/** "Default models…" under the Model field in board settings. Saving also updates that field (it is the same Claude model). */
export function DefaultModelsButton({ slug, onClaudeModel }: { slug: string; onClaudeModel: (model: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="link-btn small default-models-link" onClick={() => setOpen(true)}>Default models and effort for Claude and Codex…</button>
      {open && <DefaultModelsDialog slug={slug} onClose={() => setOpen(false)} onSaved={(d) => { onClaudeModel(d.claudeModel ?? ""); setOpen(false); }} />}
    </>
  );
}

const EMPTY: BoardDefaults = { claudeModel: null, claudeEffort: null, codexModel: null, codexEffort: null };

/** What new tickets and chats on this board use until they pick their own model or effort in the message box. */
function DefaultModelsDialog({ slug, onClose, onSaved }: { slug: string; onClose: () => void; onSaved: (d: BoardDefaults) => void }) {
  const [values, setValues] = useState<BoardDefaults>(EMPTY);
  const [claudeModels, setClaudeModels] = useState<ModelOption[]>([]);
  const [codexModels, setCodexModels] = useState<ModelOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    modelsApi.boardDefaults(slug).then((d) => { setValues(d); setLoaded(true); }, (e) => setError(e.message));
    modelsApi.claudeModels().then(setClaudeModels, () => {});
    modelsApi.codexModels().then(setCodexModels, () => {});
  }, [slug]);

  const set = (key: keyof BoardDefaults) => (value: string) => setValues((v) => ({ ...v, [key]: value || null }));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      onSaved(await modelsApi.setBoardDefaults(slug, values));
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const modelOptions = (models: ModelOption[], current: string | null, fallback: string, hint: string) => [
    { value: "", label: fallback, hint },
    ...models.map((m) => ({ value: m.value, label: m.displayName })),
    // A saved model the list doesn't know (an old one, or the list didn't load) stays selectable.
    ...(current && !models.some((m) => m.value === current) ? [{ value: current, label: current }] : []),
  ];
  const effortOptions = (models: ModelOption[], model: string | null, all: string[]) => [
    { value: "", label: "Auto" },
    ...((model ? models.find((m) => m.value === model)?.efforts : null) ?? all).map((e) => ({ value: e, label: EFFORT_LABEL[e] ?? e })),
  ];

  return (
    <Modal title="Default models" onClose={onClose}>
      <div className="form">
        <p className="muted small">New tickets and chats on this board use these. A ticket or chat that picks its own model or effort in the message box keeps it.</p>
        <label>
          Claude model
          <Select ariaLabel="Default Claude model" value={values.claudeModel ?? ""} onChange={set("claudeModel")}
            options={modelOptions(claudeModels, values.claudeModel, "Claude default", "follows ~/.claude/settings.json")} />
        </label>
        <label>
          Claude effort
          <Select ariaLabel="Default Claude effort" value={values.claudeEffort ?? ""} onChange={set("claudeEffort")} options={effortOptions(claudeModels, values.claudeModel, CLAUDE_EFFORTS)} />
        </label>
        <label>
          Codex model
          <Select ariaLabel="Default Codex model" value={values.codexModel ?? ""} onChange={set("codexModel")}
            options={modelOptions(codexModels, values.codexModel, "Codex default", "follows ~/.codex/config.toml")} />
        </label>
        <label>
          Codex effort
          <Select ariaLabel="Default Codex effort" value={values.codexEffort ?? ""} onChange={set("codexEffort")} options={effortOptions(codexModels, values.codexModel, CODEX_EFFORTS)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!loaded || saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </Modal>
  );
}
