import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

export interface FolderList {
  /** The real path shown; the browser never goes above `root`. */
  path: string;
  root: string;
  /** null at the root. */
  parent: string | null;
  folders: { name: string; path: string }[];
}

export class FolderError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * The folders in `path` (default: `root`), for the in-page folder browser that works from a phone.
 * Stays inside `root`: `..` is refused and symlinks are followed before the check, so nothing escapes it.
 */
export function listFolders(root: string, path: string | null, showHidden = false): FolderList {
  const realRoot = realpathSync(root);
  const asked = path?.trim() || root;
  if (!isAbsolute(asked)) throw new FolderError(400, "path must be absolute");
  if (asked.split("/").includes("..")) throw new FolderError(400, "path may not contain ..");
  let real: string;
  try {
    real = realpathSync(asked);
  } catch {
    throw new FolderError(404, "That folder no longer exists");
  }
  if (!inside(real, realRoot)) throw new FolderError(403, "That folder is outside the allowed area");
  if (!statSync(real).isDirectory()) throw new FolderError(400, "That is not a folder");
  let entries;
  try {
    entries = readdirSync(real, { withFileTypes: true });
  } catch {
    throw new FolderError(403, "This folder can't be opened (no permission)");
  }
  // Symlinks are skipped, not followed: a link could lead outside the root.
  const folders = entries
    .filter((e) => e.isDirectory() && (showHidden || !e.name.startsWith(".")))
    .map((e) => ({ name: e.name, path: join(real, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { path: real, root: realRoot, parent: real === realRoot ? null : dirname(real), folders };
}

/** Where a ticket works when it has no worktree or linked folder: the board folder, or a chat's subfolder of it. */
export function ticketFolder(boardPath: string, t: { subdir?: string | null }): string {
  return t.subdir ? join(boardPath, t.subdir) : boardPath;
}

/** A new chat's subfolder from the request: an existing folder inside the board folder, stored relative to it. */
export function chatSubdir(boardPath: string, subdir: unknown): string | undefined {
  if (subdir === undefined || subdir === null || subdir === "") return undefined;
  if (typeof subdir !== "string" || isAbsolute(subdir) || subdir.split("/").includes("..")) {
    throw new FolderError(400, "subdir must be a folder path inside the board folder");
  }
  const dir = listFolders(boardPath, join(boardPath, subdir)).path;
  return relative(realpathSync(boardPath), dir) || undefined;
}
