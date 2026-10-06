#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2),
  prompt = await Bun.stdin.text();
if (process.env.FAKE_CODEX_LOG)
  appendFileSync(
    process.env.FAKE_CODEX_LOG,
    JSON.stringify({ args, prompt, cwd: process.cwd() }) + "\n"
  );
const emit = (event: object) => console.log(JSON.stringify(event));
emit({
  type: "thread.started",
  thread_id: "12345678-1234-1234-1234-123456789abc",
});
if (process.env.FAKE_CODEX_DELAY)
  await Bun.sleep(Number(process.env.FAKE_CODEX_DELAY));
emit({
  type: "item.started",
  item: { type: "command_execution", id: "cmd-1", command: "echo verified" },
});
emit({
  type: "item.completed",
  item: {
    type: "command_execution",
    id: "cmd-1",
    command: "echo verified",
    exit_code: 0,
    aggregated_output: "verified",
  },
});
if (process.env.FAKE_CODEX_FAIL) {
  emit({ type: "turn.failed", error: { message: "Fake provider failure" } });
  process.exit(1);
}
emit({
  type: "item.completed",
  item: {
    type: "agent_message",
    id: "reply",
    text: 'Verified.\nCKANBAN_RESULT: {"status":"done","prUrl":null,"summary":"Codex verified the work"}',
  },
});
emit({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 5 } });
