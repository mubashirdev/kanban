import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { parseSession, SessionCache } from "../src/server/session";
import { Store } from "../src/server/store";
import { findToolDetail, TOOL_OUTPUT_MAX } from "../src/server/tooldetail";
import { editDiff, mainInput } from "../web/src/toolView";
import { tempDir } from "./helpers";

const L = (o: unknown) => JSON.stringify(o);
const user = (content: any, at: string) => L({ type: "user", uuid: `u${at}`, timestamp: at, message: { role: "user", content } });
const asst = (content: any[], at: string) => L({ type: "assistant", uuid: `a${at}`, timestamp: at, message: { role: "assistant", content } });

const LONG = `gh run view 37649385086 --log-failed 2>&1 | grep -vE "^\\s*$" | grep -iE "fail|error|expect" | head -30 && git log --oneline -6 origin/main\necho done`;
const RAW = [
  user("Check CI", "2026-10-08T01:00:00Z"),
  asst([{ type: "tool_use", id: "b1", name: "Bash", input: { command: LONG, description: "Failed CI logs" } }], "2026-10-08T01:00:01Z"),
  user([{ type: "tool_result", tool_use_id: "b1", content: [{ type: "text", text: "1 fail\n412 pass" }] }], "2026-10-08T01:00:02Z"),
  asst([{ type: "tool_use", id: "b2", name: "Bash", input: { command: "bun test" } }], "2026-10-08T01:00:03Z"),
  user([{ type: "tool_result", tool_use_id: "b2", content: "x".repeat(TOOL_OUTPUT_MAX + 50), is_error: true }], "2026-10-08T01:00:04Z"),
  asst([{ type: "tool_use", id: "b3", name: "Bash", input: { command: "sleep 100" } }], "2026-10-08T01:00:05Z"),
].join("\n");

test("findToolDetail: full input, output, error and truncation", () => {
  expect(findToolDetail(RAW, "b1")).toEqual({
    id: "b1", name: "Bash", input: { command: LONG, description: "Failed CI logs" }, output: "1 fail\n412 pass", isError: false, truncated: false,
  });
  const failed = findToolDetail(RAW, "b2")!;
  expect(failed).toMatchObject({ isError: true, truncated: true });
  expect(failed.output!.length).toBe(TOOL_OUTPUT_MAX);
  // Still running: no result yet.
  expect(findToolDetail(RAW, "b3")).toMatchObject({ output: null, isError: false });
  expect(findToolDetail(RAW, "nope")).toBeNull();
});

test("mainInput: the main argument for known tools, JSON for the rest", () => {
  expect(mainInput({ name: "Bash", input: { command: LONG, description: "x" } })).toBe(LONG);
  expect(mainInput({ name: "Edit", input: { file_path: "/a.ts", old_string: "a", new_string: "b" } })).toBe("/a.ts");
  expect(mainInput({ name: "Grep", input: { pattern: "foo", path: "src" } })).toBe('{\n  "pattern": "foo",\n  "path": "src"\n}');
});

test("editDiff: Edit, MultiEdit and Write as removed/added lines", () => {
  expect(editDiff({ name: "Edit", input: { old_string: "a\nb", new_string: "c" } })!.lines).toEqual([
    { kind: "rm", text: "a" }, { kind: "rm", text: "b" }, { kind: "ad", text: "c" },
  ]);
  expect(editDiff({ name: "MultiEdit", input: { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] } })!.lines.map((l) => l.kind))
    .toEqual(["rm", "ad", "gap", "rm", "ad"]);
  expect(editDiff({ name: "Write", input: { content: "x\ny" } })!.lines).toEqual([{ kind: "ad", text: "x" }, { kind: "ad", text: "y" }]);
  expect(editDiff({ name: "Write", input: { content: "z\n".repeat(10_000) } })!.truncated).toBe(true);
  expect(editDiff({ name: "Bash", input: { command: "ls" } })).toBeNull();
});
