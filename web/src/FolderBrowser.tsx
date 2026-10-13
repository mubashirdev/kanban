import { useEffect, useState } from "react";
import { api, type FolderList } from "./api";
import { ChevronLeftIcon, ChevronRightIcon, FolderIcon } from "./icons";
import { Modal } from "./Modal";

/** `/Users/me/dev` reads as `~/dev` when inside the browser's start folder. */
const shortPath = (path: string, root: string, rootLabel: string) =>
  path === root ? rootLabel : path.startsWith(`${root}/`) ? `${rootLabel}/${path.slice(root.length + 1)}` : path;

/**
 * Tap through folders on the Mac, from a phone too (the Finder picker only opens on the Mac's screen).
 * Starts at the home folder, or at a board's folder with `profile` (and never goes above it).
 */
export function FolderBrowser({ title, profile, start, onPick, onClose }: {
  title: string;
  profile?: string;
  /** Open here if it is inside the allowed area; otherwise at the start. */
  start?: string;
  /** root: the real path of the start folder, for paths relative to it. */
  onPick: (path: string, root: string) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<FolderList | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootLabel = profile ? "Board folder" : "~";

  const open = (path: string | null) => {
    setError(null);
    api.folders(path, { profile, hidden }).then(setList, (e) => {
      // A typed start that doesn't exist (or is outside) just opens at the start.
      if (path && !list) open(null);
      else setError(e.message);
    });
  };
  useEffect(() => open(list?.path ?? start ?? null), [hidden]);

  return (
    <Modal title={title} onClose={onClose}
      footer={
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!list} onClick={() => list && onPick(list.path, list.root)}>Use this folder</button>
        </div>
      }>
      <div className="form folder-browser">
        <div className="folder-head">
          <button type="button" className="icon-btn folder-up" disabled={!list?.parent} aria-label="Up one folder" onClick={() => open(list!.parent)}>
            <ChevronLeftIcon />
          </button>
          <span className="folder-current" title={list?.path}>{list ? shortPath(list.path, list.root, rootLabel) : "Loading…"}</span>
        </div>
        <div className="picker-list folder-list" role="list" aria-label="Folders">
          {list && !list.folders.length && <div className="picker-empty">No folders inside. Tap Use this folder to pick this one.</div>}
          {list?.folders.map((f) => (
            <button type="button" key={f.path} role="listitem" className="folder-row" onClick={() => open(f.path)}>
              <FolderIcon /><span className="picker-name">{f.name}</span><ChevronRightIcon />
            </button>
          ))}
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <label className="folder-hidden">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> Show hidden folders
        </label>
      </div>
    </Modal>
  );
}
