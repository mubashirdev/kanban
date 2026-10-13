import { createHmac, timingSafeEqual } from "node:crypto";
import type { Server } from "bun";
import { PublicAuth, loginPage, type PublicLogin } from "./public-auth";
import { PublicPasskeys } from "./public-passkeys";
import { previewPortAllowed } from "./preview";

export interface PublicProxyOptions {
  publicOrigin: string;
  gatewayToken: string;
  upstream: string;
  port?: number;
  login?: PublicLogin;
  passkeyFile?: string;
  /** Second HTTPS origin (its own ngrok domain) where a ticket's dev server opens, away from the board's cookies and API. */
  previewOrigin?: string;
}
interface Relay {
  upstream: WebSocket;
  pending: (string | ArrayBuffer)[];
  bytes: number;
  ended?: number;
}
const PREVIEW_COOKIE = "__Host-ck-preview";
const PREVIEW_LIFETIME = 12 * 60 * 60;
const cookieValue = (req: Request, name: string) =>
  req.headers.get("cookie")?.split(";").map((v) => v.trim()).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
const equalText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const note = (text: string, status: number, back?: string) => new Response(
  `<!doctype html><meta name=viewport content="width=device-width"><title>Open the app</title><p style="font:16px system-ui;margin:2em">${text}</p>` +
  (back ? `<p style="font:16px system-ui;margin:2em"><a href="${back}">Back to the board</a></p>` : ""),
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
);
const closeCode = (code: number) => [1004, 1005, 1006, 1015].includes(code) || code < 1000 ? 1011 : code;
// Safari fetches installation metadata/icons separately, often without a session cookie.
// Only these fixed branding and layout assets are public; board assets/data still require sign-in.
const PUBLIC_ASSETS: Record<string, readonly [string, string]> = {
  "/pwa-shell.js": ["pwa-shell.js", "application/javascript"],
  "/pwa-shell.css": ["pwa-shell.css", "text/css"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
  "/icons/esa-192.png": ["icons/esa-192.png", "image/png"],
  "/icons/esa-512.png": ["icons/esa-512.png", "image/png"],
  "/icons/esa-32.png": ["icons/esa-32.png", "image/png"],
  "/icons/esa-apple-touch.png": ["icons/esa-apple-touch.png", "image/png"],
  "/apple-touch-icon.png": ["icons/esa-apple-touch.png", "image/png"],
  "/apple-touch-icon-precomposed.png": ["icons/esa-apple-touch.png", "image/png"],
};

/** Loopback bridge behind an authenticated ngrok endpoint. Validate before rewriting origins. */
export function createPublicProxy(options: PublicProxyOptions) {
  const origin = new URL(options.publicOrigin);
  const upstream = new URL(options.upstream);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("Public origin must be an HTTPS origin");
  }
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1") throw new Error("Upstream must be loopback HTTP");
  if (!/^[a-f0-9]{64}$/.test(options.gatewayToken)) throw new Error("Gateway token must be 256-bit hex");
  const preview = options.previewOrigin ? new URL(options.previewOrigin) : null;
  if (preview && (preview.protocol !== "https:" || preview.pathname !== "/" || preview.search || preview.hash || preview.host === origin.host)) {
    throw new Error("Preview origin must be a separate HTTPS origin");
  }
  const previewKey = createHmac("sha256", options.gatewayToken).update("ckanban-preview").digest();
  const signPreview = (value: string) => createHmac("sha256", previewKey).update(value).digest("base64url");
  const token = Buffer.from(options.gatewayToken);
  const auth = options.login ? new PublicAuth(options.login, options.gatewayToken) : null;
  const passkeys = auth && options.passkeyFile ? new PublicPasskeys(origin.origin, options.login!.username, options.passkeyFile) : null;
  function fromGateway(req: Request) {
    const supplied = Buffer.from(req.headers.get("x-kanban-gateway") ?? "");
    return supplied.length === token.length && timingSafeEqual(supplied, token);
  }
  function allowed(req: Request, socket: boolean) {
    if (!fromGateway(req)) return false;
    if (req.headers.get("host") !== origin.host) return false;
    const requestOrigin = req.headers.get("origin");
    if (requestOrigin && requestOrigin !== origin.origin) return false;
    if ((socket || !["GET", "HEAD"].includes(req.method)) && requestOrigin !== origin.origin) return false;
    if (req.headers.get("sec-fetch-site") === "cross-site" && (socket || new URL(req.url).pathname.startsWith("/api/"))) return false;
    return true;
  }
  /** Relay one request (or WebSocket) to a loopback `target`; `headers` are already cleaned of our secrets. */
  async function forward(req: Request, server: Server<Relay>, socket: boolean, target: string, headers: Headers, down: string) {
    if (socket) {
      // Vite's HMR socket asks for a subprotocol ("vite-hmr"); pass it on and answer with the one the app picked.
      const protocols = headers.get("sec-websocket-protocol")?.split(",").map((p) => p.trim()).filter(Boolean) ?? [];
      headers.delete("sec-websocket-protocol");
      const remote = new WebSocket(target.replace(/^http:/, "ws:"), { headers: Object.fromEntries(headers), protocols });
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
        if (server.upgrade(req, { data: relay, headers: remote.protocol ? { "sec-websocket-protocol": remote.protocol } : undefined })) return;
        remote.close();
      } catch { remote.close(); }
      return new Response("Tools are reconnecting. Please try again.", { status: 503 });
    }
    try {
      // Stream SSE and files directly, and cancel the upstream when the phone disconnects.
      return await fetch(target, { method: req.method, headers, body: req.body, redirect: "manual", signal: req.signal, decompress: false });
    } catch {
      return note(down, 503);
    }
  }
  function cleanHeaders(req: Request, host: string) {
    const headers = new Headers(req.headers);
    for (const key of ["x-kanban-gateway", "authorization", "proxy-authorization", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"]) headers.delete(key);
    headers.set("host", host);
    if (headers.has("origin")) headers.set("origin", `http://${host}`);
    return headers;
  }
  function stripCookies(headers: Headers, names: string[]) {
    const remaining = (headers.get("cookie") ?? "").split(";").filter((v) => v.trim() && !names.some((n) => v.trim().startsWith(`${n}=`))).join(";");
    if (remaining) headers.set("cookie", remaining); else headers.delete("cookie");
  }
  const previewBlocked = (server: Server<Relay>) => [Number(upstream.port), server.port!];

  /** The board's "Open the app" link: hand a one-minute pass to the preview origin, which turns it into its own cookie. */
  function openPreview(req: Request, server: Server<Relay>, path: string) {
    if (!preview) return note("Opening an app from the phone needs a preview address. Add <code>previewDomain</code> to the access settings (see README, Phone access).", 404, "/");
    if (req.headers.get("sec-fetch-site") === "cross-site") return new Response("Forbidden", { status: 403 });
    const port = Number(path.slice("/__preview/open/".length).split("/")[0]);
    if (!previewPortAllowed(port, previewBlocked(server))) return note("That port can't be opened here.", 400, "/");
    const exp = Math.floor(Date.now() / 1000) + 60;
    const pass = new URLSearchParams({ port: String(port), exp: String(exp), sig: signPreview(`enter.${port}.${exp}`) });
    return new Response(null, { status: 303, headers: { location: `${preview.origin}/__preview/enter?${pass}`, "cache-control": "no-store" } });
  }

  /** The preview origin maps its whole site to one local port (a cookie), so apps keep their root paths and HMR. */
  async function previewRequest(req: Request, server: Server<Relay>, socket: boolean) {
    const requestOrigin = req.headers.get("origin");
    if (!fromGateway(req) || (requestOrigin && requestOrigin !== preview!.origin)) return new Response("Forbidden", { status: 403 });
    if ((socket || !["GET", "HEAD"].includes(req.method)) && requestOrigin !== preview!.origin) return new Response("Forbidden", { status: 403 });
    const incoming = new URL(req.url);
    const blocked = previewBlocked(server);
    const fromBoard = `Open the app from a ticket's Preview tab on the board.`;
    if (incoming.pathname === "/__preview/enter") {
      const port = Number(incoming.searchParams.get("port")), exp = Number(incoming.searchParams.get("exp"));
      const valid = exp > Date.now() / 1000 && equalText(incoming.searchParams.get("sig") ?? "", signPreview(`enter.${port}.${exp}`));
      if (!valid || !previewPortAllowed(port, blocked)) return note(`This link has expired. ${fromBoard}`, 403, origin.origin);
      const until = Math.floor(Date.now() / 1000) + PREVIEW_LIFETIME;
      // The session names its one port, so the app's own code can't reach other local services through it.
      const cookie = `${until}.${port}.${signPreview(`session.${until}.${port}`)}`;
      return new Response(null, { status: 303, headers: {
        location: "/", "cache-control": "no-store",
        "set-cookie": `${PREVIEW_COOKIE}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${PREVIEW_LIFETIME}`,
      } });
    }
    const [until, port, sig] = cookieValue(req, PREVIEW_COOKIE).split(".").map((v, i) => (i < 2 ? Number(v) : v)) as [number, number, string];
    const signed = until > Date.now() / 1000 && equalText(sig ?? "", signPreview(`session.${until}.${port}`));
    if (!signed || !previewPortAllowed(port, blocked)) return note(fromBoard, 401, origin.origin);
    // /preview/<port>/... (the open app's link) drops the prefix; another port needs a new pass from the board.
    const prefixed = /^\/preview\/(\d+)(\/.*)?$/.exec(incoming.pathname);
    if (prefixed) {
      if (Number(prefixed[1]) !== port) return note(fromBoard, 403, origin.origin);
      return new Response(null, { status: 303, headers: { location: `/${(prefixed[2] ?? "").replace(/^\/+/, "")}${incoming.search}`, "cache-control": "no-store" } });
    }
    const headers = cleanHeaders(req, `localhost:${port}`);
    stripCookies(headers, [PREVIEW_COOKIE]);
    const response = await forward(req, server, socket, `http://localhost:${port}${incoming.pathname}${incoming.search}`, headers,
      `Nothing answers on port ${port}. Is the app still running? Start it again, then refresh.`);
    // Dev servers redirect to http://localhost:<port>/...; keep the phone on the preview origin.
    const location = response?.headers.get("location");
    const local = location && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d+)(\/.*)?$/.exec(location);
    if (!response || !local || Number(local[2]) !== port) return response;
    const rewritten = new Headers(response.headers);
    rewritten.set("location", local[3] ?? "/");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: rewritten });
  }

  return Bun.serve<Relay>({
    hostname: "127.0.0.1", port: options.port ?? 7778, idleTimeout: 0,
    async fetch(req, server) {
      const socket = req.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (preview && req.headers.get("host") === preview.host) return previewRequest(req, server, socket);
      if (!allowed(req, socket)) return new Response("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });
      const incoming = new URL(req.url);
      const asset = PUBLIC_ASSETS[incoming.pathname];
      if (asset && !socket && ["GET", "HEAD"].includes(req.method)) {
        return new Response(Bun.file(new URL(`../../web/public/${asset[0]}`, import.meta.url)), {
          headers: { "content-type": asset[1], "cache-control": "no-cache", "x-content-type-options": "nosniff" },
        });
      }
      if (auth) {
        if (incoming.pathname === "/auth/passkeys.js" && req.method === "GET") return new Response(Bun.file(new URL("../../web/public/passkeys.js", import.meta.url)), { headers: { "content-type": "application/javascript", "cache-control": "no-store" } });
        if (incoming.pathname.startsWith("/auth/passkey/") && req.method === "POST" && passkeys) return passkeys.handle(req, incoming.pathname.slice("/auth/passkey/".length), auth.hasSession(req) ? auth.sessionID(req) : "", () => auth.cookie());
        if (incoming.pathname === "/auth/login" && req.method === "POST") return auth.signIn(req);
        if (incoming.pathname === "/auth/logout" && req.method === "POST") return new Response(null, { status: 303, headers: { location: "/", "set-cookie": auth.clearCookie(), "cache-control": "no-store" } });
        if (incoming.pathname === "/auth/login" && ["GET", "HEAD"].includes(req.method)) return loginPage();
        if (incoming.pathname === "/auth/setup" && ["GET", "HEAD"].includes(req.method)) return loginPage("", 200, {}, auth.hasSession(req));
        if (!auth.hasSession(req)) {
          if (!socket && ["GET", "HEAD"].includes(req.method) && ["/", "/index.html"].includes(incoming.pathname)) return loginPage();
          return Response.json({ error: "Sign in to Muba AI", loginUrl: "/auth/login" }, { status: 401, headers: { "cache-control": "no-store" } });
        }
      }
      if (incoming.pathname.startsWith("/__preview/open/") && !socket && req.method === "GET") return openPreview(req, server, incoming.pathname);
      // Only the path/query come from the client; the upstream is fixed loopback.
      const headers = cleanHeaders(req, upstream.host);
      auth?.stripCookie(headers);
      passkeys?.stripCookie(headers);
      return forward(req, server, socket, `${upstream.origin}${incoming.pathname}${incoming.search}`, headers, "Kanban is starting. Please refresh in a few seconds.");
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
  const { join, dirname } = await import("node:path");
  const configPath = process.env.CKANBAN_ACCESS_CONFIG ?? join(homedir(), ".config/kanban-access/credentials.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const server = createPublicProxy({ publicOrigin: `https://${config.domain}`, gatewayToken: config.gatewayToken, upstream: "http://127.0.0.1:7777", login: { username: config.username, password: config.password }, passkeyFile: join(dirname(configPath), "passkeys.json"),
    previewOrigin: config.previewDomain ? `https://${config.previewDomain}` : undefined });
  console.log(`Protected bridge for https://${config.domain}${config.previewDomain ? ` (previews on https://${config.previewDomain})` : ""} listening on loopback:${server.port}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { server.stop(true); process.exit(0); });
}
