import { afterAll, expect, test } from "bun:test";
import { createPublicProxy } from "../src/server/public-proxy";

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
