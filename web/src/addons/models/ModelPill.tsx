import { useEffect, useRef, useState } from "react";
import type { Ticket } from "../../api";
import { CheckIcon } from "../../icons";
import { useLayer } from "../../layers";
import { toast } from "../../toast";
import { agentOf } from "../codex/api";
import { CLAUDE_EFFORTS, CODEX_EFFORTS, EFFORT_LABEL, modelsApi, type BoardDefaults, type ModelOption, type ModelTicket } from "./api";

type Kind = "model" | "effort";

/** Short text for a model or effort before the model list has loaded: "opus" shows "Opus". */
const label = (value: string) => EFFORT_LABEL[value] ?? value.charAt(0).toUpperCase() + value.slice(1);

/**
 * The "Opus 5.5 · High" pill in the message box, like the Claude app: tap the model or the effort to change it for
 * this ticket's next turns. `slash` handles /model and /effort typed in the box (true: it was one of them).
 */
export function useModelPill(slug: string, ticket: Ticket, onError: (m: string) => void) {
  const codex = agentOf(ticket) === "codex";
  const t = ticket as ModelTicket;
  const [picking, setPicking] = useState<Kind | null>(null);
  // null while the list loads.
  const [list, setList] = useState<ModelOption[] | null>(null);
  const models = list ?? [];
  const [defaults, setDefaults] = useState<BoardDefaults | null>(null);

  useEffect(() => {
    (codex ? modelsApi.codexModels() : modelsApi.claudeModels()).then(setList, () => setList([]));
  }, [codex]);
  // Board defaults may change in board settings: read them again whenever a picker opens.
  useEffect(() => { modelsApi.boardDefaults(slug).then(setDefaults, () => {}); }, [slug, picking]);

  const own = { model: (codex ? t.codexModel : t.model) ?? null, effort: (codex ? t.codexEffort : t.effort) ?? null };
  const model = own.model ?? (codex ? defaults?.codexModel : defaults?.claudeModel) ?? null;
  const efforts = (model ? models.find((m) => m.value === model)?.efforts : null) ?? (codex ? CODEX_EFFORTS : CLAUDE_EFFORTS);
  const savedEffort = own.effort ?? (codex ? defaults?.codexEffort : defaults?.claudeEffort) ?? null;
  // A model that doesn't support the saved effort runs on its own: the pill says Auto, like the run does.
  const effort = savedEffort && efforts.includes(savedEffort) ? savedEffort : null;
  const modelText = model ? models.find((m) => m.value === model)?.displayName ?? label(model) : "Default";
  const effortText = effort ? label(effort) : "Auto";

  const save = async (kind: Kind, value: string | null) => {
    const key = kind === "model" ? (codex ? "codexModel" : "model") : (codex ? "codexEffort" : "effort");
    await modelsApi.setTicket(ticket.id, { [key]: value });
  };

  const slash = (text: string): boolean => {
    const m = /^\/(model|effort)(?:\s+(\S+))?\s*$/.exec(text.trim());
    if (!m) return false;
    const [, kind, arg] = m as unknown as [string, Kind, string | undefined];
    // "/model sonnet" stays Leo's board command for Claude; Codex and a bare command open the picker.
    if (kind === "model" && arg && !codex) return false;
    if (!arg || codex) {
      setPicking(codex ? "model" : kind);
      return true;
    }
    const value = arg.toLowerCase();
    if (value !== "auto" && !efforts.includes(value)) {
      onError(`"${arg}" is not an effort level here. Use ${efforts.join(", ")} or auto.`);
      return true;
    }
    save("effort", value === "auto" ? null : value).then(
      () => toast(value === "auto" ? "Effort: Auto" : `Effort: ${label(value)}`, { tone: "ok" }),
      (e) => onError(e.message),
    );
    return true;
  };

  const pill = (disabled: boolean) => (
    <span className="model-pill">
      {(["model", "effort"] as const).map((kind) => (
        <span key={kind} className="model-pick">
          <button type="button" className={`model-pill-part ${kind}`} aria-haspopup="menu" aria-expanded={picking === kind} disabled={disabled}
            title={disabled ? "Change it when the reply is done" : undefined}
            aria-label={kind === "model" ? `Model: ${modelText}` : `Effort: ${effortText}`}
            onClick={() => setPicking(picking === kind ? null : kind)}>
            {kind === "model" ? <><span className="model-name">{modelText}</span><span className="model-name-short">{modelText.split(" ")[0]}</span></> : effortText}
          </button>
          {picking === kind && (
            <QuickPick kind={kind} codex={codex} current={own[kind]} loading={kind === "model" && !list} options={kind === "model" ? models : efforts.map((e) => ({ value: e, displayName: label(e), efforts: null }))}
              defaultLabel={defaultLabel(kind, codex, defaults, models)}
              onChoose={(value) => save(kind, value).then(() => setPicking(null), (e) => onError(e.message))}
              onClose={() => setPicking(null)} />
          )}
        </span>
      ))}
    </span>
  );

  return { pill, slash };
}

/** The first row: no choice of its own, so the board's default (or the agent's own) applies. */
function defaultLabel(kind: Kind, codex: boolean, defaults: BoardDefaults | null, models: ModelOption[]): string {
  const value = kind === "model" ? (codex ? defaults?.codexModel : defaults?.claudeModel) : (codex ? defaults?.codexEffort : defaults?.claudeEffort);
  if (!value) return kind === "effort" ? "Auto" : codex ? "Codex default" : "Claude default";
  const name = kind === "model" ? models.find((m) => m.value === value)?.displayName ?? label(value) : label(value);
  return `Board default (${name})`;
}

/** The list that opens above a part of the pill: the current choice is checked, one tap (or 1-9) switches. */
function QuickPick({ kind, codex, current, loading, options, defaultLabel, onChoose, onClose }: {
  kind: Kind; codex: boolean; loading: boolean; current: string | null; options: ModelOption[]; defaultLabel: string;
  onChoose: (value: string | null) => void; onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayer(onClose);
  const rows = [{ value: null as string | null, label: defaultLabel }, ...options.map((o) => ({ value: o.value as string | null, label: o.displayName }))];

  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!root.current?.parentElement?.contains(e.target as Node)) onClose(); };
    const keys = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= Math.min(9, rows.length) && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); onChoose(rows[n - 1].value); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keys);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", keys); };
  }, [rows.length]);

  return (
    <div className="quick-pick" role="menu" aria-label={kind === "model" ? `${codex ? "Codex" : "Claude"} model` : "Effort"} ref={root}>
      {loading && <p className="quick-pick-status" role="status"><span className="spinner" /> Loading models…</p>}
      {rows.map((o, i) => (
        <button key={o.value ?? "default"} type="button" role="menuitemradio" aria-checked={o.value === current} className="quick-pick-item" onClick={() => onChoose(o.value)}>
          <span className="quick-pick-label">{o.label}</span>
          {o.value === current ? <CheckIcon size={16} className="icon quick-pick-check" /> : i < 9 && <span className="quick-pick-key" aria-hidden>{i + 1}</span>}
        </button>
      ))}
      <p className="quick-pick-status">Applies from the next message.</p>
    </div>
  );
}
