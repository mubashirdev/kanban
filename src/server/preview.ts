// Preview of a ticket's local dev server: which ports it listens on, which ports may be opened,
// and phone/desktop screenshots. The public bridge (public-proxy.ts) serves the preview itself.
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright-core";

export interface ListeningPort { port: number; command: string }

/** A preview may open any user port on this Mac except the board's own ones. */
export function previewPortAllowed(port: number, blocked: number[]): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && !blocked.includes(port);
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** The page to screenshot: a port, or a URL on this Mac. Anything else throws a plain-words error. */
export function previewTarget(input: { port?: unknown; url?: unknown }, blocked: number[]): string {
  let url: URL;
  if (input.port !== undefined && input.port !== null && input.port !== "") {
    const port = Number(input.port);
    if (!previewPortAllowed(port, blocked)) throw new Error(`Port ${input.port} can't be opened here`);
    url = new URL(`http://localhost:${port}/`);
  } else if (typeof input.url === "string" && input.url.trim()) {
    const text = input.url.trim();
    try { url = new URL(/^https?:\/\//.test(text) ? text : `http://${text}`); } catch { throw new Error("That address isn't a valid link"); }
  } else throw new Error("Give a port or a link");
  if (!["http:", "https:"].includes(url.protocol) || !LOCAL_HOSTS.includes(url.hostname) || url.username || url.password) {
    throw new Error("Only apps running on this Mac (localhost) can be opened");
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!previewPortAllowed(port, blocked)) throw new Error(`Port ${port} can't be opened here`);
  return url.href;
}

/** Ports listening on this Mac whose process runs in `folder` (or a folder inside it). */
export async function listeningPorts(folder: string, blocked: number[]): Promise<ListeningPort[]> {
  const listen = await output(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
  const byPid = new Map<string, { command: string; ports: Set<number> }>();
  let pid = "";
  for (const line of listen.split("\n")) {
    if (line[0] === "p") { pid = line.slice(1); byPid.set(pid, { command: "", ports: new Set() }); }
    else if (line[0] === "c") byPid.get(pid)!.command = line.slice(1);
    else if (line[0] === "n") {
      const port = Number(line.slice(line.lastIndexOf(":") + 1));
      if (previewPortAllowed(port, blocked)) byPid.get(pid)!.ports.add(port);
    }
  }
  const pids = [...byPid].filter(([, p]) => p.ports.size).map(([id]) => id);
  if (!pids.length) return [];
  const cwds = new Map<string, string>();
  for (const line of (await output(["lsof", "-a", "-d", "cwd", "-Fn", "-p", pids.join(",")])).split("\n")) {
    if (line[0] === "p") pid = line.slice(1);
    else if (line[0] === "n") cwds.set(pid, line.slice(1));
  }
  // lsof reports real paths (/private/tmp/... for /tmp/... on macOS).
  let real: string;
  try { real = realpathSync(folder); } catch { return []; }
  const found = new Map<number, ListeningPort>();
  for (const id of pids) {
    const cwd = cwds.get(id);
    if (!cwd || (cwd !== real && !cwd.startsWith(`${real}/`))) continue;
    for (const port of byPid.get(id)!.ports) found.set(port, { port, command: byPid.get(id)!.command });
  }
  return [...found.values()].sort((a, b) => a.port - b.port);
}

async function output(cmd: string[]): Promise<string> {
  // lsof exits 1 when nothing matches; that's an empty list, not an error.
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

/** Phone- and desktop-size screenshots of `url` in the installed Chrome, saved in `dir`/screenshots. Returns their paths inside `dir`. */
export async function takeScreenshots(url: string, dir: string, blocked: number[], now = new Date()): Promise<string[]> {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const port = new URL(url).port || "80";
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const sizes = [
      { name: "phone", options: devices["iPhone 13"] },
      { name: "desktop", options: { viewport: { width: 1440, height: 900 } } },
    ];
    return await Promise.all(sizes.map(async ({ name, options }) => {
      const page = await (await browser.newContext(options)).newPage();
      await page.goto(url, { waitUntil: "load", timeout: 10_000 });
      // Dev servers keep a socket open, so "network idle" may never come; don't wait long for it.
      await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});
      // A redirect must not take the screenshot off this Mac's apps (to the board, or the local network).
      try { previewTarget({ url: page.url() }, blocked); } catch { throw new Error(`the app sent the page to ${new URL(page.url()).host}, which can't be shown`); }
      const file = `screenshots/${port}-${name}-${stamp}.png`;
      await page.screenshot({ path: join(dir, file) });
      return file;
    }));
  } finally {
    await browser.close();
  }
}
