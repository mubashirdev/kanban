import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { api, type ClaudeCommand } from "./api";
import { useLayer, useFocusTrap } from "./layers";

export function slashToken(text: string, caret: number): { query: string; start: number; end: number } | null {
  const match = /^([ \t]*)\/([\w:./@-]*)/.exec(text);
  if (!match) return null;
  const start = match[1].length, end = match[0].length;
  return caret > start && caret <= end ? { query: match[2], start, end } : null;
}

export function useSlashCommands({ slug, id, draft, setDraft, composer }: {
  slug: string; id: string; draft: string; setDraft: (text: string) => void; composer: RefObject<HTMLTextAreaElement>;
}) {
  const listId = useId();
  const [token, setToken] = useState<ReturnType<typeof slashToken>>(null);
  const [manual, setManual] = useState(false);
  const [search, setSearch] = useState("");
  const [commands, setCommands] = useState<ClaudeCommand[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [active, setActive] = useState(0);
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const opened = manual || !!token;
  const query = (manual ? search : token?.query ?? "").toLowerCase();
  const score = (command: ClaudeCommand) => command.name.toLowerCase() === query ? 0 : command.name.toLowerCase().startsWith(query) ? 1 : command.aliases.some((name) => name.toLowerCase() === query) ? 2 : command.name.toLowerCase().includes(query) ? 3 : 4;
  const matches = (commands ?? []).filter((command) => !query ||
    [command.name, ...command.aliases].some((name) => name.toLowerCase().includes(query)) || command.description.toLowerCase().includes(query))
    .sort((a, b) => query ? score(a) - score(b) : 0);
  const close = () => {
    if (popup.current?.contains(document.activeElement)) composer.current?.focus({ preventScroll: true });
    setToken(null); setManual(false);
  };
  useLayer(close, { active: opened });
  useFocusTrap(popup, false, opened && manual);
  useLayoutEffect(() => {
    if (!opened) return;
    const place = () => {
      const rect = composer.current?.closest(".composer")?.getBoundingClientRect();
      if (!rect) return;
      const top = window.visualViewport?.offsetTop ?? 0;
      const width = Math.min(rect.width, innerWidth - 16);
      setPosition({ left: Math.max(8, Math.min(rect.left, innerWidth - width - 8)), width, bottom: innerHeight - rect.top + 8, maxHeight: Math.max(80, rect.top - top - 16) });
    };
    place();
    const observer = new ResizeObserver(place);
    if (composer.current) observer.observe(composer.current);
    const panel = composer.current?.closest(".panel");
    panel?.addEventListener("animationend", place);
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => { observer.disconnect(); panel?.removeEventListener("animationend", place); window.removeEventListener("resize", place); window.visualViewport?.removeEventListener("resize", place); window.visualViewport?.removeEventListener("scroll", place); };
  }, [opened, draft]);

  useEffect(() => { setCommands(null); setError(""); close(); }, [slug, id]);
  useEffect(() => {
    if (!opened || commands && !refresh) return;
    let cancelled = false;
    setLoading(true); setError("");
    api.commands(slug, id, refresh > 0).then((result) => { if (!cancelled) { setCommands(result.commands); setRefresh(0); } }, (failure) => {
      if (!cancelled) setError(failure.message);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [opened, slug, id, refresh, commands]);
  useEffect(() => { setActive(0); }, [query, commands]);
  useEffect(() => {
    if (!opened) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popup.current?.contains(target) && target !== composer.current && !(target instanceof Element && target.closest(".slash-trigger"))) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [opened]);

  const pick = (command: ClaudeCommand) => {
    const current = token ?? slashToken(draft, composer.current?.selectionStart ?? draft.length);
    const prefix = `/${command.name} `;
    const before = current ? draft.slice(0, current.start) : "";
    const after = current ? draft.slice(current.end).replace(/^[ \t]+/, "") : draft;
    setDraft(`${before}${prefix}${after}`);
    close();
    requestAnimationFrame(() => { composer.current?.focus(); composer.current?.setSelectionRange(before.length + prefix.length, before.length + prefix.length); });
  };
  const keyDown = (event: KeyboardEvent): boolean => {
    if (!opened || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return true; }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && matches.length) {
      event.preventDefault(); event.stopPropagation();
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
      requestAnimationFrame(() => popup.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
      return true;
    }
    if ((event.key === "Enter" && !event.shiftKey || event.key === "Tab" && !event.shiftKey) && matches.length && !loading && !error) {
      event.preventDefault(); event.stopPropagation(); pick(matches[active] ?? matches[0]); return true;
    }
    // Never send an unfinished slash query while command discovery is still loading.
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); return true; }
    return false;
  };
  const popupElement = opened ? createPortal(<div className="slash-popup" ref={popup} style={position}>
    <div className="slash-heading"><b>Claude commands</b><span>{commands?.length ?? ""}</span>
      <button type="button" className="link-btn small" disabled={loading} onClick={() => setRefresh((value) => value + 1)} aria-label="Reload Claude commands">Reload</button>
      <button type="button" className="icon-btn" onClick={close} aria-label="Close command menu">×</button>
    </div>
    {manual && <input className="slash-search" aria-label="Search Claude commands" placeholder="Search commands and skills…" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={keyDown} autoFocus />}
    {loading ? <div className="slash-status" role="status"><span className="spinner" /> Loading commands…</div> : error ? <div className="slash-status" role="alert">{error}<button className="link-btn" onClick={() => setRefresh((value) => value + 1)}>Try again</button></div> :
      <div className="slash-list" role="listbox" id={listId} aria-label="Claude commands">
        {matches.map((command, index) => <button type="button" role="option" id={`${listId}-${index}`} aria-selected={active === index} key={command.name}
          className="slash-option" onPointerDown={(event) => { if (event.pointerType === "mouse") event.preventDefault(); }} onClick={() => pick(command)} onPointerMove={(event) => { if (event.pointerType === "mouse") setActive(index); }}>
          <span className="slash-name">/{command.name}<span>{command.argumentHint}</span></span>
          <span className="slash-description">{command.description || "Run this Claude command"}</span>
        </button>)}
        {!matches.length && <div className="slash-status" role="status">{query ? `No commands match “${query}”.` : "No commands available in this folder."}</div>}
      </div>}
    <div className="slash-help">Choose to insert · Add arguments, then Send</div>
  </div>, document.body) : null;
  return {
    popup: popupElement, keyDown, close,
    select: (text: string, caret: number) => { setManual(false); setToken(slashToken(text, caret)); },
    toggle: () => { if (opened) close(); else { setSearch(""); setManual(true); } },
    opened,
    aria: { "aria-expanded": opened, "aria-controls": opened && !loading && !error ? listId : undefined, "aria-activedescendant": opened && matches.length && !loading && !error ? `${listId}-${active}` : undefined, "aria-autocomplete": "list" as const },
  };
}
