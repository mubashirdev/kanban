import { useEffect, useState } from "react";
import { api } from "./api";
import { Modal } from "./Modal";
import { Select } from "./Select";

const CLAUDE_MODELS = ["opus", "sonnet", "haiku"];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

export function DefaultModelsDialog({ onClose }: { onClose: () => void }) {
  const [claudeModel, setClaudeModel] = useState("");
  const [codexModel, setCodexModel] = useState("");
  const [claudeEffort, setClaudeEffort] = useState("");
  const [codexEffort, setCodexEffort] = useState("");
  const [codexModels, setCodexModels] = useState<{ value: string; displayName: string; efforts: string[] }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.settings().then((s) => {
      setClaudeModel(s.claudeModel ?? "");
      setCodexModel(s.codexModel ?? "");
      setClaudeEffort(s.claudeEffort ?? "");
      setCodexEffort(s.codexEffort ?? "");
      setLoaded(true);
    }).catch((e) => setError((e as Error).message));
    api.codexModels().then(setCodexModels).catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    try {
      await api.updateSettings({ claudeModel: claudeModel || null, codexModel: codexModel || null, claudeEffort: claudeEffort || null, codexEffort: codexEffort || null });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  const effortOptions = (efforts: string[], label: string) => [{ value: "", label }, ...efforts.map((e) => ({ value: e, label: e }))];
  const codexEfforts = codexModels.find((m) => m.value === codexModel)?.efforts ?? CODEX_EFFORTS;
  const withCurrent = (models: string[], current: string) => (current && !models.includes(current) ? [...models, current] : models);

  return (
    <Modal title="Default models" onClose={onClose}>
      <div className="form">
        <p className="muted small">Used for every board and ticket that doesn’t pick its own. A board’s own Claude model or a ticket’s own choice still wins.</p>
        <label>
          Claude
          <Select
            ariaLabel="Default Claude model"
            value={claudeModel}
            onChange={setClaudeModel}
            options={[
              { value: "", label: "Claude default", hint: "follows ~/.claude/settings.json" },
              ...withCurrent(CLAUDE_MODELS, claudeModel).map((m) => ({ value: m, label: m })),
            ]}
          />
        </label>
        <label>
          Claude effort
          <Select ariaLabel="Default Claude effort" value={claudeEffort} onChange={setClaudeEffort} options={effortOptions(CLAUDE_EFFORTS, "Auto effort")} />
        </label>
        <label>
          Codex
          <Select
            ariaLabel="Default Codex model"
            value={codexModel}
            onChange={setCodexModel}
            options={[
              { value: "", label: "Codex default", hint: "follows ~/.codex/config.toml" },
              ...withCurrent(codexModels.map((m) => m.value), codexModel).map((value) => ({
                value, label: codexModels.find((m) => m.value === value)?.displayName ?? value,
              })),
            ]}
          />
        </label>
        <label>
          Codex effort
          <Select ariaLabel="Default Codex effort" value={codexEffort} onChange={setCodexEffort} options={effortOptions(codexEfforts, "Auto effort")} />
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
