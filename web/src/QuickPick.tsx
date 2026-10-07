import { useEffect, useRef, useState } from "react";
import { api, type Effort, type Ticket } from "./api";
import { CheckIcon } from "./icons";
import { useLayer } from "./layers";

type Option = { value: string | null; label: string; tag?: string };
const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };

/** Short display text for a model or effort chip before the full catalog has loaded. */
export const chipLabel = (value: string | null | undefined, fallback: string) =>
  value ? EFFORT_LABEL[value] ?? value.charAt(0).toUpperCase() + value.slice(1).replace(/^pt-/, "PT-") : fallback;

/**
 * Model or effort list that opens from its chip under the message box, like the Claude app:
 * the current choice is checked, one tap (or 1-9) switches, and "More settings" opens the full dialog.
 */
export function QuickPick({ slug, ticket, kind, onClose, onMore }: {
  slug: string; ticket: Ticket; kind: "model" | "effort"; onClose: () => void; onMore: () => void;
}) {
  const codex = ticket.agent === "codex";
  const root = useRef<HTMLDivElement>(null);
  const [options, setOptions] = useState<Option[] | null>(null);
  const [error, setError] = useState("");
  const current = (kind === "model" ? (codex ? ticket.codexModel : ticket.model) : (codex ? ticket.codexEffort : ticket.effort)) ?? null;
  useLayer(onClose);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<Option[]> => {
      if (codex) {
        const [models, defaults] = await Promise.all([api.codexModels(), api.settings()]);
        const defaultModel = models.find((m) => m.value === defaults.codexModel)?.displayName ?? defaults.codexModel;
        const defaultLabel = defaultModel && kind === "model" ? `Board default (${defaultModel})` : "Codex default";
        if (kind === "model") return [{ value: null, label: defaultLabel, tag: "Default" }, ...models.map((m) => ({ value: m.value, label: m.displayName }))];
        const efforts = models.find((m) => m.value === ticket.codexModel)?.efforts ?? ["low", "medium", "high", "xhigh"];
        return [{ value: null, label: "Codex default", tag: "Default" }, ...efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] ?? e }))];
      }
      const catalog = await api.commands(slug, ticket.id);
      if (kind === "model") {
        const fallback = catalog.models.find((m) => m.value === catalog.defaultModel)?.displayName ?? catalog.defaultModel;
        return [{ value: null, label: fallback ? `Board default (${fallback})` : "Board default", tag: "Default" },
          ...catalog.models.filter((m) => m.value !== "default").map((m) => ({ value: m.value, label: m.displayName }))];
      }
      return [{ value: null, label: "Auto", tag: "Default" }, ...catalog.efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] ?? e }))];
    };
    load().then((o) => { if (!cancelled) setOptions(o); }, (e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [slug, ticket.id, kind, codex]);

  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!root.current?.parentElement?.contains(e.target as Node)) onClose(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);

  const choose = async (value: string | null) => {
    try {
      if (codex) await api.updateTicket(slug, ticket.id, kind === "model" ? { codexModel: value } : { codexEffort: value as Ticket["codexEffort"] });
      else if (kind === "model") await api.setModel(slug, ticket.id, value);
      else await api.setEffort(slug, ticket.id, value as Effort | null);
      onClose();
    } catch (e: any) {
      setError(e.message);
    }
  };

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (options && n >= 1 && n <= Math.min(9, options.length) && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); void choose(options[n - 1].value); }
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, [options]);

  return (
    <div className="quick-pick" role="menu" aria-label={kind === "model" ? "Model" : "Effort"} ref={root}>
      {error && <p className="form-error">{error}</p>}
      {!options && !error && <p className="quick-pick-status" role="status"><span className="spinner" /> Loading…</p>}
      {options?.map((o, i) => (
        <button key={o.value ?? "default"} role="menuitemradio" aria-checked={o.value === current} className="quick-pick-item" onClick={() => choose(o.value)}>
          <span className="quick-pick-label">{o.label}{o.tag && <span className="quick-pick-tag">{o.tag}</span>}</span>
          {o.value === current ? <CheckIcon size={16} className="icon quick-pick-check" /> : i < 9 && <span className="quick-pick-key" aria-hidden>{i + 1}</span>}
        </button>
      ))}
      <div className="menu-sep" />
      <button role="menuitem" className="quick-pick-item" onClick={() => { onClose(); onMore(); }}>More settings…</button>
    </div>
  );
}

const ACCESS_OPTIONS = [
  { value: "read" as const, label: "Read only", hint: "Looks at code and answers, won't change files" },
  { value: "edit" as const, label: "Can edit", hint: "Changes files in this folder" },
];

/** What a chat's agent may do, from the shield in the message box (like Codex's access menu). */
export function AccessPick({ slug, ticket, onClose }: { slug: string; ticket: Ticket; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const current = ticket.access ?? "read";
  useLayer(onClose);
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!root.current?.parentElement?.contains(e.target as Node)) onClose(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const choose = async (access: "read" | "edit") => {
    if (access === current) return onClose();
    try {
      await api.updateTicket(slug, ticket.id, { access });
      onClose();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="quick-pick" role="menu" aria-label="What the agent may do" ref={root}>
      {error && <p className="form-error">{error}</p>}
      {ticket.running && <p className="quick-pick-status">Stop the agent to change this.</p>}
      {ACCESS_OPTIONS.map((o) => (
        <button key={o.value} role="menuitemradio" aria-checked={o.value === current} className="quick-pick-item" disabled={!!ticket.running} onClick={() => choose(o.value)}>
          <span className="quick-pick-label">{o.label}<span className="quick-pick-hint">{o.hint}</span></span>
          {o.value === current && <CheckIcon size={16} className="icon quick-pick-check" />}
        </button>
      ))}
    </div>
  );
}
