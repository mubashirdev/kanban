import { useEffect, useId, useState, type KeyboardEvent, type RefObject } from "react";
import { api } from "./api";

/** The "@query" being typed right before the caret, if any. */
export function mentionToken(text: string, caret: number): { query: string; start: number } | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return match ? { query: match[2], start: caret - match[2].length - 1 } : null;
}

/** "@" in the composer lists repo files, like the desktop apps; picking one puts "@path " in the message. */
export function useFileMentions({ slug, id, draft, setDraft, composer }: {
  slug: string; id: string; draft: string; setDraft: (text: string) => void; composer: RefObject<HTMLTextAreaElement>;
}) {
  const listId = useId();
  const [token, setToken] = useState<ReturnType<typeof mentionToken>>(null);
  const [caret, setCaret] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!token) return setFiles([]);
    let cancelled = false;
    const timer = setTimeout(() => {
      api.searchFiles(slug, id, token.query).then((found) => { if (!cancelled) { setFiles(found); setActive(0); } }, () => {});
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [slug, id, token?.query]);

  const open = !!token && files.length > 0;
  const close = () => setToken(null);
  const pick = (path: string) => {
    if (!token) return;
    const before = draft.slice(0, token.start) + `@${path} `;
    setDraft(before + draft.slice(caret));
    close();
    requestAnimationFrame(() => {
      composer.current?.focus({ preventScroll: true });
      composer.current?.setSelectionRange(before.length, before.length);
    });
  };
  const keyDown = (event: KeyboardEvent): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i + (event.key === "ArrowDown" ? 1 : -1) + files.length) % files.length);
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) { event.preventDefault(); pick(files[active]); return true; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return true; }
    return false;
  };
  const popup = open ? (
    <div className="mention-popup" role="listbox" id={listId} aria-label="Files in this repo">
      {files.map((path, i) => {
        const slash = path.lastIndexOf("/");
        return (
          <button type="button" role="option" key={path} aria-selected={i === active} className="mention-option"
            onPointerDown={(e) => e.preventDefault()} onClick={() => pick(path)}>
            <span className="mention-name">{path.slice(slash + 1)}</span>
            {slash > 0 && <span className="mention-dir">{path.slice(0, slash)}</span>}
          </button>
        );
      })}
    </div>
  ) : null;
  return {
    popup, keyDown, close, open,
    select: (text: string, at: number) => { setCaret(at); setToken(mentionToken(text, at)); },
  };
}
