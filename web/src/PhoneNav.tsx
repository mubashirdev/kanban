import type { MenuItem } from "./HeaderMenu";
import { useLayer } from "./layers";

/** More: the header menu as a bottom sheet, plus whatever the phone top bar has no room for. */
export function MoreSheet({ items, footer, onClose, label = "More" }: { items: MenuItem[]; footer?: string | null; onClose: () => void; label?: string }) {
  useLayer(onClose);
  return (
    <div className="ms-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ms" role="menu" aria-label={label}>
        <span className="ms-grip" aria-hidden />
        {items.map((it) => (
          <button key={it.label} role="menuitem" className={`ms-item${it.separator ? " sep" : ""}${it.danger ? " danger" : ""}`} title={it.title}
            onClick={() => { onClose(); it.onSelect(); }}>
            {it.icon}<span className="ms-label">{it.label}</span>{it.badge}
          </button>
        ))}
        {footer && <div className="ms-foot muted small">{footer}</div>}
      </div>
    </div>
  );
}
