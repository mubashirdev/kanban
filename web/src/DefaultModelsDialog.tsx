import { useEffect, useState } from "react";
import { api, type ClaudeModel } from "./api";
import { Modal } from "./Modal";
import { Select } from "./Select";

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

interface CodexModel { value: string; displayName: string; efforts: string[] }

export function DefaultModelsDialog({ onClose }: { onClose: () => void }) {
  const [claudeModel, setClaudeModel] = useState("");
  const [claudeEffort, setClaudeEffort] = useState("");
  const [codexModel, setCodexModel] = useState("");
  const [codexEffort, setCodexEffort] = useState("");
  const [claudeModels, setClaudeModels] = useState<ClaudeModel[]>([]);
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.settings().then((s) => {
      setClaudeModel(s.claudeModel ?? "");
      setClaudeEffort(s.claudeEffort ?? "");
      setCodexModel(s.codexModel ?? "");
      setCodexEffort(s.codexEffort ?? "");
      setLoaded(true);
    }).catch((e) => setError((e as Error).message));
    api.claudeModels().then(setClaudeModels).catch(() => {});
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

  const claudeOptions = [
    { value: "", label: "Claude default", hint: "follows ~/.claude/settings.json" },
    ...claudeModels.map((m) => ({ value: m.value, label: m.displayName, hint: m.description })),
  ];
  // A saved model the live list doesn't know (older config) stays selectable.
  if (claudeModel && !claudeOptions.some((o) => o.value === claudeModel)) claudeOptions.push({ value: claudeModel, label: claudeModel, hint: "" });
  const codexOptions = [
    { value: "", label: "Codex default", hint: "follows ~/.codex/config.toml" },
    ...codexModels.map((m) => ({ value: m.value, label: m.displayName, hint: m.value })),
  ];
  if (codexModel && !codexOptions.some((o) => o.value === codexModel)) codexOptions.push({ value: codexModel, label: codexModel, hint: "" });

  const efforts = (levels: string[]) => [{ value: "", label: "Auto effort", hint: "" }, ...levels.map((e) => ({ value: e, label: e, hint: "" }))];
  const claudeEfforts = claudeModels.find((m) => m.value === claudeModel)?.supportedEffortLevels ?? CLAUDE_EFFORTS;
  const codexEfforts = codexModels.find((m) => m.value === codexModel)?.efforts ?? CODEX_EFFORTS;

  return (
    <Modal title="Default models" onClose={onClose}>
      <div className="form">
        <p className="muted small">Used for every board and ticket that doesn’t pick its own. A board’s own Claude model or a ticket’s own choice still wins.</p>
        <label>
          Claude model
          <Select ariaLabel="Default Claude model" value={claudeModel} onChange={setClaudeModel} options={claudeOptions} />
        </label>
        <label>
          Claude effort
          <Select ariaLabel="Default Claude effort" value={claudeEffort} onChange={setClaudeEffort} options={efforts(claudeEfforts)} />
        </label>
        <label>
          Codex model
          <Select ariaLabel="Default Codex model" value={codexModel} onChange={setCodexModel} options={codexOptions} />
        </label>
        <label>
          Codex effort
          <Select ariaLabel="Default Codex effort" value={codexEffort} onChange={setCodexEffort} options={efforts(codexEfforts)} />
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
