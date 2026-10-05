import { timingSafeEqual } from "node:crypto";

export interface LanAccess {
  host: string;
  token: string;
  pairingCode?: string;
}

const COOKIE = "ckanban_lan";

function matches(value: string, token: string): boolean {
  const a = Buffer.from(value);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signedIn(lan: LanAccess, location = "/"): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      // Lax carries the cookie through top-level GET redirects from chat/email links.
      // Mutations and WebSocket upgrades still require an exact matching Origin.
      "set-cookie": `${COOKIE}=${lan.token}; Path=/; HttpOnly; SameSite=Lax`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function pairingPage(message = "", status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Connect to Kanban</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;font:16px/1.5 system-ui,sans-serif;background:#f7f5f0;color:#26251f}
main{width:100%;max-width:420px;padding:32px;border:1px solid #e5e0d6;border-radius:20px;background:#fff}h1{font-size:26px;line-height:1.2;margin:0 0 12px}p{color:#69665d;margin:0 0 24px}label{display:block;font-weight:600;margin-bottom:8px}input,button{width:100%;min-height:48px;border-radius:10px;font:inherit}input{padding:12px;border:1px solid #b7b1a5;font-family:ui-monospace,monospace}input:focus-visible,button:focus-visible{outline:3px solid #db977d;outline-offset:3px}button{margin-top:16px;border:0;background:#c96544;color:white;font-weight:600;cursor:pointer}.error{color:#9f2e22;margin:16px 0 0}@media(max-width:360px){main{padding:24px}body{padding:16px}}</style></head>
<body><main><h1>Connect to Kanban</h1><p>Enter the pairing code shown on your Mac to open your board.</p>
<form action="/lan/sign-in" method="post"><label for="code">Pairing code</label><input id="code" name="code" type="text" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" maxlength="32" required placeholder="xxxx-xxxx-xxxx">
<button type="submit">Open board</button>${message ? `<p class="error" role="alert">${message}</p>` : ""}</form></main></body></html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

/** Per-daemon sign-in state. Limit guesses and bound request bodies before reading codes. */
export function createLanSignIn(lan: LanAccess) {
  const attempts = new Map<string, { count: number; until: number }>();
  return async (req: Request, peer: string | undefined): Promise<Response> => {
    const host = req.headers.get("host") ?? new URL(req.url).host;
    if (req.headers.get("origin") !== `http://${host}`) return new Response("forbidden", { status: 403 });
    if (!lan.pairingCode) return new Response("not found", { status: 404 });
    const time = Date.now();
    for (const [ip, entry] of attempts) if (entry.until <= time) attempts.delete(ip);
    const key = peer ?? "unknown";
    const entry = attempts.get(key) ?? { count: 0, until: time + 60_000 };
    if (entry.count >= 10) {
      const response = pairingPage("Too many attempts. Try again in one minute.", 429);
      response.headers.set("retry-after", String(Math.ceil((entry.until - time) / 1000)));
      return response;
    }
    if (attempts.size >= 4096) return pairingPage("Please try again in one minute.", 429);
    entry.count++;
    attempts.set(key, entry);
    if (!req.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return pairingPage("Enter your pairing code using this form.", 415);
    const reader = req.body?.getReader();
    if (!reader) return pairingPage("Enter your pairing code.", 400);
    let body = "";
    let size = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 256) { await reader.cancel(); return pairingPage("Pairing code is too long.", 413); }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } finally { reader.releaseLock(); }
    const code = (new URLSearchParams(body).get("code") ?? "").replace(/[\s-]/g, "").toLowerCase();
    if (!matches(code, lan.pairingCode)) return pairingPage("That code did not match. Check the code shown on your Mac.", 401);
    attempts.delete(key);
    return signedIn(lan, "/?paired=1");
  };
}

/** Local CLI requests stay unauthenticated; LAN requests need the private link's cookie. */
export function authorizeLan(req: Request, peer: string | undefined, lan: LanAccess): Response | undefined {
  const url = new URL(req.url);
  const host = req.headers.get("host") ?? url.host;
  const localPeer = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  const localHost = host === `localhost:${url.port}` || host === `127.0.0.1:${url.port}`;
  if (localPeer && localHost) return;

  // Exchange the link for an HttpOnly cookie before serving any UI or assets.
  if (req.method === "GET" && url.pathname === "/" && matches(url.searchParams.get("access") ?? "", lan.token)) {
    return signedIn(lan);
  }
  const authenticated = (req.headers.get("cookie") ?? "").split(";").some((part) => {
    const value = part.trim();
    return value.startsWith(`${COOKIE}=`) && matches(value.slice(COOKIE.length + 1), lan.token);
  });
  if (authenticated) {
    if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("paired")) {
      return new Response(null, { status: 303, headers: { location: "/", "cache-control": "no-store" } });
    }
    return;
  }
  if (lan.pairingCode && req.method === "GET" && url.pathname === "/") {
    return pairingPage(url.searchParams.has("paired") ? "Your browser did not save the sign-in cookie. Open this address in Safari or Chrome with cookies enabled." : "");
  }
  return new Response("Open the private LAN access link printed by ckanban on your Mac.", {
    status: 401,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}
