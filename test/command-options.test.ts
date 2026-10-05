import { expect, test } from "bun:test";
import { effortOptions, modelMetadata, outputStyleMetadata, type ClaudeCommand } from "../src/server/commands";
import { commandArguments, prepareCommand } from "../web/src/commandSyntax";
const command = (argumentHint: string, builtin = true): ClaudeCommand => ({ name: "effort", argumentHint, builtin, description: "", aliases: [] });

test("effort options require the native command and exactly advertised supported levels", () => {
  expect(effortOptions([command("<low|medium|high|xhigh|max|auto|ultracode [on|off]>")])).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(effortOptions([command("[low|high]")])).toEqual(["low", "high"]);
  expect(effortOptions([command("[low|high]", false)])).toEqual([]);
  expect(effortOptions([command("<maximal>")])).toEqual([]);
});

test("command forms offer literal choices while preserving free-form and nested arguments", () => {
  expect(commandArguments(command("[on|off]"))).toEqual({ choices: ["on", "off"], remaining: "", required: false });
  expect(commandArguments(command("[low|medium|high] [--fix] [<path>]"))).toEqual({ choices: ["low", "medium", "high"], remaining: "[--fix] [<path>]", required: false });
  expect(commandArguments(command("[reconnect|enable|disable [<server>|all]]")).choices).toEqual([]);
  expect(commandArguments(command("<question>"))).toEqual({ choices: [], remaining: "<question>", required: true });
  expect(commandArguments(command("<optional instructions>")).required).toBe(false);
  expect(commandArguments(command("[style]")).choices).toEqual([]);
  expect(commandArguments(command("consent | revoke")).choices).toEqual(["consent", "revoke"]);
  expect(commandArguments(command("<on|off> <target>")).required).toBe(true);
});

test("effort respects advertised model capabilities and style names stay literal settings values", () => {
  const models = modelMetadata([{ value: "opus", supportsEffort: true, supportedEffortLevels: ["low", "high", "max", "bad"] }, { value: "haiku" }]);
  expect(effortOptions([command("<low|medium|high|xhigh|max>")], models, "opus")).toEqual(["low", "high", "max"]);
  expect(effortOptions([command("<low|medium|high|xhigh|max>")], models, "haiku")).toEqual([]);
  expect(outputStyleMetadata(["Concise", "Custom style", "plugin:Concise", "Concise", null, "../private", "evil\nstyle"])).toEqual(["Concise", "Custom style", "plugin:Concise"]);
});

test("preparing a command keeps an ordinary draft and replaces an existing slash draft", () => {
  expect(prepareCommand("Keep this draft", "/compact focus on APIs")).toBe("/compact focus on APIs Keep this draft");
  expect(prepareCommand("/comp old args", "/compact focus on APIs")).toBe("/compact focus on APIs");
  expect(prepareCommand("Explain /model in this note", "/context")).toBe("/context Explain /model in this note");
});
