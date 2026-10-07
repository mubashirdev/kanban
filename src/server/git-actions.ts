import { run } from "./git";

/** Where a ticket or session stands in git, for the Changes pane's commit / push / PR buttons. */
export interface GitState {
  branch: string | null;
  /** Uncommitted files (staged, unstaged and untracked). */
  dirty: number;
  /** Commits not on the remote yet (against the base branch when it was never pushed); null when unknown. */
  ahead: number | null;
  /** The branch tracks a remote branch (it was pushed). */
  upstream: boolean;
}

export async function gitState(cwd: string, base: string): Promise<GitState> {
  const branch = await run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
  const status = await run(["git", "status", "--porcelain"], cwd);
  // A branch not pushed yet counts what it adds on top of the base branch.
  let ahead = await run(["git", "rev-list", "--count", "@{upstream}..HEAD"], cwd);
  const upstream = ahead.code === 0;
  if (!upstream) ahead = await run(["git", "rev-list", "--count", `origin/${base}..HEAD`], cwd);
  return {
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    dirty: status.code === 0 ? status.stdout.split("\n").filter(Boolean).length : 0,
    ahead: ahead.code === 0 ? Number(ahead.stdout.trim()) : null,
    upstream,
  };
}

const failure = (what: string, r: { stderr: string; stdout: string }) =>
  new Error(`${what} failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || "no details"}`);

export async function commitAll(cwd: string, message: string): Promise<void> {
  const add = await run(["git", "add", "-A"], cwd);
  if (add.code !== 0) throw failure("git add", add);
  const commit = await run(["git", "commit", "-m", message], cwd);
  if (commit.code !== 0) throw failure("Commit", commit);
}

export async function pushBranch(cwd: string): Promise<void> {
  const push = await run(["git", "push", "-u", "origin", "HEAD"], cwd);
  if (push.code !== 0) throw failure("Push", push);
}

/** Opens a PR for the current branch with gh, filled from its commits. Returns the PR URL. */
export async function createPr(cwd: string, base: string): Promise<string> {
  const pr = await run(["gh", "pr", "create", "--fill", "--base", base], cwd);
  if (pr.code !== 0) {
    // gh refuses a second PR for the branch and names the existing one: use that.
    const existing = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(pr.stderr)?.[0];
    if (existing) return existing;
    throw failure("Creating the pull request", pr);
  }
  const url = /https:\/\/\S+\/pull\/\d+/.exec(pr.stdout)?.[0];
  if (!url) throw new Error("gh did not return a pull request URL");
  return url;
}

const fileLists = new Map<string, { at: number; files: string[] }>();

/** Repo files for @ mentions (tracked and new, ignored ones left out), best matches first. */
export async function searchFiles(cwd: string, query: string, limit = 20): Promise<string[]> {
  let cached = fileLists.get(cwd);
  if (!cached || Date.now() - cached.at > 30_000) {
    const r = await run(["git", "ls-files", "--cached", "--others", "--exclude-standard"], cwd);
    if (r.code !== 0) return [];
    cached = { at: Date.now(), files: r.stdout.split("\n").filter(Boolean) };
    if (fileLists.size >= 20) fileLists.delete(fileLists.keys().next().value!);
    fileLists.set(cwd, cached);
  }
  const q = query.toLowerCase();
  const rank = (path: string) => {
    const lower = path.toLowerCase(), name = lower.slice(lower.lastIndexOf("/") + 1);
    return name.startsWith(q) ? 0 : name.includes(q) ? 1 : lower.includes(q) ? 2 : 3;
  };
  return cached.files
    .map((path) => ({ path, score: rank(path) }))
    .filter((f) => f.score < 3)
    .sort((a, b) => a.score - b.score || a.path.length - b.path.length)
    .slice(0, limit)
    .map((f) => f.path);
}
