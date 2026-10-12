// Cleanup: once a task's purpose is served, the screenshots, recordings and traces it made go to the Trash (never
// deleted for good), and so do copies of a project folder whose work is merged. Three triggers: a ticket moving to Done
// (Board.updateTicket), a Claude Code or Codex chat ending (`ckanban clean --hook`, a SessionEnd hook), and a daily
// sweep for chats that never end (startCleanupSweeper). Only scratch places are touched; see isScratch.
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { codexRolloutFile } from "./codex-session";
import { run as git, worktreeDir } from "./git";
import type { Store } from "./store";

/** Screenshots, recordings and traces. */
const MEDIA = /(\.(png|jpe?g|webp|gif|webm|mp4|mov)|trace[^/]*\.zip)$/i;
/** Folders browser tools and test runners fill with throwaway files. */
const SCRATCH_DIRS = [".playwright-mcp", "output", "test-results", "playwright-report"];
/** The daily sweep leaves files younger than this: the chat that made them may still need them. */
export const SWEEP_AGE_MS = 3 * 24 * 3600_000;
/** A folder copy touched this recently may still be in use. */
const COPY_IDLE_MS = 24 * 3600_000;

// $HOME first: tests (and sandboxes) point it elsewhere.
const home = () => process.env.HOME || homedir();
const tmpRoots = () => [...new Set(["/tmp", "/private/tmp", tmpdir(), realpath(tmpdir())])];
/** The user's own files: never touched, even inside a folder named like a scratch one. */
const personal = () => ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Library", ".Trash"].map((d) => join(home(), d));

function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** A screenshot, recording or trace in a temp folder or a scratch folder of a project. */
export function isScratch(path: string): boolean {
  if (!isAbsolute(path) || !MEDIA.test(path)) return false;
  if (personal().some((d) => inside(path, d))) return false;
  if (tmpRoots().some((d) => inside(path, d))) return true;
  return path.split(sep).some((part) => SCRATCH_DIRS.includes(part));
}

/** Moves a file or folder to the Trash; a name already there gets a number. Returns false if it couldn't. */
export function trash(path: string, trashDir = join(home(), ".Trash")): boolean {
  if (!existsSync(path)) return false;
  const ext = lstatSync(path).isDirectory() ? "" : extname(path);
  const stem = basename(path, ext);
  let target = join(trashDir, basename(path));
  for (let n = 2; existsSync(target); n++) target = join(trashDir, `${stem} ${n}${ext}`);
  try {
    renameSync(path, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") return false;
    // Another disk: copy, then remove the original.
    cpSync(path, target, { recursive: true });
    rmSync(path, { recursive: true, force: true });
  }
  return true;
}

/** Screenshot-like paths a transcript mentions: absolute ones, and scratch-folder ones relative to `cwd`. */
export function mentionedPaths(text: string, cwd: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\w.@+~/-])\/(?:[\w.@+~-]+\/)*[\w.@+~-]+\.(?:png|jpe?g|webp|gif|webm|mp4|mov|zip)\b/gi)) out.add(m[0]);
  const rel = new RegExp(`(?<![\\w/.-])(?:${SCRATCH_DIRS.map((d) => d.replace(".", "\\.")).join("|")})/[\\w.@+/-]+\\.(?:png|jpe?g|webp|gif|webm|mp4|mov|zip)\\b`, "gi");
  for (const m of text.matchAll(rel)) out.add(resolve(cwd, m[0]));
  return [...out];
}

/** Files under `dir` (all depths), [] if it's missing. */
function filesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  } catch {
    return [];
  }
}

/** Files git tracks in the repo holding `dir` (absolute paths); empty outside a repo. Tracked files are never moved. */
async function tracked(dir: string, cache: Map<string, Set<string>>): Promise<Set<string>> {
  const top = (await git(["git", "rev-parse", "--show-toplevel"], dir)).stdout.trim();
  if (!top) return new Set();
  if (!cache.has(top)) {
    const r = await git(["git", "ls-files", "-z"], top);
    cache.set(top, new Set(r.stdout.split("\0").filter(Boolean).map((f) => join(top, f))));
  }
  return cache.get(top)!;
}

/** Moves the scratch files among `paths` to the Trash; tracked and missing ones stay. Returns what moved. */
export async function trashScratch(paths: Iterable<string>, opts: { dryRun?: boolean } = {}): Promise<string[]> {
  const moved: string[] = [];
  const cache = new Map<string, Set<string>>();
  for (const p of new Set([...paths].map(realpath))) {
    if (!isScratch(p) || !existsSync(p) || !statSync(p).isFile()) continue;
    if ((await tracked(dirname(p), cache)).has(p)) continue;
    if (opts.dryRun || trash(p)) moved.push(p);
  }
  return moved;
}

/** First timestamp in a Claude or Codex transcript (ms), or null. */
function startedAt(text: string): number | null {
  const m = text.slice(0, 20_000).match(/"timestamp":"([^"]+)"/);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * A chat ended: what its transcripts mention, plus browser-tool files its folder got while it ran (the browser tool
 * saves some files without naming them in the chat).
 */
export async function cleanChat(transcripts: string[], cwd: string, opts: { dryRun?: boolean } = {}): Promise<string[]> {
  const paths: string[] = [];
  let since = Infinity;
  for (const file of transcripts) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    paths.push(...mentionedPaths(text, cwd));
    since = Math.min(since, startedAt(text) ?? Infinity);
  }
  if (Number.isFinite(since)) {
    paths.push(...filesIn(join(cwd, ".playwright-mcp")).filter((f) => MEDIA.test(f) && statSync(f).mtimeMs >= since));
  }
  return trashScratch(paths, opts);
}

/** A board ticket is done: the screenshots in its Outputs (its reports stay) and the scratch files its chats made. */
export async function cleanTicket(outputsDir: string, transcripts: string[], cwd: string, opts: { dryRun?: boolean } = {}): Promise<string[]> {
  const outputs = filesIn(outputsDir).filter((f) => MEDIA.test(f));
  const moved = opts.dryRun ? outputs : outputs.filter((f) => trash(f));
  return [...moved, ...(await cleanChat(transcripts, cwd, opts))];
}

/** Scratch files older than `ageMs` in the temp folders and in each root's scratch folders (root and one level down). */
export async function sweepScratch(roots: string[], ageMs = SWEEP_AGE_MS, opts: { dryRun?: boolean; now?: number; tmp?: string[] } = {}): Promise<string[]> {
  const cutoff = (opts.now ?? Date.now()) - ageMs;
  const dirs = new Set<string>();
  for (const root of roots) {
    for (const base of [root, ...subdirs(root)]) for (const name of SCRATCH_DIRS) dirs.add(join(base, name));
  }
  const candidates = [...dirs].flatMap(filesIn);
  // Temp folders: only their top two levels; deeper ones belong to running programs.
  for (const t of opts.tmp ?? tmpRoots()) for (const base of [t, ...subdirs(t)]) candidates.push(...shallowFiles(base));
  const old = candidates.filter((f) => MEDIA.test(f) && mtime(f) < cutoff);
  return trashScratch(old, opts);
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

function shallowFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

function mtime(f: string): number {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return Infinity;
  }
}

/** Why a folder copy (git worktree) must stay, or null when its purpose is served: work merged, nothing unsaved, idle. */
export async function copyKeepReason(dir: string, now = Date.now()): Promise<string | null> {
  // Its last commit or checkout (git status rewrites the index, so the index's time says nothing).
  const log = (await git(["git", "rev-parse", "--path-format=absolute", "--git-path", "logs/HEAD"], dir)).stdout.trim();
  if (log && now - mtime(log) < COPY_IDLE_MS) return "used in the last day";
  const status = await git(["git", "--no-optional-locks", "status", "--porcelain"], dir);
  if (status.code !== 0) return "not a working copy";
  const changes = status.stdout.split("\n").filter(Boolean).filter((l) => !SCRATCH_DIRS.some((d) => l.slice(3).startsWith(d + "/")));
  if (changes.length) return "has unsaved changes";
  for (const base of ["main", "master", "dev", "develop"]) {
    const r = await git(["git", "merge-base", "--is-ancestor", "HEAD", `origin/${base}`], dir);
    if (r.code === 0) return null;
  }
  // Squash-merged: the branch was pushed, then deleted on the remote after its pull request merged.
  const branch = (await git(["git", "branch", "--show-current"], dir)).stdout.trim();
  if (branch) {
    const track = (await git(["git", "for-each-ref", "--format=%(upstream:track)", `refs/heads/${branch}`], dir)).stdout.trim();
    if (track === "[gone]") return null;
  }
  return "work not merged";
}

/**
 * Folder copies of the repos holding `roots` whose purpose is served go to the Trash, then git forgets them.
 * `skip`: folders someone else manages (the board's own ticket copies).
 */
export async function sweepCopies(roots: string[], skip: string[] = [], opts: { dryRun?: boolean; now?: number } = {}): Promise<string[]> {
  const repos = new Set<string>();
  for (const root of roots) {
    const common = (await git(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], root)).stdout.trim();
    if (common) repos.add(dirname(common));
  }
  const moved: string[] = [];
  for (const repo of repos) {
    const list = await git(["git", "worktree", "list", "--porcelain"], repo);
    const copies = list.stdout.split("\n\n").map((b) => ({ dir: b.match(/^worktree (.+)$/m)?.[1], locked: /^locked/m.test(b) }))
      .filter((w) => w.dir && w.dir !== repo && !w.locked && existsSync(w.dir));
    let changed = false;
    for (const { dir } of copies) {
      // Only copies kept next to the repo by hand; other apps (Conductor, Superset, the board) manage their own.
      if (!inside(dir!, dirname(repo)) || dir!.slice(dirname(repo).length).includes(`${sep}.`)) continue;
      if (skip.some((s) => inside(realpath(dir!), realpath(s)))) continue;
      if (await copyKeepReason(dir!, opts.now)) continue;
      if (opts.dryRun || trash(dir!)) {
        moved.push(dir!);
        changed = true;
      }
    }
    if (changed && !opts.dryRun) await git(["git", "worktree", "prune"], repo);
  }
  return moved;
}

/** Folders recent Claude Code and Codex chats ran in (last 30 days): where their leftovers are. */
export function recentChatFolders(now = Date.now()): string[] {
  const since = now - 30 * 24 * 3600_000;
  const out = new Set<string>();
  const claude = join(process.env.CLAUDE_CONFIG_DIR ?? join(home(), ".claude"), "projects");
  for (const dir of subdirs(claude)) {
    for (const f of shallowFiles(dir)) if (f.endsWith(".jsonl") && mtime(f) >= since) addCwd(out, f, /"cwd":"([^"]+)"/);
  }
  const codex = join(process.env.CODEX_HOME ?? join(home(), ".codex"), "sessions");
  for (const f of filesIn(codex)) if (f.endsWith(".jsonl") && mtime(f) >= since) addCwd(out, f, /"cwd":"([^"]+)"/);
  return [...out].filter((d) => existsSync(d) && d !== home());
}

function addCwd(out: Set<string>, file: string, re: RegExp) {
  try {
    const head = readFileSync(file, "utf8").slice(0, 50_000);
    const m = head.match(re);
    if (m) out.add(m[1]);
  } catch {}
}

/** The SessionEnd hook payload of Claude Code or Codex: which transcript, which folder. */
export interface HookInput {
  transcript_path?: string | null;
  cwd?: string;
  session_id?: string;
}

/**
 * Everything at once (the daily sweep and `ckanban clean`): old scratch files where the board's projects and recent
 * chats live, screenshots in Done tickets' Outputs, and merged folder copies. The board's own ticket copies are left
 * to the board.
 */
export async function sweepAll(store: Store, opts: { dryRun?: boolean; now?: number } = {}): Promise<{ files: string[]; copies: string[] }> {
  const profiles = store.listProfiles();
  const roots = [...new Set([...profiles.map((p) => p.path), ...recentChatFolders(opts.now)])].filter((d) => existsSync(d));
  const files = await sweepScratch(roots, SWEEP_AGE_MS, opts);
  for (const p of profiles) {
    for (const t of store.listTickets(p.slug)) {
      if (t.status === "done") files.push(...(await cleanTicket(store.outputsDir(p.slug, t.id), [], p.path, opts)));
    }
  }
  const skip = profiles.map((p) => dirname(worktreeDir(p, "x")));
  const copies = await sweepCopies(roots, skip, opts);
  return { files, copies };
}

/** Runs sweepAll a minute after the daemon starts, then daily, when the board's cleanup setting is on. */
export function startCleanupSweeper(store: Store, everyMs = 24 * 3600_000): () => void {
  const tick = async () => {
    if (!store.config().cleanup) return;
    try {
      const { files, copies } = await sweepAll(store);
      if (files.length || copies.length) console.log(`cleanup: moved ${files.length} files and ${copies.length} folder copies to the Trash`);
    } catch (e) {
      console.error(`cleanup sweep failed: ${(e as Error).message}`);
    }
  };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, everyMs);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

/**
 * `ckanban clean --hook`: a Claude Code or Codex SessionEnd hook. Board runs are skipped (the board cleans when their
 * ticket is done; each reply is its own process, so its end isn't the chat's end).
 */
export async function cleanFromHook(input: HookInput, env = process.env): Promise<string[]> {
  if (env.CKANBAN_TICKET || !input.cwd) return [];
  const transcript = input.transcript_path || (input.session_id ? codexRolloutFile(input.session_id) : null);
  return transcript ? cleanChat([transcript], input.cwd) : [];
}
