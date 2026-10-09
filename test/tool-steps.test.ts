import { expect, test } from "bun:test";
import { describeStep, summarizeSteps } from "../web/src/toolSteps";

test("agent steps read as plain sentences", () => {
  expect(describeStep("Read: /repo/web/src/Chat.tsx").label).toBe("Read Chat.tsx");
  expect(describeStep("Edit: /repo/src/a.ts, /repo/src/b.ts").label).toBe("Edited files");
  expect(describeStep("Bash: cd /repo && bun test test").label).toBe("Ran tests");
  expect(describeStep("Bash: git status --short").label).toBe("Git status");
  expect(describeStep("Bash: python3 - <<'EOF'").label).toBe("Ran python3");
  expect(describeStep("Bash: P=/tmp/x; git worktree add $P").label).toBe("Ran a shell script");
  expect(describeStep("Bash: cat >> web/src/styles.css <<'EOF'")).toMatchObject({ kind: "edit", label: "Wrote styles.css" });
  expect(describeStep("Bash: for i in 1 2; do curl -s x; done").label).toBe("Ran a shell script");
  expect(describeStep("Grep: usagePill").label).toBe("Searched for “usagePill”");
  expect(describeStep("WebFetch: https://docs.example.com/x").label).toBe("Opened docs.example.com");
  expect(describeStep("mcp__playwright__browser_click: Send")).toMatchObject({ kind: "web", label: "Clicked on the page" });
  expect(describeStep("mcp__playwright-isolated__browser_run_code_unsafe").label).toBe("Ran a script in the browser");
  expect(describeStep("mcp__ckanban__ask_questions").label).toBe("Asked you questions");
  expect(describeStep("mcp__linear__search_issues: bug").label).toBe("Search issues · linear");
  // The raw command stays available for the opened view.
  expect(describeStep("Bash: git status --short").detail).toBe("git status --short");
});

test("Codex shell commands read like the equivalent Claude steps", () => {
  expect(describeStep(`Bash: /bin/zsh -lc "rg -n 'theme' src | head -20"`)).toMatchObject({ kind: "search", label: "Searched for “theme”" });
  expect(describeStep("Bash: sed -n '1,120p' src/settings/Settings.tsx")).toMatchObject({ kind: "read", label: "Read Settings.tsx" });
  expect(describeStep("Bash: *** Begin Patch")).toMatchObject({ kind: "edit", label: "Edited files" });
  expect(describeStep(`Bash: bash -lc 'git status --short'`)).toMatchObject({ kind: "run", label: "Git status", detail: "git status --short" });
});

test("a folded group of steps is summed up by kind", () => {
  expect(summarizeSteps(["Read: a.ts"])).toBe("Read a.ts");
  expect(summarizeSteps(["Read: a.ts", "Read: b.ts", "Edit: a.ts", "Bash: ls", "Bash: bun test"])).toBe("Read 2 files · edited 1 file · ran 2 commands");
});
