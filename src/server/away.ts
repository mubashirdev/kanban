// Using the board from the phone while away from the Mac: keep the Mac awake while work runs (caffeinate) and check
// that the public link (an ngrok tunnel) is up, so the board can say "Phone access: offline since 21:04".

/** How often the daemon decides whether the Mac should stay awake. Released within this long after going idle. */
export const AWAKE_CHECK_MS = 15_000;
export const TUNNEL_CHECK_MS = 60_000;
/** ngrok's local agent API: lists the agent's tunnels and their public URLs. */
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";

interface Holder {
  kill(): void;
  exited: Promise<unknown>;
}

/** -i: no idle sleep, -s: no system sleep on power, -w: exits with the daemon even if it crashes. */
const caffeinate = (): Holder =>
  Bun.spawn(["caffeinate", "-i", "-s", "-w", String(process.pid)], { stdout: "ignore", stderr: "ignore" });

/** Holds one caffeinate process while wanted. */
export class KeepAwake {
  private holder: Holder | null = null;
  constructor(private spawn: () => Holder = caffeinate) {}

  get holding(): boolean {
    return !!this.holder;
  }

  set(want: boolean): void {
    if (want && !this.holder) {
      const holder = this.spawn();
      this.holder = holder;
      // If caffeinate dies on its own, the next check starts a new one.
      void holder.exited.then(() => { if (this.holder === holder) this.holder = null; });
    } else if (!want && this.holder) {
      this.holder.kill();
      this.holder = null;
    }
  }
}

/** Checks every AWAKE_CHECK_MS; the returned stop() lets the Mac sleep again. */
export function startKeepAwake(awake: KeepAwake, wanted: () => boolean): () => void {
  const check = () => awake.set(wanted());
  check();
  const timer = setInterval(check, AWAKE_CHECK_MS);
  return () => {
    clearInterval(timer);
    awake.set(false);
  };
}

export interface TunnelStatus {
  /** none: no public link was ever seen, so the user doesn't use phone access. */
  state: "online" | "offline" | "none";
  /** When the current state started (ISO). */
  since: string | null;
  url: string | null;
}

export interface TunnelCheck {
  url: string | null;
  up: boolean;
}

export function nextTunnelStatus(prev: TunnelStatus, check: TunnelCheck, now: string): TunnelStatus {
  const url = check.url ?? prev.url;
  if (!url) return { state: "none", since: null, url: null };
  const state = check.up ? "online" : "offline";
  return { state, since: prev.state === state && prev.since ? prev.since : now, url };
}

/** The tunnel's public HTTPS URL, then whether a request to it gets past ngrok (no ngrok error page). */
export async function checkTunnel(fetchFn: typeof fetch = fetch): Promise<TunnelCheck> {
  let url: string | null = null;
  try {
    const res = await fetchFn(NGROK_API, { signal: AbortSignal.timeout(3000) });
    const { tunnels = [] } = (await res.json()) as { tunnels?: { name?: string; public_url?: string }[] };
    // The "preview" tunnel is where a ticket's app opens (see README), not the board.
    url = tunnels.filter((t) => t.name !== "preview").map((t) => t.public_url).find((u) => u?.startsWith("https://")) ?? null;
  } catch {
    return { url: null, up: false };
  }
  if (!url) return { url: null, up: false };
  try {
    const res = await fetchFn(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return { url, up: !res.headers.has("ngrok-error-code") };
  } catch {
    return { url, up: false };
  }
}

export function startTunnelWatch(initialUrl: string | null, onChange: (status: TunnelStatus) => void,
  check: () => Promise<TunnelCheck> = checkTunnel): { status: () => TunnelStatus; stop: () => void } {
  let status: TunnelStatus = { state: "none", since: null, url: initialUrl };
  const tick = async () => {
    const next = nextTunnelStatus(status, await check(), new Date().toISOString());
    const changed = next.state !== status.state || next.url !== status.url;
    status = next;
    if (changed) onChange(status);
  };
  void tick();
  const timer = setInterval(() => void tick(), TUNNEL_CHECK_MS);
  return { status: () => status, stop: () => clearInterval(timer) };
}
