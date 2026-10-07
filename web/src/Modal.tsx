import { useId, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { CloseIcon } from "./icons";
import { useFocusTrap, useLayer } from "./layers";

/**
 * Dialog with focus trap and Esc (topmost layer only). `guard` = there is typed work to lose:
 * Esc, the × and clicking outside ask before closing.
 */
export function Modal({ title, onClose, children, wide, guard, footer }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  guard?: boolean;
  footer?: ReactNode;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState(false);
  // On phones every dialog slides up from the bottom like an iOS sheet.
  // The finger that opened a sheet (a long press) lifts onto its backdrop: ignore that for a moment.
  const openedAt = useRef(Date.now());
  const tryClose = () => (guard ? setAsking(true) : onClose());
  useLayer(tryClose);
  useFocusTrap(box);
  return (
    <div className="overlay sheet-overlay" onMouseDown={(e) => e.target === e.currentTarget && Date.now() - openedAt.current > 500 && tryClose()}>
      <div ref={box} className={`modal sheet${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
        <header className="modal-head">
          <h3 id={id}>{title}</h3>
          <button className="icon-btn" onClick={tryClose} aria-label="Close"><CloseIcon /></button>
        </header>
        {children}
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
      {asking && (
        <ConfirmDialog title="Discard draft?" confirmLabel="Discard" onCancel={() => setAsking(false)} onConfirm={onClose}>
          <p>What you typed here will be lost.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
