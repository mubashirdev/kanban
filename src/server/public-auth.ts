import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "__Host-esa-session";
const LIFETIME = 30 * 24 * 60 * 60;
export interface PublicLogin { username: string; password: string }
const equal = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/** Signed, persistent sessions survive proxy restarts without storing browser passwords. */
export class PublicAuth {
  private key: Buffer;
  private failures = 0;
  private windowEnds = 0;
  constructor(private login: PublicLogin, secret: string, private now = () => Date.now()) {
    if (!login.username || !login.password) throw new Error("Public sign-in requires a username and password");
    this.key = createHmac("sha256", secret).update(`esa-session\0${login.username}\0${login.password}`).digest();
  }
  private sign(value: string) { return createHmac("sha256", this.key).update(value).digest("base64url"); }
  sessionID(req: Request) {
    return req.headers.get("cookie")?.split(";").map((v) => v.trim()).find((v) => v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) ?? "";
  }
  hasSession(req: Request) {
    const value = this.sessionID(req), match = /^(\d{10})\.([\w-]{24})\.([\w-]{43})$/.exec(value);
    return !!match && Number(match[1]) > Math.floor(this.now() / 1000) && equal(match[3], this.sign(`${match[1]}.${match[2]}`));
  }
  cookie() {
    const value = `${Math.floor(this.now() / 1000) + LIFETIME}.${randomBytes(18).toString("base64url")}`;
    return `${SESSION_COOKIE}=${value}.${this.sign(value)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${LIFETIME}`;
  }
  clearCookie() { return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`; }
  stripCookie(headers: Headers) {
    const remaining = (headers.get("cookie") ?? "").split(";").filter((v) => v.trim() && !v.trim().startsWith(`${SESSION_COOKIE}=`)).join(";");
    if (remaining) headers.set("cookie", remaining); else headers.delete("cookie");
  }
  async signIn(req: Request): Promise<Response> {
    if (this.now() >= this.windowEnds) { this.failures = 0; this.windowEnds = this.now() + 60_000; }
    if (this.failures >= 10) return loginPage("Too many attempts. Please wait a minute and try again.", 429, { "retry-after": "60" });
    if (!req.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return loginPage("Please use the sign-in form.", 415);
    const reader = req.body?.getReader();
    if (!reader) return loginPage("Enter your username and password.", 400);
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return loginPage("The sign-in request was too large.", 413); }
      chunks.push(value);
    }
    const fields = new URLSearchParams(Buffer.concat(chunks).toString());
    const userMatches = equal(fields.get("username") ?? "", this.login.username), passwordMatches = equal(fields.get("password") ?? "", this.login.password);
    if (!userMatches || !passwordMatches) { this.failures++; return loginPage("Username or password is incorrect.", 401); }
    return new Response(null, { status: 303, headers: { location: "/auth/setup", "set-cookie": this.cookie(), "cache-control": "no-store" } });
  }
}

/** Self-contained so a logged-out PWA can sign in without fetching protected assets. */
export function loginPage(error = "", status = 200, extra: Record<string, string> = {}, setup = false) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Esa Kanban"><title>Sign in · Esa Kanban</title><link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"><link rel="apple-touch-icon" sizes="180x180" href="/icons/esa-apple-touch.png?v=4"><link rel="icon" type="image/png" sizes="32x32" href="/icons/esa-32.png?v=4"><link rel="stylesheet" href="/pwa-shell.css"><script src="/pwa-shell.js"></script><script src="/auth/passkeys.js" defer></script><style>
  :root{color-scheme:light;--bg:#f6f5f1;--surface:#fff;--text:#1f1e1b;--muted:#74716a;--border:#e2dfd6;--accent:#c96442}
  @media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#1a1917;--surface:#242320;--text:#ecebe6;--muted:#9c998f;--border:#3a3834;--accent:#e0805e}}
  *{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:calc(48px + env(safe-area-inset-top)) 20px max(24px,env(safe-area-inset-bottom));background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}html[data-standalone] body{padding-top:calc(var(--standalone-top-gap) + 24px)}main{width:100%;max-width:380px;background:var(--surface);padding:28px;border:1px solid var(--border);border-radius:20px}h1{margin:0;font-size:26px}p{color:var(--muted);margin:8px 0 24px}label{display:block;margin:16px 0 6px;font-weight:600}input,button{width:100%;min-height:48px;border-radius:10px;font:inherit}input{padding:10px 12px;border:1px solid var(--border);background:var(--bg);color:var(--text)}input:focus{outline:2px solid var(--accent);outline-offset:2px}button{margin-top:24px;padding:12px;border:0;background:var(--accent);color:#fff;font-weight:600;cursor:pointer}button:disabled{opacity:.6;cursor:wait}button[hidden]{display:none}.secondary{background:var(--bg);color:var(--text);border:1px solid var(--border)}a{color:var(--accent)}button:focus-visible{outline:2px solid var(--text);outline-offset:3px}.error{margin:16px 0 0;color:var(--text);border-left:3px solid var(--accent);padding-left:12px}.note{font-size:13px;margin:20px 0 0}
  </style></head><body><div class="pwa-status-anchor" aria-hidden="true"></div><main><h1>Esa Kanban</h1>${setup ? '<p>Use Face ID or your device’s screen lock for your next sign-in.</p><button type="button" data-passkey="register">Enable Face ID / passkey</button><p id="passkey-status" role="status"></p><p><a href="/">Continue to Kanban</a></p>' : '<p>Sign in to your workspace.</p><button type="button" class="secondary" data-passkey="authenticate">Sign in with Face ID / passkey</button><p id="passkey-status" role="status"></p>'}${setup ? "" : `<form action="/auth/login" method="post"><label for="username">Username</label><input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>${error ? `<p class="error" role="alert">${error}</p>` : ""}<button type="submit">Sign in</button></form>`}<p class="note">This app keeps you signed in on this device for 30 days.</p></main></body></html>`, {
    status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; img-src 'self'; manifest-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", ...extra },
  });
}
