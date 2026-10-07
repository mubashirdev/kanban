import { expect, test } from "bun:test";
import { describeStep, summarizeSteps } from "../web/src/toolSteps";

test("agent steps read as plain sentences", () => {
  expect(describeStep("Read: /repo/web/src/Chat.tsx").label).toBe("Read Chat.tsx");
  expect(describeStep("Edit: /repo/src/a.ts, /repo/src/b.ts").label).toBe("Edited files");
  expect(describeStep("Bash: cd /repo && bun test test").label).toBe("Ran tests");
  expect(describeStep("Bash: git status --short").label).toBe("Git status");
  expect(describeStep("Bash: python3 - <<'EOF'").label).toBe("Ran python3");
  expect(describeStep("Grep: usagePill").label).toBe("Searched for “usagePill”");
  expect(describeStep("WebFetch: https://docs.example.com/x").label).toBe("Opened docs.example.com");
  expect(describeStep("mcp__playwright__browser_click: Send").label).toBe("Browser click (playwright)");
  // The raw command stays available for the opened view.
  expect(describeStep("Bash: git status --short").detail).toBe("git status --short");
});

test("a folded group of steps is summed up by kind", () => {
  expect(summarizeSteps(["Read: a.ts"])).toBe("Read a.ts");
  expect(summarizeSteps(["Read: a.ts", "Read: b.ts", "Edit: a.ts", "Bash: ls", "Bash: bun test"])).toBe("Read 2 files · edited 1 · ran 2 commands");
});
