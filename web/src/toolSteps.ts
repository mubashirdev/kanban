/* Kept free of React/DOM so it can be unit tested. */

/** One agent step ("Bash: git status", "Edit: /repo/src/app.ts") as words a person reads at a glance. */
export interface Step { kind: "read" | "edit" | "run" | "search" | "web" | "other"; label: string; detail: string }

const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const quote = (text: string) => `“${text.length > 40 ? `${text.slice(0, 39)}…` : text}”`;
const words = (name: string) => name.replace(/[_-]+/g, " ").trim();

/** Codex runs every command as `/bin/zsh -lc "..."`: show the command itself. */
const unwrap = (cmd: string) => /^(?:\S*\/)?(?:ba|z)?sh\s+-\w*c\s+(["'])([\s\S]*)\1$/.exec(cmd.trim())?.[2].replaceAll('\\"', '"') ?? cmd;
const operands = (cmd: string) => cmd.split("|")[0].trim().split(/\s+/).slice(1).filter((word) => !word.startsWith("-")).map((word) => word.replace(/^['"]|['"]$/g, ""));

/** Commands that only look at files or code read as reading and searching, not as "Ran rg". */
function inspect(first: string): Step | null {
  const tool = first.split(/\s+/)[0];
  const args = operands(first);
  if (/^(rg|grep|ag|fd|find)$/.test(tool)) return { kind: "search", label: args[0] ? `Searched for ${quote(args[0])}` : "Searched the code", detail: first };
  const target = /^cat\b.*?>>?\s*(\S+)/.exec(first)?.[1];
  if (target) return { kind: "edit", label: `Wrote ${base(target)}`, detail: first };
  if (/^(cat|sed|head|tail|nl|bat)$/.test(tool) && args.length) return { kind: "read", label: `Read ${base(args.at(-1)!)}`, detail: first };
  if (tool === "apply_patch" || first.startsWith("*** Begin Patch")) return { kind: "edit", label: "Edited files", detail: "" };
  return null;
}

function command(cmd: string): Step {
  const first = unwrap(cmd).trim().replace(/^(cd \S+ && |sudo |bunx |npx )+/, "");
  const found = inspect(first);
  if (found) return found;
  const run = (label: string): Step => ({ kind: "run", label, detail: unwrap(cmd) });
  if (/\b(bun|npm|pnpm|yarn) (run )?test\b|\b(pytest|jest|vitest|go test|cargo test)\b/.test(first)) return run("Ran tests");
  if (/\btsc\b|\btypecheck\b/.test(first)) return run("Checked types");
  if (/\b(vite build|run build|build:web)\b/.test(first)) return run("Built the app");
  const git = /^git (\w+)/.exec(first);
  if (git) return run(`Git ${git[1]}`);
  const tool = first.split(/[\s;]+/)[0];
  // "P=/x; ...", "for i in ...", "env -u X bun ..." are scripts, not a program called "P=" or "for".
  if (!tool || tool.includes("=") || /^(for|while|until|if|env|export|set|case|[({])$/.test(tool)) return run("Ran a shell script");
  return run(`Ran ${base(tool)}`);
}

const BOARD_TOOLS: Record<string, string> = {
  ask_questions: "Asked you questions", propose_ticket: "Proposed a ticket", propose_tickets: "Proposed tickets",
  propose_branch: "Offered a branch", create_ticket: "Created a ticket", update_ticket: "Updated a ticket",
  move_ticket: "Moved a ticket", get_ticket: "Read a ticket", list_tickets: "Listed tickets", ask_ticket: "Asked another ticket",
  reply_ticket: "Replied to another ticket", comment_ticket: "Commented on a ticket", report_bug: "Reported a bug",
};

/** "mcp__playwright__browser_click" reads as "Clicked on the page", not "Browser click (playwright)". */
function mcpStep(server: string, tool: string, arg: string): Step {
  if (/chrome|playwright|browser|puppeteer/i.test(server)) {
    const label = /navigate|open|tabs_create/.test(tool) ? "Opened a page"
      : /screenshot|snapshot|read_page|get_page/.test(tool) ? "Looked at the page"
      : /click|tap|hover|drag/.test(tool) ? "Clicked on the page"
      : /type|fill|form|press|key/.test(tool) ? "Typed on the page"
      : /run_code|evaluate|javascript/.test(tool) ? "Ran a script in the browser"
      : "Used the browser";
    return { kind: "web", label, detail: arg };
  }
  if (server === "ckanban") return { kind: "other", label: BOARD_TOOLS[tool] ?? `${words(tool).replace(/^\w/, (c) => c.toUpperCase())} on the board`, detail: arg };
  return { kind: "other", label: `${words(tool).replace(/^\w/, (c) => c.toUpperCase())} · ${words(server)}`, detail: arg };
}

export function describeStep(text: string): Step {
  const at = text.indexOf(": ");
  const name = at > 0 ? text.slice(0, at) : text;
  const arg = at > 0 ? text.slice(at + 2) : "";
  switch (name) {
    case "Bash": return command(arg);
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
  if (mcp) return mcpStep(mcp[1], mcp[2], arg);
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
