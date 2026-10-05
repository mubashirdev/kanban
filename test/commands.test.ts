import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ClaudeCommands, commandMetadata, discoverCommands, discoverCatalog, modelMetadata, isSlashCommand } from "../src/server/commands";
import { tempDir } from "./helpers";
const fake = join(import.meta.dir, "fixtures/fake-claude.ts");

test("command discovery initializes Claude without a user prompt and preserves namespace/arguments", async () => {
  const cwd = tempDir(), log = join(cwd, "discovery.jsonl");
  process.env.FAKE_COMMAND_LOG = log;
  try {
    const commands = await discoverCommands(fake, cwd, true);
    expect(commands.map((c) => c.name)).toEqual(["commit-files", "context", "model", "qa:review"]);
    expect(commands.find((c) => c.name === "model")?.argumentHint).toBe("<model>");
    const call = JSON.parse(readFileSync(log, "utf8"));
    expect(call.cwd).toBe(cwd);
    expect(call.args).toContain("plan");
    expect(call.args).toContain("--mcp-config");
  } finally { delete process.env.FAKE_COMMAND_LOG; }
});

test("discovery timeout stops the process and remains retryable", async () => {
  process.env.FAKE_COMMAND_DELAY = "10000";
  try { await expect(discoverCommands(fake, tempDir(), true, 50)).rejects.toThrow("timed out"); }
  finally { delete process.env.FAKE_COMMAND_DELAY; }
  expect((await discoverCommands(fake, tempDir(), true)).length).toBe(4);
});

test("cache shares in-flight requests, refreshes on demand and distinguishes folder/mode", async () => {
  let calls = 0;
  const catalog = new ClaudeCommands("fake", async () => { calls++; await Bun.sleep(10); return { commands: [], models: [] }; });
  await Promise.all([catalog.get("/a", true), catalog.catalog("/a", true, true)]);
  expect(calls).toBe(1);
  await catalog.get("/a", true); expect(calls).toBe(1);
  await catalog.get("/a", true, true); expect(calls).toBe(2);
  await catalog.get("/b", true); await catalog.get("/a", false); expect(calls).toBe(4);
});

test("a failed catalog can be retried, malformed and internal metadata stay out of the picker", async () => {
  let fail = true;
  const catalog = new ClaudeCommands("fake", async () => { if (fail) throw new Error("offline"); return { commands: [], models: [] }; });
  await expect(catalog.get("/a", true)).rejects.toThrow("offline");
  fail = false; expect(await catalog.get("/a", true)).toEqual([]);
  expect(commandMetadata([{ name: "ok", aliases: ["alias", "bad name"] }, { name: "ok" }, { name: "__internal" }, { name: "bad name" }, null])).toEqual([
    { name: "ok", description: "", aliases: ["alias"], builtin: false, argumentHint: "" },
  ]);
  expect(isSlashCommand("/plugin:review arg")).toBe(true);
  expect(isSlashCommand("explain /model")).toBe(false);
  expect(isSlashCommand("/ model")).toBe(false);
});

test("live discovery returns model choices and excludes duplicate or malformed model IDs", async () => {
  const catalog = await discoverCatalog(fake, tempDir(), true);
  expect(catalog.models[0]).toEqual({ value: "sonnet", displayName: "Sonnet", description: "Daily coding" });
  expect(modelMetadata([{ value: "opus[1m]" }, { value: "opus[1m]" }, { value: "bad model" }, null])).toEqual([{ value: "opus[1m]", displayName: "opus[1m]", description: "" }]);
});
