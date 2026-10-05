import { timingSafeEqual } from "node:crypto";

export interface LanAccess {
  host: string;
  token: string;
}

const COOKIE = "ckanban_lan";

function matches(value: string, token: string): boolean {
  const a = Buffer.from(value);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
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
    return new Response(null, {
      status: 303,
      headers: {
        location: "/",
        // Lax carries the cookie through top-level GET redirects from chat/email links.
        // Mutations and WebSocket upgrades still require an exact matching Origin.
        "set-cookie": `${COOKIE}=${lan.token}; Path=/; HttpOnly; SameSite=Lax`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }
  const authenticated = (req.headers.get("cookie") ?? "").split(";").some((part) => {
    const value = part.trim();
    return value.startsWith(`${COOKIE}=`) && matches(value.slice(COOKIE.length + 1), lan.token);
  });
  if (authenticated) return;
  return new Response("Open the private LAN access link printed by ckanban on your Mac.", {
    status: 401,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}
