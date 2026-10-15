import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ClaudeCommand } from "./commands";

/**
 * `codex exec` has no slash commands, so the board offers the useful ones itself.
 * Settings commands open the settings sheet in the UI; the rest become prompts (see expandCodexCommand).
 */
const BUILTINS: ClaudeCommand[] = [
  { name: "clear", description: "Start a new conversation", argumentHint: "", aliases: ["new"], builtin: true },
  { name: "model", description: "Choose the Codex model", argumentHint: "", aliases: [], builtin: true },
  { name: "effort", description: "Choose how hard Codex thinks", argumentHint: "", aliases: [], builtin: true },
  { name: "review", description: "Review the uncommitted changes", argumentHint: "[focus]", aliases: [], builtin: true },
  { name: "init", description: "Create an AGENTS.md with instructions for this repo", argumentHint: "", aliases: [], builtin: true },
];

export interface CodexSkill { name: string; description: string }

/** Skill folders Codex reads: the repo's .agents/skills up to the git root, then the user's. */
function skillRoots(cwd: string): string[] {
  const roots: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    roots.push(join(dir, ".agents", "skills"));
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
  }
  roots.push(join(homedir(), ".agents", "skills"), join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "skills"));
  return roots;
}

function frontmatter(text: string, key: string): string {
  const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  return new RegExp(`^${key}:\\s*(.*)$`, "m").exec(head)?.[1].trim().replace(/^["']|["']$/g, "") ?? "";
}

export function codexSkills(cwd: string): CodexSkill[] {
  const skills = new Map<string, CodexSkill>();
  for (const root of skillRoots(cwd)) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const file = join(root, entry.name, "SKILL.md");
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      const name = frontmatter(text, "name") || entry.name;
      // The first folder wins, like Codex: a repo skill shadows a user skill with the same name.
      if (/^[\w.:-]{1,100}$/.test(name) && !skills.has(name)) skills.set(name, { name, description: frontmatter(text, "description").slice(0, 300) });
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function codexCommands(): ClaudeCommand[] {
  return BUILTINS;
}

/**
 * The prompt to send for a Codex message: board commands become prompts, settings commands are refused,
 * and anything else (a path like /Users/me/app.ts, or a command Codex may know) goes as typed.
 */
export function expandCodexCommand(text: string): string {
  const [, name, rest = ""] = /^\s*\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text) ?? [];
  if (name === "review") {
    return `Review the uncommitted changes in this repository (git status and git diff). List real problems first, most serious first, with file and line. Don't change any files.${rest.trim() ? `\nFocus on: ${rest.trim()}` : ""}`;
  }
  if (name === "init") {
    return "Create an AGENTS.md file in the repository root with short, practical instructions for coding agents: how to build, test and run the project, the code layout, and conventions to follow. Read the repo first; keep it under 60 lines.";
  }
  if (name === "model" || name === "effort") throw new Error(`Use the settings button to change the Codex ${name}.`);
  return text;
}
