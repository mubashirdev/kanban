import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { chatSubdir, listFolders } from "../src/server/folders";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

let server: ReturnType<typeof createServer>;
let base: string;
let store: Store;
const home = tempDir("ck-home-dir-");
const outside = tempDir("ck-outside-");

beforeAll(() => {
  for (const d of ["travelz/web-app", "travelz/api", "Apps", ".config", "notes.txt-dir"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, "notes.txt"), "a file, not a folder");
  symlinkSync(outside, join(home, "escape"));
  store = new Store(tempDir("ck-root-"));
  const bus = new Bus();
  server = createServer({ store, bus, board: new Board(store, bus, { claudeBin: "/bin/false" }), port: 0, webDir: tempDir("ck-web-"), home });
  base = `http://127.0.0.1:${server.port}`;
  store.saveProfile({ name: "travelz", slug: "travelz", path: join(home, "travelz"), baseBranch: "main", maxParallel: 1, createdAt: new Date().toISOString() } as any);
});

afterAll(() => server.stop(true));

const get = (query: string) => fetch(`${base}/api/folders${query}`);

test("starts at the home folder and lists only visible folders, sorted", async () => {
  const r = await get("");
  expect(r.status).toBe(200);
  const list = (await r.json()) as any;
  expect(list.path).toBe(home);
  expect(list.parent).toBeNull();
  // No files, no hidden folders, no symlinks (they could lead out of home).
  expect(list.folders.map((f: any) => f.name)).toEqual(["Apps", "notes.txt-dir", "travelz"]);
  expect(list.folders[2].path).toBe(join(home, "travelz"));
});

test("opens a subfolder, with a way back up; hidden folders on request", async () => {
  const list = (await (await get(`?path=${encodeURIComponent(join(home, "travelz"))}`)).json()) as any;
  expect(list.parent).toBe(home);
  expect(list.folders.map((f: any) => f.name)).toEqual(["api", "web-app"]);
  const all = (await (await get("?hidden=1")).json()) as any;
  expect(all.folders.map((f: any) => f.name)).toContain(".config");
});

test("stays inside the home folder", async () => {
  expect((await get(`?path=${encodeURIComponent(`${home}/travelz/../..`)}`)).status).toBe(400);
  expect((await get(`?path=${encodeURIComponent(`${home}/..`)}`)).status).toBe(400);
  expect((await get(`?path=${encodeURIComponent(outside)}`)).status).toBe(403);
  expect((await get("?path=/")).status).toBe(403);
  // A symlink inside home that points outside is refused too.
  expect((await get(`?path=${encodeURIComponent(join(home, "escape"))}`)).status).toBe(403);
  expect((await get("?path=travelz")).status).toBe(400);
  expect((await get(`?path=${encodeURIComponent(join(home, "missing"))}`)).status).toBe(404);
  expect((await get(`?path=${encodeURIComponent(join(home, "notes.txt"))}`)).status).toBe(400);
});

test("a board's browser starts at the board folder and can't go above it", async () => {
  const list = (await (await get("?profile=travelz")).json()) as any;
  expect(list.path).toBe(join(home, "travelz"));
  expect(list.parent).toBeNull();
  expect((await get(`?profile=travelz&path=${encodeURIComponent(home)}`)).status).toBe(403);
  expect((await get("?profile=nope")).status).toBe(404);
});

test("a chat's subfolder must be an existing folder inside the board", () => {
  const board = join(home, "travelz");
  expect(chatSubdir(board, "web-app")).toBe("web-app");
  expect(chatSubdir(board, "")).toBeUndefined();
  expect(() => chatSubdir(board, "../Apps")).toThrow();
  expect(() => chatSubdir(board, join(board, "web-app"))).toThrow();
  expect(() => chatSubdir(board, "missing")).toThrow();
  expect(listFolders(board, null).folders.length).toBe(2);
});

test("a new chat in a subfolder keeps it; a bad one is refused", async () => {
  const create = (b: unknown) => fetch(`${base}/api/profiles/travelz/tickets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  let r = await create({ title: "chat", body: "", standalone: true, access: "edit", subdir: "web-app" });
  expect(r.status).toBe(201);
  expect(((await r.json()) as any).subdir).toBe("web-app");
  r = await create({ title: "chat", body: "", standalone: true, access: "edit", subdir: "../Apps" });
  expect(r.status).toBe(400);
});
