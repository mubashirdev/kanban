import { afterAll, expect, test } from "bun:test";
import { createPublicProxy } from "../src/server/public-proxy";
import { tempDir } from "./helpers";

const token = "b".repeat(64);
const publicOrigin = "https://kanban.example.test";
let upgrades = 0;
const backend = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req, server) {
    if (new URL(req.url).pathname === "/socket") {
      upgrades++;
      if (server.upgrade(req)) return;
    }
    if (new URL(req.url).pathname === "/events") return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: hello\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
    return Response.json({ host: req.headers.get("host"), origin: req.headers.get("origin"), secret: req.headers.get("x-kanban-gateway"), authorization: req.headers.get("authorization"), path: new URL(req.url).pathname });
  },
  websocket: { message(ws, message) { ws.send(message); } },
});
const proxy = createPublicProxy({ publicOrigin, gatewayToken: token, upstream: `http://127.0.0.1:${backend.port}`, port: 0 });
const port = proxy.port;
const url = `http://127.0.0.1:${port}`;
const headers = { host: "kanban.example.test", "x-kanban-gateway": token, origin: publicOrigin };
afterAll(() => { proxy.stop(true); backend.stop(true); });

test("public bridge rejects missing secrets, spoofed hosts and cross-site mutations before forwarding", async () => {
  for (const h of [{ ...headers, "x-kanban-gateway": "wrong" }, { ...headers, host: "evil.test" }, { ...headers, origin: "https://evil.test" }, { ...headers, origin: "null" }]) {
    expect((await fetch(`${url}/api/write`, { method: "POST", headers: h })).status).toBe(403);
  }
  const noOrigin = { ...headers } as Record<string, string>; delete noOrigin.origin;
  expect((await fetch(`${url}/api/write`, { method: "POST", headers: noOrigin })).status).toBe(403);
  expect((await fetch(`${url}/api/read`, { headers: { ...headers, "sec-fetch-site": "cross-site" } })).status).toBe(403);
  expect((await fetch(url, { headers: noOrigin })).status).toBe(200);
});

test("validated requests rewrite host/origin and do not leak gateway or login credentials", async () => {
  const response = await fetch(`${url}/api/read`, { headers: { ...headers, authorization: "Basic sensitive" } });
  expect(await response.json()).toEqual({ host: `127.0.0.1:${backend.port}`, origin: `http://127.0.0.1:${backend.port}`, secret: null, authorization: null, path: "/api/read" });
});

test("server-sent events stream without waiting for the response to finish", async () => {
  const response = await fetch(`${url}/events`, { headers, signal: AbortSignal.timeout(2000) });
  const reader = response.body!.getReader();
  const chunk = await reader.read();
  expect(new TextDecoder().decode(chunk.value)).toBe("data: hello\n\n");
  await reader.cancel();
});

test("tools WebSocket streams text and binary; foreign origins cannot reach the upstream", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers });
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
  const text = new Promise((resolve) => { ws.onmessage = (event) => resolve(event.data); });
  ws.send("terminal input"); expect(await text).toBe("terminal input");
  const binary = new Promise((resolve) => { ws.onmessage = (event) => resolve(new Uint8Array(event.data)); });
  ws.send(new Uint8Array([1, 2, 3])); expect(await binary).toEqual(new Uint8Array([1, 2, 3]));
  ws.close();
  const before = upgrades;
  const bad = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers: { ...headers, origin: "https://evil.test" } });
  await new Promise<void>((resolve) => { bad.onerror = () => resolve(); bad.onclose = () => resolve(); });
  expect(upgrades).toBe(before);
});

test("PWA form login protects APIs and sockets, keeps sessions after restart, and gates passkey registration", async () => {
  const options = { publicOrigin, gatewayToken: token, upstream: `http://127.0.0.1:${backend.port}`, port: 0, login: { username: "owner", password: "test-only" }, passkeyFile: `${tempDir()}/passkeys.json` };
  let secured = createPublicProxy(options);
  try {
    const base = () => `http://127.0.0.1:${secured.port}`;
    const loginPage = await fetch(base(), { headers });
    expect(loginPage.status).toBe(200); expect(await loginPage.text()).toContain('form action="/auth/login"');
    expect(loginPage.headers.get("cache-control")).toBe("no-store");
    expect(loginPage.headers.get("referrer-policy")).toBe("same-origin");
    expect(loginPage.headers.get("content-security-policy")).toContain("style-src 'self'");
    for (const [path, type] of [["/pwa-shell.js", "javascript"], ["/pwa-shell.css", "text/css"]]) {
      const shell = await fetch(base() + path, { headers });
      expect(shell.status).toBe(200);
      expect(shell.headers.get("content-type")).toContain(type);
      expect(shell.headers.get("cache-control")).toBe("no-cache");
      expect((await fetch(base() + path, { headers: { ...headers, origin: "https://evil.test" } })).status).toBe(403);
    }
    expect((await fetch(base() + "/api/read", { headers })).status).toBe(401);
    const enroll = "/auth/passkey/register/options";
    expect((await fetch(base() + enroll, { method: "POST", headers })).status).toBe(401);
    expect((await fetch(base() + "/auth/login", { method: "POST", headers: { ...headers, origin: "https://evil.test" }, body: new URLSearchParams({ username: "owner", password: "test-only" }) })).status).toBe(403);
    const loggedIn = await fetch(base() + "/auth/login", { method: "POST", headers, body: new URLSearchParams({ username: "owner", password: "test-only" }), redirect: "manual" });
    expect(loggedIn.status).toBe(303);
    const cookie = loggedIn.headers.get("set-cookie")!.split(";")[0], signed = { ...headers, cookie };
    expect((await fetch(base() + "/api/read", { headers: signed })).status).toBe(200);
    const optionsResponse = await fetch(base() + enroll, { method: "POST", headers: signed });
    const registration = await optionsResponse.json() as any;
    expect(registration.authenticatorSelection.userVerification).toBe("required");
    expect(registration.authenticatorSelection.residentKey).toBe("required");
    expect(registration.rp.id).toBe("kanban.example.test");
    const challenge = optionsResponse.headers.get("set-cookie")!.split(";")[0];
    const verify = () => fetch(base() + "/auth/passkey/register/verify", { method: "POST", headers: { ...signed, cookie: cookie + "; " + challenge, "content-type": "application/json" }, body: JSON.stringify({ id: "forged" }) });
    expect((await verify()).status).toBe(400); expect((await verify()).status).toBe(400);
    secured.stop(true); secured = createPublicProxy(options);
    expect((await fetch(base() + "/api/read", { headers: signed })).status).toBe(200);
    const before = upgrades;
    const denied = new WebSocket(`ws://127.0.0.1:${secured.port}/socket`, { headers });
    await new Promise<void>((resolve) => { denied.onerror = () => resolve(); denied.onclose = () => resolve(); });
    expect(upgrades).toBe(before);
    const ws = new WebSocket(`ws://127.0.0.1:${secured.port}/socket`, { headers: signed });
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
    expect(upgrades).toBe(before + 1); ws.close();
    const logout = await fetch(base() + "/auth/logout", { method: "POST", headers: signed, redirect: "manual" });
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  } finally { secured.stop(true); }
});

test("Safari installation metadata and real photo icons load without a session, while app data stays protected", async () => {
  const secured = createPublicProxy({ publicOrigin, gatewayToken: token, upstream: `http://127.0.0.1:${backend.port}`, port: 0, login: { username: "owner", password: "test-only" } });
  const base = `http://127.0.0.1:${secured.port}`;
  // Safari's home-screen icon probe does not send Origin or the PWA's cookie.
  const probe = { host: "kanban.example.test", "x-kanban-gateway": token };
  try {
    for (const path of ["/", "/auth/login", "/auth/setup"]) {
      const page = await fetch(base + path, { headers: probe });
      const html = await page.text();
      expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="/icons/esa-apple-touch.png?v=2"');
      expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
      expect(page.headers.get("content-security-policy")).toContain("img-src 'self'");
      expect(page.headers.get("content-security-policy")).toContain("manifest-src 'self'");
    }
    const metadata = await fetch(base + "/manifest.webmanifest", { headers: probe });
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("content-type")).toContain("application/manifest+json");
    const manifest = await metadata.json() as { name: string; icons: { src: string }[] };
    expect(manifest.name).toBe("Esa Kanban");
    for (const path of ["/icons/esa-apple-touch.png?v=2", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/icons/esa-32.png", ...manifest.icons.map((icon) => icon.src)]) {
      const icon = await fetch(base + path, { headers: probe });
      expect(icon.status).toBe(200);
      expect(icon.headers.get("content-type")).toBe("image/png");
      expect(icon.headers.get("cache-control")).toBe("no-cache");
      expect([...new Uint8Array(await icon.arrayBuffer()).slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
    for (const path of ["/api/read", "/icons/private.png", "/assets/app.js"]) expect((await fetch(base + path, { headers: probe })).status).toBe(401);
    expect((await fetch(base + "/icons/esa-apple-touch.png", { method: "POST", headers })).status).toBe(401);
    expect((await fetch(base + "/icons/esa-apple-touch.png", { headers: { ...probe, "x-kanban-gateway": "wrong" } })).status).toBe(403);
  } finally { secured.stop(true); }
});
