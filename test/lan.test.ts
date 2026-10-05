import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { authorizeLan } from "../src/server/lan";
import { createServer, isAllowedRequest, isAllowedSocket } from "../src/server/http";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

const lan = { host: "127.0.0.2", token: "ab".repeat(32) };

test("LAN authorization uses the actual peer, not a forged localhost Host", () => {
  const req = new Request("http://localhost:7777/api/profiles");
  expect(authorizeLan(req, "127.0.0.1", lan)).toBeUndefined();
  expect(authorizeLan(req, "192.168.1.20", lan)?.status).toBe(401);
  expect(authorizeLan(req, undefined, lan)?.status).toBe(401);
});

test("LAN origins require the exact host, including on sockets", () => {
  const req = new Request(`http://${lan.host}:7777/api/x`, { method: "POST", headers: { origin: `http://${lan.host}:7777` } });
  expect(isAllowedRequest(req, 7777)).toBe(false);
  expect(isAllowedRequest(req, 7777, lan.host)).toBe(true);
  const socket = new Request(`http://${lan.host}:7777/api/x`, { headers: { origin: `http://${lan.host}:7777` } });
  expect(isAllowedSocket(socket, 7777, lan.host)).toBe(true);
  const foreign = new Request(socket.url, { headers: { origin: "http://localhost:7777" } });
  expect(isAllowedSocket(foreign, 7777, lan.host)).toBe(false);
  expect(isAllowedSocket(new Request(socket.url), 7777, lan.host)).toBe(false);
});

test("private LAN link authenticates UI, APIs and socket requests; defaults remain local", async () => {
  const store = new Store(tempDir("ck-lan-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  const webDir = tempDir("ck-lan-web-");
  writeFileSync(join(webDir, "index.html"), "<html>LAN board</html>");
  const server = createServer({ store, bus, board, port: 0, webDir, lan });
  const base = `http://127.0.0.1:${server.port}`;
  const host = `${lan.host}:${server.port}`;
  const origin = `http://${host}`;
  try {
    expect((await fetch(`${base}/api/profiles`)).status).toBe(200);
    for (const path of ["/", "/api/profiles", "/api/events", "/api/profiles/x/shell"]) {
      expect((await fetch(`${base}${path}`, { headers: { host } })).status).toBe(401);
    }
    expect((await fetch(`${base}/?access=wrong`, { headers: { host } })).status).toBe(401);
    const bootstrap = await fetch(`${base}/?access=${lan.token}`, { headers: { host }, redirect: "manual" });
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get("location")).toBe("/");
    expect(bootstrap.headers.get("referrer-policy")).toBe("no-referrer");
    expect(bootstrap.headers.get("cache-control")).toBe("no-store");
    const setCookie = bootstrap.headers.get("set-cookie")!;
    // Strict drops the cookie on the redirect when the link is clicked from another site.
    expect(setCookie).toContain("HttpOnly; SameSite=Lax");
    const cookie = setCookie.split(";")[0];
    const headers = { host, cookie, origin };
    expect((await (await fetch(base, { headers })).text())).toContain("LAN board");
    expect((await fetch(`${base}/api/profiles`, { headers })).status).toBe(200);
    const created = await fetch(`${base}/api/profiles`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "LAN", path: webDir }),
    });
    expect(created.status).toBe(201);
    expect((await fetch(`${base}/api/profiles/lan/shell`, { headers })).status).toBe(400); // Passed auth and Origin; requires upgrade.
    expect((await fetch(`${base}/api/profiles/lan/shell`, { headers: { host, cookie } })).status).toBe(403);
    expect((await fetch(`${base}/api/profiles`, { headers: { ...headers, origin: "http://evil.com" } })).status).toBe(403);
    expect((await fetch(`${base}/api/profiles`, { headers: { host, cookie: "ckanban_lan=wrong" } })).status).toBe(401);
    expect((await fetch(`${base}/api/profiles`, { headers: { ...headers, host: `evil.com:${server.port}` } })).status).toBe(403);
    // A daemon restart rotates the key and invalidates old browsers.
    expect(authorizeLan(new Request(`${origin}/`, { headers: { cookie } }), "192.168.1.20", { ...lan, token: "cd".repeat(32) })?.status).toBe(401);
  } finally {
    await server.stop(true);
  }
});
