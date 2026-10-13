import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeDefaults, encodeProjectDir, listClaudeProjects } from "../src/server/claude";
import { tempDir } from "./helpers";

function fixture() {
  const home = tempDir("ck-home-");
  const configDir = join(home, ".claude");
  const work = tempDir("ck-work-");
  const older = join(work, "older-app");
  const newer = join(work, "new.app");
  const neverRun = join(work, "never-run");
  for (const d of [older, newer, neverRun]) mkdirSync(d);
  const gone = join(work, "deleted");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    projects: { [older]: {}, [newer]: {}, [neverRun]: {}, [gone]: {}, "/private/tmp/scratch": {} },
  }));
  mkdirSync(join(configDir, "projects", encodeProjectDir(older)), { recursive: true });
  mkdirSync(join(configDir, "projects", encodeProjectDir(newer)), { recursive: true });
  utimesSync(join(configDir, "projects", encodeProjectDir(older)), new Date("2026-01-01"), new Date("2026-01-01"));
  utimesSync(join(configDir, "projects", encodeProjectDir(newer)), new Date("2026-09-01"), new Date("2026-09-01"));
  return { home, configDir, older, newer, neverRun };
}

test("encodeProjectDir matches Claude's folder naming", () => {
  expect(encodeProjectDir("/Users/me/dev/my.app")).toBe("-Users-me-dev-my-app");
});

test("listClaudeProjects: existing dirs, newest session first, tmp excluded", () => {
  const f = fixture();
  const list = listClaudeProjects({ homeDir: f.home, configDir: f.configDir, excludePrefixes: ["/private/tmp/"] });
  expect(list.map((p) => p.path)).toEqual([f.newer, f.older, f.neverRun]);
  expect(list[0].name).toBe("new.app");
  expect(list[0].lastUsed).toBe(new Date("2026-09-01").toISOString());
  expect(list[2].lastUsed).toBeNull();
});

test("listClaudeProjects: missing ~/.claude.json gives empty list", () => {
  expect(listClaudeProjects({ homeDir: tempDir(), configDir: tempDir() })).toEqual([]);
});

test("claudeDefaults reads model from settings.json", () => {
  const configDir = tempDir();
  expect(claudeDefaults({ configDir })).toEqual({ model: null });
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ model: "opus[1m]" }));
  expect(claudeDefaults({ configDir })).toEqual({ model: "opus[1m]" });
  writeFileSync(join(configDir, "settings.json"), "{broken");
  expect(claudeDefaults({ configDir })).toEqual({ model: null });
});

import { listSessions, liveSessionMatch } from "../src/server/claude";

test("listSessions reads titles, first prompt, newest first", () => {
  const configDir = tempDir();
  const project = "/Users/x/dev/app";
  const dir = join(configDir, "projects", encodeProjectDir(project));
  mkdirSync(dir, { recursive: true });
  const a = join(dir, "aaaaaaaa-0000-0000-0000-000000000001.jsonl");
  const b = join(dir, "bbbbbbbb-0000-0000-0000-000000000002.jsonl");
  writeFileSync(a, [
    JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "Base directory for this skill: /x/skills/y" } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "Improve OpenSearch message status" } }),
    JSON.stringify({ type: "custom-title", customTitle: "old name", sessionId: "a" }),
    JSON.stringify({ type: "custom-title", customTitle: "OS improvement planning", sessionId: "a" }),
    "not json",
  ].join("\n"));
  writeFileSync(b, JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Fix the queue" }] } }) + "\n");
  utimesSync(a, new Date("2026-09-01"), new Date("2026-09-01"));
  utimesSync(b, new Date("2026-09-02"), new Date("2026-09-02"));
  const list = listSessions(project, { configDir });
  expect(list.map((s) => s.id)).toEqual(["bbbbbbbb-0000-0000-0000-000000000002", "aaaaaaaa-0000-0000-0000-000000000001"]);
  expect(list[1]).toMatchObject({ title: "OS improvement planning", firstPrompt: "Improve OpenSearch message status" });
  expect(list[0]).toMatchObject({ title: null, firstPrompt: "Fix the queue" });
  expect(listSessions("/nope", { configDir })).toEqual([]);
});

test("liveSessionMatch finds claude processes by id or title", () => {
  const ps = [
    "/usr/bin/zsh",
    "claude --resume OS improvement planning",
    "node /opt/claude/cli.js -r aaaaaaaa-0000-0000-0000-000000000001",
    "vim notes.txt --resume x",
  ];
  expect(liveSessionMatch(ps, { id: "zzz", title: "OS improvement planning" })).toBe(true);
  expect(liveSessionMatch(ps, { id: "aaaaaaaa-0000-0000-0000-000000000001", title: null })).toBe(true);
  expect(liveSessionMatch(ps, { id: "bbbb", title: "Other" })).toBe(false);
  expect(liveSessionMatch(["vim --resume Other"], { id: "bbbb", title: "Other" })).toBe(false);
});

import { isTerminalSession, listTerminalSessions, pendingQuestion, sessionFolder, sessionOrigin } from "../src/server/claude";

test("isTerminalSession keeps only sessions the user started in a terminal", () => {
  expect(isTerminalSession({ entrypoint: "cli", cwd: "/Users/x/travelz" })).toBe(true);
  expect(isTerminalSession({ entrypoint: "sdk-cli", cwd: "/Users/x/travelz" })).toBe(false);
  expect(isTerminalSession({ entrypoint: "sdk-py", cwd: "/Users/x" })).toBe(false);
  expect(isTerminalSession({ entrypoint: "claude-desktop", cwd: "/Users/x" })).toBe(false);
  expect(isTerminalSession({ entrypoint: null, cwd: "/Users/x" })).toBe(false);
  expect(isTerminalSession({ entrypoint: "cli", cwd: null })).toBe(false);
  expect(isTerminalSession({ entrypoint: "cli", cwd: "/Users/x/.claude-kanban/artifact-helper" }, ["/Users/x/.claude-kanban"])).toBe(false);
  expect(isTerminalSession({ entrypoint: "cli", cwd: "/Users/x/.claude-kanban-other" }, ["/Users/x/.claude-kanban"])).toBe(true);
});

test("sessionOrigin reads entrypoint and folder from the first lines", () => {
  const head = [
    JSON.stringify({ type: "file-history-snapshot" }),
    JSON.stringify({ type: "user", cwd: "/Users/x/my \"app\"", entrypoint: "cli", message: { role: "user", content: "hi" } }),
  ].join("\n");
  expect(sessionOrigin(head)).toEqual({ entrypoint: "cli", cwd: "/Users/x/my \"app\"" });
  expect(sessionOrigin("")).toEqual({ entrypoint: null, cwd: null });
});

test("pendingQuestion: an unanswered AskUserQuestion or plan approval", () => {
  const use = (id: string, name: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: {} }] } });
  const result = (id: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  expect(pendingQuestion([use("a", "AskUserQuestion")].join("\n"))).toBe(true);
  expect(pendingQuestion([use("a", "AskUserQuestion"), result("a")].join("\n"))).toBe(false);
  expect(pendingQuestion([use("p", "ExitPlanMode")].join("\n"))).toBe(true);
  expect(pendingQuestion([use("b", "Bash")].join("\n"))).toBe(false);
  expect(pendingQuestion("{broken")).toBe(false);
});

test("listTerminalSessions: newest terminal sessions across folders, board runs left out", () => {
  const configDir = tempDir();
  const write = (folder: string, id: string, entrypoint: string, day: string, extra: object[] = []) => {
    const dir = join(configDir, "projects", encodeProjectDir(folder));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, [
      JSON.stringify({ type: "user", cwd: folder, entrypoint, message: { role: "user", content: `work in ${folder}` } }),
      ...extra.map((e) => JSON.stringify(e)),
    ].join("\n") + "\n");
    utimesSync(file, new Date(day), new Date(day));
    return file;
  };
  const id = (n: number) => `0000000${n}-0000-0000-0000-000000000000`;
  write("/Users/x/travelz", id(1), "cli", "2026-10-01");
  write("/Users/x/travelz/api", id(2), "cli", "2026-10-03", [{ type: "ai-title", aiTitle: "Fix the API" }]);
  write("/Users/x/kanban", id(3), "sdk-cli", "2026-10-04");
  write("/Users/x", id(4), "sdk-py", "2026-10-05");
  write("/Users/x/.claude-kanban/artifact-helper", id(5), "cli", "2026-10-06");
  write("/Users/x/app", id(6), "cli", "2026-10-02", [{ type: "assistant", message: { content: [{ type: "tool_use", id: "q", name: "AskUserQuestion", input: {} }] } }]);
  // A renamed project folder linked under its old name lists the same sessions twice.
  symlinkSync(join(configDir, "projects", encodeProjectDir("/Users/x/travelz")), join(configDir, "projects", "-Users-x-old-travelz"));
  // Open in a terminal (Claude Code's status file), waiting on a permission prompt.
  mkdirSync(join(configDir, "sessions"));
  writeFileSync(join(configDir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id(1), status: "waiting" }));

  const list = listTerminalSessions([`claude --resume ${id(6)}`], { configDir }, ["/Users/x/.claude-kanban"]);
  expect(list.map((s) => s.id)).toEqual([id(2), id(6), id(1)]);
  expect(list[0]).toMatchObject({ title: "Fix the API", firstPrompt: "work in /Users/x/travelz/api", cwd: "/Users/x/travelz/api", live: false, needsYou: false });
  expect(list[1]).toMatchObject({ live: true, needsYou: true });
  expect(list[2]).toMatchObject({ live: true, needsYou: true });
  expect(listTerminalSessions([], { configDir }, [], 1).map((s) => s.id)).toEqual([id(5)]);
});

test("sessionFolder: the folder Claude can resume the session from", () => {
  const configDir = tempDir();
  const folder = tempDir();
  const dir = join(configDir, "projects", encodeProjectDir(folder));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "s.jsonl");
  writeFileSync(file, JSON.stringify({ type: "user", cwd: folder, entrypoint: "cli" }) + "\n");
  expect(sessionFolder(file)).toBe(folder);
  const elsewhere = join(configDir, "projects", "-other", "s.jsonl");
  mkdirSync(join(configDir, "projects", "-other"));
  writeFileSync(elsewhere, JSON.stringify({ type: "user", cwd: folder }) + "\n");
  expect(sessionFolder(elsewhere)).toBeNull();
  const linked = join(configDir, "projects", "-linked");
  symlinkSync(dir, linked);
  expect(sessionFolder(join(linked, "s.jsonl"))).toBe(folder);
});
