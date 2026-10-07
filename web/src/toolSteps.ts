/* Kept free of React/DOM so it can be unit tested. */

/** One agent step ("Bash: git status", "Edit: /repo/src/app.ts") as words a person reads at a glance. */
export interface Step { kind: "read" | "edit" | "run" | "search" | "web" | "other"; label: string; detail: string }

const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const quote = (text: string) => `“${text.length > 40 ? `${text.slice(0, 39)}…` : text}”`;
const words = (name: string) => name.replace(/[_-]+/g, " ").trim();

function command(cmd: string): string {
  const first = cmd.trim().replace(/^(cd \S+ && |sudo |bunx |npx )+/, "");
  if (/\b(bun|npm|pnpm|yarn) (run )?test\b|\b(pytest|jest|vitest|go test|cargo test)\b/.test(first)) return "Ran tests";
  if (/\btsc\b|\btypecheck\b/.test(first)) return "Checked types";
  if (/\b(vite build|run build|build:web)\b/.test(first)) return "Built the app";
  const git = /^git (\w+)/.exec(first);
  if (git) return `Git ${git[1]}`;
  return `Ran ${base(first.split(/\s+/)[0] || "a command")}`;
}

export function describeStep(text: string): Step {
  const at = text.indexOf(": ");
  const name = at > 0 ? text.slice(0, at) : text;
  const arg = at > 0 ? text.slice(at + 2) : "";
  switch (name) {
    case "Bash": return { kind: "run", label: command(arg), detail: arg };
    case "Read": return { kind: "read", label: `Read ${base(arg)}`, detail: arg };
    case "Edit": case "MultiEdit": case "NotebookEdit": return { kind: "edit", label: `Edited ${arg.includes(", ") ? "files" : base(arg)}`, detail: arg };
    case "Write": return { kind: "edit", label: `Wrote ${base(arg)}`, detail: arg };
    case "Grep": return { kind: "search", label: `Searched for ${quote(arg)}`, detail: arg };
    case "Glob": return { kind: "search", label: `Looked for ${arg || "files"}`, detail: arg };
    case "WebFetch": { let host = arg; try { host = new URL(arg).host; } catch {} return { kind: "web", label: `Opened ${host}`, detail: arg }; }
    case "WebSearch": return { kind: "web", label: `Searched the web for ${quote(arg)}`, detail: arg };
    case "Task": case "Agent": return { kind: "other", label: "Asked a helper agent", detail: arg };
    case "TodoWrite": return { kind: "other", label: "Updated its to-do list", detail: "" };
    case "ToolSearch": return { kind: "other", label: "Loaded more tools", detail: arg };
    case "Skill": return { kind: "other", label: `Used the ${arg} skill`, detail: "" };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { kind: "other", label: `${words(mcp[2]).replace(/^\w/, (c) => c.toUpperCase())} (${words(mcp[1])})`, detail: arg };
  return { kind: "other", label: words(name), detail: arg };
}

/** "Read 3 files · edited 2 · ran 4 commands" for a folded group of steps. */
export function summarizeSteps(texts: string[]): string {
  const steps = texts.map(describeStep);
  if (steps.length === 1) return steps[0].label;
  const count = (kind: Step["kind"]) => steps.filter((s) => s.kind === kind).length;
  const parts = [
    count("read") && `read ${count("read")} ${count("read") === 1 ? "file" : "files"}`,
    count("edit") && `edited ${count("edit")}`,
    count("run") && `ran ${count("run")} ${count("run") === 1 ? "command" : "commands"}`,
    count("search") && `searched ${count("search")} ${count("search") === 1 ? "time" : "times"}`,
    count("web") && `opened ${count("web")} ${count("web") === 1 ? "page" : "pages"}`,
    count("other") && `${count("other")} other ${count("other") === 1 ? "step" : "steps"}`,
  ].filter(Boolean) as string[];
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
