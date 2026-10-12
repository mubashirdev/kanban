import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus, type BusEvent } from "../src/server/events";
import { createServer } from "../src/server/http";
import { parseSession, pollSessions, SessionCache } from "../src/server/session";
import { Store } from "../src/server/store";
import { AGENT_STEP_TAIL, parseAgentTranscript, settleAgent } from "../src/server/subagents";
import { tempDir } from "./helpers";

const L = (o: unknown) => JSON.stringify(o);
const user = (content: any, at: string, extra: object = {}) =>
  L({ type: "user", uuid: `u${at}`, timestamp: at, message: { role: "user", content }, ...extra });
const asst = (content: any[], at: string, extra: object = {}, stop: string | null = null) =>
  L({ type: "assistant", uuid: `a${at}`, timestamp: at, message: { role: "assistant", content, stop_reason: stop }, ...extra });
const agentCall = (id: string, description: string, at: string, input: object = {}) =>
  asst([{ type: "tool_use", id, name: "Agent", input: { description, subagent_type: "Explore", prompt: "Look around", ...input } }], at);

const TRANSCRIPT = (done: boolean) => [
  user("Look around", "2026-10-07T01:00:02Z", { isSidechain: true }),
  asst([{ type: "thinking", thinking: "" }], "2026-10-07T01:00:03Z", { isSidechain: true }),
  asst([{ type: "tool_use", id: "s1", name: "Grep", input: { pattern: "level" } }], "2026-10-07T01:00:04Z", { isSidechain: true }),
  user([{ type: "tool_result", tool_use_id: "s1", content: "x", is_error: true }], "2026-10-07T01:00:05Z", { isSidechain: true }),
  asst([{ type: "text", text: "Share flow is in ShareSheet.tsx." }], "2026-10-07T01:00:06Z", { isSidechain: true }),
  asst([{ type: "tool_use", id: "s2", name: "Read", input: { file_path: "/r/notifications.ts" } }], "2026-10-07T01:00:07Z", { isSidechain: true }),
  ...(done ? [
    user([{ type: "tool_result", tool_use_id: "s2", content: "y" }], "2026-10-07T01:00:08Z", { isSidechain: true }),
    asst([{ type: "text", text: "## Findings\nAll good." }], "2026-10-07T01:00:09Z", { isSidechain: true }, "end_turn"),
  ] : []),
].join("\n") + "\n";

test("parseAgentTranscript: steps, the tool call in flight, and the final report", () => {
  const live = parseAgentTranscript(TRANSCRIPT(false));
  expect(live.steps).toEqual([
    { kind: "tool", text: "Grep: level", id: "s1", error: true },
    { kind: "text", text: "Share flow is in ShareSheet.tsx." },
    { kind: "tool", text: "Read: /r/notifications.ts", id: "s2" },
  ]);
  expect(live.current).toBe("Read: /r/notifications.ts");
  expect(live.final).toBeNull();
  const done = parseAgentTranscript(TRANSCRIPT(true));
  expect(done.steps.length).toBe(3);
  expect(done.current).toBeNull();
  expect(done.final).toBe("## Findings\nAll good.");
  expect(done.lastAt).toBe("2026-10-07T01:00:09Z");
});

function sessionWithAgent() {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-proj");
  mkdirSync(dir, { recursive: true });
  const sid = "11111111-2222-3333-4444-555555555555";
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, [user("Map the code", "2026-10-07T01:00:00Z"), agentCall("ag1", "Challenges, share", "2026-10-07T01:00:01Z")].join("\n") + "\n");
  const sub = join(dir, sid, "subagents");
  return { configDir, sid, file, sub };
}
