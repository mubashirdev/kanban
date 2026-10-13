import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

let server: ReturnType<typeof createServer>;
let store: Store;
let base: string;

beforeAll(() => {
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  server = createServer({ store, bus, board: new Board(store, bus, { claudeBin: "/bin/false" }), port: 0, webDir: tempDir("ck-web-") });
  base = `http://127.0.0.1:${server.port}`;
  for (const slug of ["alpha", "beta"]) {
    store.saveProfile({ name: slug, slug, path: tempDir("ck-p-"), baseBranch: "main", maxParallel: 1, createdAt: new Date().toISOString() } as any);
  }
});

afterAll(() => server.stop(true));

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

const qa = { name: "QA ticket", title: "fix DEV-", body: "Reproduce first.", kind: "bug", priority: "high" };

test("starts empty: nothing is seeded", async () => {
  expect(await (await call("GET", "/templates?profile=alpha")).json()).toEqual([]);
});

test("save, list per board plus global, persist and delete", async () => {
  let r = await call("POST", "/templates", { ...qa, scope: "alpha" });
  expect(r.status).toBe(201);
  const own = (await r.json()) as any;
  expect(own).toMatchObject({ ...qa, scope: "alpha" });
  r = await call("POST", "/templates", { name: "Release train", title: "Release", body: "", kind: "task", priority: "normal", scope: "global" });
  expect(r.status).toBe(201);

  const names = async (slug: string) => ((await (await call("GET", `/templates?profile=${slug}`)).json()) as any[]).map((t) => t.name);
  expect(await names("alpha")).toEqual(["QA ticket", "Release train"]);
  expect(await names("beta")).toEqual(["Release train"]);

  // Stored in one file, like snippets, so it survives a restart.
  const file = join(store.root, "templates.json");
  expect(JSON.parse(readFileSync(file, "utf8")).length).toBe(2);

  expect((await call("DELETE", `/templates/${own.id}`)).status).toBe(204);
  expect(await names("alpha")).toEqual(["Release train"]);
  expect((await call("DELETE", `/templates/${own.id}`)).status).toBe(404);
  expect(existsSync(file)).toBe(true);
});

test("rejects bad input and duplicate names in the same place", async () => {
  expect((await call("POST", "/templates", { ...qa, name: " " })).status).toBe(400);
  expect((await call("POST", "/templates", { ...qa, title: "", body: " " })).status).toBe(400);
  expect((await call("POST", "/templates", { ...qa, kind: "epic" })).status).toBe(400);
  expect((await call("POST", "/templates", { ...qa, priority: "asap" })).status).toBe(400);
  expect((await call("POST", "/templates", { ...qa, scope: "nope" })).status).toBe(400);
  expect((await call("POST", "/templates", { ...qa, scope: "beta" })).status).toBe(201);
  expect((await call("POST", "/templates", { ...qa, name: "qa ticket", scope: "beta" })).status).toBe(409);
  // Same name on another board is fine.
  expect((await call("POST", "/templates", { ...qa, scope: "alpha" })).status).toBe(201);
});

test("deleting a board deletes its templates", async () => {
  expect((await call("DELETE", "/profiles/beta")).status).toBe(204);
  const all = (await (await call("GET", "/templates")).json()) as any[];
  expect(all.some((t) => t.scope === "beta")).toBe(false);
});

test("quick replies: saved as a list, empty or null means the built-in ones", async () => {
  let s = (await (await call("PATCH", "/settings", { quickReplies: [" yes plz ", "", "try now"] })).json()) as any;
  expect(s.quickReplies).toEqual(["yes plz", "try now"]);
  s = (await (await call("GET", "/settings")).json()) as any;
  expect(s.quickReplies).toEqual(["yes plz", "try now"]);
  s = (await (await call("PATCH", "/settings", { quickReplies: [] })).json()) as any;
  expect(s.quickReplies).toBeNull();
  expect((await call("PATCH", "/settings", { quickReplies: "ok" })).status).toBe(400);
  expect((await call("PATCH", "/settings", { quickReplies: Array(13).fill("ok") })).status).toBe(400);
});
