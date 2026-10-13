#!/usr/bin/env bun
// A fake `codex app-server`: answers the JSON-RPC handshake, runs one turn and exits when its input closes.
// FAKE_CODEX_ASK=1 sends a command approval request first and logs the board's decision.
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const thread = "12345678-1234-1234-1234-123456789abc";
const send = (message: object) => console.log(JSON.stringify(message));
const notify = (method: string, params: object) => send({ method, params });
let resume: string | null = null;
let answered: (decision: string) => void = () => {};

async function turn(prompt: string) {
  if (process.env.FAKE_CODEX_LOG)
    appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, prompt, resume, cwd: process.cwd() }) + "\n");
  if (process.env.FAKE_CODEX_DELAY) await Bun.sleep(Number(process.env.FAKE_CODEX_DELAY));
  if (process.env.FAKE_CODEX_ASK) {
    const decision = new Promise<string>((resolve) => (answered = resolve));
    send({ id: 0, method: "item/commandExecution/requestApproval", params: { kind: "command", itemId: "cmd-0", reason: "Write outside the workspace?", command: "/bin/zsh -lc 'touch ~/x'", commandActions: [{ type: "unknown", command: "touch ~/x" }] } });
    const result = await decision;
    if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ decision: result }) + "\n");
    notify("serverRequest/resolved", { threadId: thread, requestId: 0 });
  }
  const command = { type: "commandExecution", id: "cmd-1", command: "echo verified" };
  notify("item/started", { item: { ...command, status: "inProgress" } });
  notify("item/completed", { item: { ...command, status: "completed", exitCode: 0, aggregatedOutput: "verified" } });
  if (process.env.FAKE_CODEX_FAIL) {
    notify("turn/completed", { threadId: thread, turn: { status: "failed", error: { message: "Fake provider failure" } } });
    return;
  }
  notify("item/completed", {
    item: { type: "agentMessage", id: "reply", text: 'Verified.\nCKANBAN_RESULT: {"status":"done","prUrl":null,"summary":"Codex verified the work"}' },
  });
  notify("turn/completed", { threadId: thread, turn: { status: "completed", error: null } });
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.method === undefined) answered(message.result?.decision);
    else if (message.method === "initialize") send({ id: message.id, result: {} });
    else if (message.method === "thread/start" || message.method === "thread/resume") {
      resume = message.params.threadId ?? null;
      send({ id: message.id, result: { thread: { id: thread } } });
    } else if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { status: "inProgress" } } });
      turn(message.params.input[0].text);
    }
  }
}
