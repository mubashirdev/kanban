// The models add-on: per-ticket model and effort, board defaults, and what Claude and Codex runs get.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachCodex } from "../src/server/addons/codex/state";
import { codexChoice, modelRoutes, withEffort } from "../src/server/addons/models";
import { board, bus, readArgs, setup, store, untilSpawned, useBoardEnv } from "./board-env";
import { readJsonl, tempDir } from "./helpers";

useBoardEnv();

const FAKE_CODEX = join(import.meta.dir, "fixtures", "fake-codex.ts");

beforeEach(() => attachCodex(store, bus));
afterEach(() => {
  for (const k of ["CKANBAN_CODEX_BIN", "FAKE_CODEX_LOG", "CODEX_HOME"]) delete process.env[k];
});

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  modelRoutes(new Request(`http://localhost/api/${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", ...(method === "GET" ? {} : { origin: "http://localhost" }), ...headers },
  }), path.split("/"), { store, bus });

async function ticket(extra: Record<string, unknown> = {}) {
  await setup();
  const t = await board.createTicket("p", { title: "Check it", body: "desc", status: "backlog" });
  store.updateTicket("p", t.id, extra as any);
  return t.id;
}

test("a ticket saves its own model and effort; bad values are refused", async () => {
  const id = await ticket();
  let r = await call("POST", `addons/models/tickets/${id}`, { model: "sonnet", effort: "high", codexModel: "gpt-5.5", codexEffort: "ultra" });
  expect(r!.status).toBe(200);
  expect(store.getTicket("p", id)).toMatchObject({ model: "sonnet", effort: "high", codexModel: "gpt-5.5", codexEffort: "ultra" });
  r = await call("POST", `addons/models/tickets/${id}`, { effort: null });
  expect((store.getTicket("p", id) as any).effort).toBeNull();
  for (const bad of [{ effort: "ultra" }, { effort: "huge" }, { model: "gpt-5" }, { codexModel: "a b" }]) {
    expect((await call("POST", `addons/models/tickets/${id}`, bad))!.status).toBe(400);
  }
  // Only the user: not a board run, and not a request without the browser's Origin.
  expect((await call("POST", `addons/models/tickets/${id}`, { effort: "low" }, { "x-ckanban-run": "1" }))!.status).toBe(403);
  const bare = await modelRoutes(new Request(`http://localhost/api/addons/models/tickets/${id}`, { method: "POST", body: "{}" }), ["addons", "models", "tickets", id], { store, bus });
  expect(bare!.status).toBe(403);
});

test("board defaults: the Claude model is the board's own model field", async () => {
  await setup();
  let r = await call("PATCH", "addons/models/boards/p", { claudeModel: "opus", claudeEffort: "max", codexModel: "gpt-5.5", codexEffort: "low" });
  expect(await r!.json()).toEqual({ claudeModel: "opus", claudeEffort: "max", codexModel: "gpt-5.5", codexEffort: "low" });
  expect(store.getProfile("p")).toMatchObject({ model: "opus", claudeEffort: "max", codexModel: "gpt-5.5", codexEffort: "low" });
  r = await call("PATCH", "addons/models/boards/p", { claudeModel: null, codexEffort: "" });
  expect(await r!.json()).toEqual({ claudeModel: null, claudeEffort: "max", codexModel: "gpt-5.5", codexEffort: null });
  expect((await call("GET", "addons/models/boards/nope"))!.status).toBe(404);
  expect(await call("GET", "profiles")).toBeNull();
});

test("a Claude run gets the ticket's effort, else the board's", async () => {
  const id = await ticket();
  store.saveProfile({ ...store.getProfile("p")!, claudeEffort: "low" } as any);
  await board.updateTicket("p", id, { status: "ready" });
  await untilSpawned(1);
  await board.whenIdle();
  expect(readArgs()[0].args.join(" ")).toContain("--effort low");

  store.updateTicket("p", id, { effort: "max" } as any);
  await board.chat("p", id, "again");
  await untilSpawned(2);
  await board.whenIdle();
  expect(readArgs()[1].args.join(" ")).toContain("--effort max");
});

test("huddle teammates and runs with no effort set get no --effort", async () => {
  const id = await ticket({ effort: "high" });
  const env = { CKANBAN_TICKET: `p/${id}` };
  expect(withEffort(["-p"], env, store)).toEqual(["-p", "--effort", "high"]);
  expect(withEffort(["-p"], { ...env, CKANBAN_HUDDLE_AGENT: "h/reviewer/x" }, store)).toEqual(["-p"]);
  store.updateTicket("p", id, { effort: null } as any);
  expect(withEffort(["-p"], env, store)).toEqual(["-p"]);
});

test("a Codex run gets the model and effort; an effort the model doesn't support is left out", async () => {
  const home = tempDir("ck-codex-home-");
  process.env.CODEX_HOME = home;
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
  ] }));
  const id = await ticket({ agent: "codex" });
  store.saveProfile({ ...store.getProfile("p")!, codexModel: "gpt-5.5", codexEffort: "high" } as any);
  const t = () => store.getTicket("p", id)!;
  expect(codexChoice(t(), store.getProfile("p")!)).toEqual({ model: "gpt-5.5", effort: "high" });
  store.updateTicket("p", id, { codexEffort: "xhigh" } as any);
  expect(codexChoice(t(), store.getProfile("p")!)).toEqual({ model: "gpt-5.5", effort: null });

  store.updateTicket("p", id, { codexEffort: "low" } as any);
  const log = join(tempDir("ck-codex-"), "log.jsonl");
  process.env.CKANBAN_CODEX_BIN = FAKE_CODEX;
  process.env.FAKE_CODEX_LOG = log;
  await board.updateTicket("p", id, { status: "ready" });
  await board.whenIdle();
  const [run] = readJsonl(log).filter((e) => e.args);
  expect(run.args).toEqual(expect.arrayContaining(['model="gpt-5.5"', 'model_reasoning_effort="low"']));
});
