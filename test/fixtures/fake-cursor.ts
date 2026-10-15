#!/usr/bin/env bun
// Stands in for `cursor-agent -p --output-format stream-json`: logs its call, then prints a short turn.
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = args.at(-1);
if (process.env.FAKE_CURSOR_LOG) appendFileSync(process.env.FAKE_CURSOR_LOG, JSON.stringify({ args, prompt, cwd: process.cwd() }) + "\n");
if (process.env.FAKE_CURSOR_MODE === "auth") {
  console.error("Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.");
  process.exit(1);
}
if (process.env.FAKE_CURSOR_MODE === "silent") await Bun.sleep(60_000);
const chat = "c0ffee00-1111-2222-3333-444455556666";
const emit = (event: object) => console.log(JSON.stringify(event));
emit({ type: "system", subtype: "init", apiKeySource: "login", cwd: process.cwd(), session_id: chat, model: "Auto", permissionMode: "default" });
emit({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, session_id: chat });
emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Writing the file." }] }, session_id: chat });
emit({ type: "tool_call", subtype: "started", call_id: "w1", tool_call: { writeToolCall: { args: { path: "notes.txt", fileText: "hi\n", toolCallId: "w1" } } }, session_id: chat });
emit({ type: "tool_call", subtype: "completed", call_id: "w1", tool_call: { writeToolCall: { args: { path: "notes.txt", fileText: "hi\n" }, result: { success: { path: `${process.cwd()}/notes.txt`, linesCreated: 1, fileSize: 3 } } } }, session_id: chat });
emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] }, session_id: chat });
emit({ type: "result", subtype: "success", duration_ms: 5, duration_api_ms: 5, is_error: false, result: "Writing the file.Done.", session_id: chat });
