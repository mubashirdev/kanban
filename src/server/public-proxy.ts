import { timingSafeEqual } from "node:crypto";

export interface PublicProxyOptions {
  publicOrigin: string;
  gatewayToken: string;
  upstream: string;
  port?: number;
}
interface Relay {
  upstream: WebSocket;
  pending: (string | ArrayBuffer)[];
  bytes: number;
  ended?: number;
}
const closeCode = (code: number) => [1004, 1005, 1006, 1015].includes(code) || code < 1000 ? 1011 : code;

/** Loopback bridge behind an authenticated ngrok endpoint. Validate before rewriting origins. */
export function createPublicProxy(options: PublicProxyOptions) {
  const origin = new URL(options.publicOrigin);
  const upstream = new URL(options.upstream);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("Public origin must be an HTTPS origin");
  }
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1") throw new Error("Upstream must be loopback HTTP");
  if (!/^[a-f0-9]{64}$/.test(options.gatewayToken)) throw new Error("Gateway token must be 256-bit hex");
  const token = Buffer.from(options.gatewayToken);
  function allowed(req: Request, socket: boolean) {
    const supplied = Buffer.from(req.headers.get("x-kanban-gateway") ?? "");
    if (supplied.length !== token.length || !timingSafeEqual(supplied, token)) return false;
    if (req.headers.get("host") !== origin.host) return false;
    const requestOrigin = req.headers.get("origin");
    if (requestOrigin && requestOrigin !== origin.origin) return false;
    if ((socket || !["GET", "HEAD"].includes(req.method)) && requestOrigin !== origin.origin) return false;
    if (req.headers.get("sec-fetch-site") === "cross-site" && (socket || new URL(req.url).pathname.startsWith("/api/"))) return false;
    return true;
  }
  return Bun.serve<Relay>({
    hostname: "127.0.0.1", port: options.port ?? 7778, idleTimeout: 0,
    async fetch(req, server) {
      const socket = req.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (!allowed(req, socket)) return new Response("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });
      const incoming = new URL(req.url);
      // Only the path/query come from the client; the upstream is fixed loopback.
      const target = `${upstream.origin}${incoming.pathname}${incoming.search}`;
      const headers = new Headers(req.headers);
      for (const key of ["x-kanban-gateway", "authorization", "proxy-authorization", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"]) headers.delete(key);
      headers.set("host", upstream.host);
      if (headers.has("origin")) headers.set("origin", upstream.origin);
      if (socket) {
        const remote = new WebSocket(target.replace(/^http:/, "ws:"), { headers: Object.fromEntries(headers) });
        remote.binaryType = "arraybuffer";
        const relay: Relay = { upstream: remote, pending: [], bytes: 0 };
        remote.onmessage = (event) => {
          relay.bytes += typeof event.data === "string" ? Buffer.byteLength(event.data) : event.data.byteLength;
          if (relay.bytes > 2 * 1024 * 1024) { remote.close(1009, "Output queue full"); return; }
          relay.pending.push(event.data);
        };
        remote.onclose = (event) => { relay.ended = closeCode(event.code); };
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => { remote.close(); reject(new Error("Timed out")); }, 5000);
            remote.onopen = () => { clearTimeout(timeout); resolve(); };
            remote.onerror = () => { clearTimeout(timeout); reject(new Error("Upstream unavailable")); };
          });
          if (server.upgrade(req, { data: relay })) return;
          remote.close();
        } catch { remote.close(); }
        return new Response("Tools are reconnecting. Please try again.", { status: 503 });
      }
      try {
        // Stream SSE and files directly, and cancel the upstream when the phone disconnects.
        return await fetch(target, { method: req.method, headers, body: req.body, redirect: "manual", signal: req.signal, decompress: false });
      } catch {
        return new Response("Kanban is starting. Please refresh in a few seconds.", { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } });
      }
    },
    websocket: {
      maxPayloadLength: 2 * 1024 * 1024,
      backpressureLimit: 2 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        const relay = ws.data;
        for (const message of relay.pending) ws.send(message);
        relay.pending = []; relay.bytes = 0;
        relay.upstream.onmessage = (event) => { ws.send(event.data); };
        relay.upstream.onclose = (event) => { ws.close(closeCode(event.code)); };
        relay.upstream.onerror = () => { ws.close(1011); };
        if (relay.ended !== undefined) ws.close(relay.ended);
      },
      message(ws, message) {
        if (ws.data.upstream.readyState === WebSocket.OPEN) ws.data.upstream.send(message);
      },
      close(ws) { ws.data.upstream.close(); },
    },
  });
}

if (import.meta.main) {
  const { readFileSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const config = JSON.parse(readFileSync(process.env.CKANBAN_ACCESS_CONFIG ?? join(homedir(), ".config/kanban-access/credentials.json"), "utf8"));
  const server = createPublicProxy({ publicOrigin: `https://${config.domain}`, gatewayToken: config.gatewayToken, upstream: "http://127.0.0.1:7777" });
  console.log(`Protected bridge for https://${config.domain} listening on loopback:${server.port}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { server.stop(true); process.exit(0); });
}
