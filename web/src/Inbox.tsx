import { useEffect, useRef, useState } from "react";
import type { InboxItem } from "./api";
import { BellIcon } from "./icons";
import { useLayer } from "./layers";

/** Top-bar "N need you" across every board; the list jumps straight to a ticket. ↑↓ move, Esc closes. */
export function Inbox({ items, onPick, landOnInbox = false }: { items: InboxItem[]; onPick: (i: InboxItem) => void; landOnInbox?: boolean }) {
  const [open, setOpen] = useState(false);
  // Phones open straight onto what is waiting for you, once per browser session.
  useEffect(() => {
    if (!landOnInbox || !items.length) return;
    try {
      if (sessionStorage.getItem("ck-inbox-landed")) return;
      sessionStorage.setItem("ck-inbox-landed", "1");
    } catch { return; }
    setOpen(true);
  }, [landOnInbox, items.length]);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  useLayer(() => {
    setOpen(false);
    pill.current?.focus();
  }, { active: open });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const entries = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
  const focusAt = (i: number) => {
    const list = entries();
    if (list.length) list[(i + list.length) % list.length].focus();
  };
  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = entries();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusAt(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusAt(at < 0 ? -1 : at - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusAt(0); }
    else if (e.key === "End") { e.preventDefault(); focusAt(-1); }
    else if (e.key === "Tab") setOpen(false);
  };

  if (!items.length) return null;
  const boards = [...new Set(items.map((i) => i.profile))];

  return (
    <div className="inbox" ref={root}>
      <button ref={pill} className="inbox-pill" aria-label={`${items.length} need you`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => focusAt(0));
          }
        }}
        title="Tickets on any board where Claude is waiting on you">
        <span className="inbox-text"><span className="yt-dot" aria-hidden /> {items.length} need you</span>
        <span className="inbox-compact" aria-hidden><BellIcon size={20} /><span className="inbox-count">{items.length > 99 ? "99+" : items.length}</span></span>
      </button>
      {open && (
        <div className="inbox-menu" role="menu" ref={menu} onKeyDown={onMenuKey}>
          {boards.map((b) => {
            const group = items.filter((i) => i.profile === b);
            return (
              <div key={b} className="inbox-group" role="group" aria-label={group[0].profileName}>
                <div className="inbox-board" aria-hidden>{group[0].profileName}</div>
                {group.map((i) => (
                  <button key={i.id} role="menuitem" className="inbox-item" onClick={() => { setOpen(false); onPick(i); }}>
                    <span className="inbox-title">{i.title}</span>
                    <span className={`inbox-why att-${i.attention.kind}`}>{i.attention.label}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
