import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanChat, cleanFromHook, cleanTicket, copyKeepReason, isScratch, mentionedPaths, sweepCopies, sweepScratch, trash } from "../src/server/cleanup";
import { run } from "../src/server/git";
import { makeRepo, tempDir } from "./helpers";

let home: string;
const oldHome = process.env.HOME;
const trashed = () => readdirSync(join(home, ".Trash")).sort();

beforeEach(() => {
  home = tempDir("ck-home-");
  mkdirSync(join(home, ".Trash"));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = oldHome;
});

const file = (path: string, ageMs = 0) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  if (ageMs) utimesSync(path, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  return path;
};

test("only screenshots, recordings and traces in temp or scratch folders count, never the user's own folders", () => {
  expect(isScratch("/tmp/shot.png")).toBe(true);
  expect(isScratch("/repo/.playwright-mcp/page.jpeg")).toBe(true);
  expect(isScratch("/repo/output/run/trace-1.zip")).toBe(true);
  expect(isScratch("/repo/test-results/video.webm")).toBe(true);
  expect(isScratch("/repo/src/logo.png")).toBe(false);
  expect(isScratch("/tmp/notes.md")).toBe(false);
  expect(isScratch(join(home, "Desktop", "output", "photo.png"))).toBe(false);
  expect(isScratch("relative/output/a.png")).toBe(false);
});

test("paths a transcript mentions: absolute ones and scratch-folder ones relative to the chat's folder", () => {
  const text = JSON.stringify({ a: "saved /tmp/x/shot.png and .playwright-mcp/page-1.png", b: "see output/run/v.webm, not src/a.png" });
  expect(mentionedPaths(text, "/repo").sort()).toEqual(["/repo/.playwright-mcp/page-1.png", "/repo/output/run/v.webm", "/tmp/x/shot.png"]);
});

test("trash numbers a name that is already there", () => {
  const dir = tempDir("ck-t-");
  trash(file(join(dir, "a.png")));
  trash(file(join(dir, "a.png")));
  expect(trashed()).toEqual(["a 2.png", "a.png"]);
});

test("a chat ending trashes what it mentioned and browser files made while it ran, not older or tracked ones", async () => {
  const repo = await makeRepo();
  const tmp = tempDir("ck-shots-");
  const mentioned = file(join(tmp, "shot.png"));
  const older = file(join(repo, ".playwright-mcp", "old.png"), 3600_000);
  const fresh = file(join(repo, ".playwright-mcp", "new.png"));
  const kept = file(join(repo, "output", "logo.png"));
  await run(["git", "add", "-f", "output/logo.png"], repo);
  const transcript = file(join(tmp, "chat.jsonl"));
  writeFileSync(transcript, [
    JSON.stringify({ timestamp: new Date(Date.now() - 60_000).toISOString(), text: `look at ${mentioned}` }),
    JSON.stringify({ text: "and output/logo.png" }),
  ].join("\n"));
  const moved = await cleanChat([transcript], repo);
  expect(moved.sort()).toEqual([fresh, mentioned].sort());
  expect(existsSync(older) && existsSync(kept)).toBe(true);
  expect(trashed()).toEqual(["new.png", "shot.png"]);
});

test("a done ticket's Outputs lose their screenshots and keep their reports", async () => {
  const out = tempDir("ck-out-");
  file(join(out, "home.png"));
  file(join(out, "huddles", "h_1", "qa", "form.png"));
  const report = file(join(out, "report.md"));
  expect((await cleanTicket(out, [], out)).length).toBe(2);
  expect(existsSync(report)).toBe(true);
});

test("the daily sweep takes scratch files older than its age only", async () => {
  const repo = tempDir("ck-proj-");
  const old = file(join(repo, "app", "test-results", "a.png"), 4 * 24 * 3600_000);
  const fresh = file(join(repo, "app", "test-results", "b.png"));
  expect(await sweepScratch([repo], undefined, { tmp: [] })).toEqual([old]);
  expect(existsSync(fresh)).toBe(true);
});

test("a folder copy goes once its work is merged and nothing is unsaved; others stay with a reason", async () => {
  const repo = await makeRepo();
  await run(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], repo);
  const parent = join(repo, "..");
  const merged = join(parent, `${repo.split("/").pop()}-merged`);
  const open = join(parent, `${repo.split("/").pop()}-open`);
  const dirty = join(parent, `${repo.split("/").pop()}-dirty`);
  await run(["git", "worktree", "add", "-q", "-b", "done", merged], repo);
  await run(["git", "worktree", "add", "-q", "-b", "open", open], repo);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "wip"], open);
  await run(["git", "worktree", "add", "-q", "-b", "dirty", dirty], repo);
  writeFileSync(join(dirty, "README.md"), "changed\n");
  file(join(merged, "output", "shot.png"));

  const later = Date.now() + 2 * 24 * 3600_000;
  expect(await copyKeepReason(merged)).toBe("used in the last day");
  expect(await copyKeepReason(open, later)).toBe("work not merged");
  expect(await copyKeepReason(dirty, later)).toBe("has unsaved changes");
  expect(await sweepCopies([repo], [], { now: later })).toEqual([merged]);
  expect(existsSync(merged)).toBe(false);
  expect((await run(["git", "worktree", "list"], repo)).stdout).not.toContain("-merged");
});

test("the chat-end hook skips board runs and needs a folder", async () => {
  const tmp = tempDir("ck-hook-");
  const shot = file(join(tmp, "s.png"));
  const transcript = file(join(tmp, "t.jsonl"));
  writeFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), text: shot }));
  expect(await cleanFromHook({ transcript_path: transcript, cwd: tmp }, { CKANBAN_TICKET: "p/t_1" })).toEqual([]);
  expect(await cleanFromHook({ transcript_path: transcript }, {})).toEqual([]);
  expect(await cleanFromHook({ transcript_path: transcript, cwd: tmp }, {})).toEqual([shot]);
});
