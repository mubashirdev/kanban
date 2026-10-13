import { expect, test } from "bun:test";
import { checkTunnel, KeepAwake, nextTunnelStatus, startKeepAwake, type TunnelStatus } from "../src/server/away";
import { phoneAccessLabel } from "../web/src/awayText";

function fakeCaffeinate() {
  const holders: { killed: boolean; exit: () => void }[] = [];
  const spawn = () => {
    let exit = () => {};
    const holder = { killed: false, exit: () => exit(), kill: () => { holder.killed = true; }, exited: new Promise<void>((r) => { exit = r; }) };
    holders.push(holder);
    return holder;
  };
  return { holders, spawn };
}

test("keep awake holds one caffeinate while work is active and lets go when idle or stopped", async () => {
  const fake = fakeCaffeinate();
  const awake = new KeepAwake(fake.spawn);
  let active = 1;
  const stop = startKeepAwake(awake, () => active > 0);
  expect(awake.holding).toBe(true);
  awake.set(true);
  expect(fake.holders).toHaveLength(1);
  active = 0;
  awake.set(active > 0);
  expect(fake.holders[0].killed).toBe(true);
  expect(awake.holding).toBe(false);
  awake.set(true);
  stop();
  expect(fake.holders[1].killed).toBe(true);
  expect(awake.holding).toBe(false);
});

test("keep awake starts a new caffeinate when the old one exits by itself", async () => {
  const fake = fakeCaffeinate();
  const awake = new KeepAwake(fake.spawn);
  awake.set(true);
  fake.holders[0].exit();
  await Bun.sleep(0);
  expect(awake.holding).toBe(false);
  awake.set(true);
  expect(fake.holders).toHaveLength(2);
});

test("tunnel status keeps when it went offline and stays 'none' until a public link is seen", () => {
  const none: TunnelStatus = { state: "none", since: null, url: null };
  expect(nextTunnelStatus(none, { url: null, up: false }, "t1")).toEqual(none);
  const online = nextTunnelStatus(none, { url: "https://a.ngrok.app", up: true }, "t1");
  expect(online).toEqual({ state: "online", since: "t1", url: "https://a.ngrok.app" });
  expect(nextTunnelStatus(online, { url: "https://a.ngrok.app", up: true }, "t2").since).toBe("t1");
  // ngrok stopped: its API is gone, so the last known link is kept.
  const offline = nextTunnelStatus(online, { url: null, up: false }, "t3");
  expect(offline).toEqual({ state: "offline", since: "t3", url: "https://a.ngrok.app" });
  expect(nextTunnelStatus(offline, { url: null, up: false }, "t4").since).toBe("t3");
  expect(nextTunnelStatus(offline, { url: "https://a.ngrok.app", up: true }, "t5")).toEqual({ state: "online", since: "t5", url: "https://a.ngrok.app" });
  // A link saved in config before the daemon restarted counts as offline until checked.
  expect(nextTunnelStatus({ state: "none", since: null, url: "https://a.ngrok.app" }, { url: null, up: false }, "t6").state).toBe("offline");
});

test("tunnel check reads the https link from ngrok's API and treats ngrok error pages as down", async () => {
  const api = { tunnels: [{ public_url: "http://a.ngrok.app" }, { public_url: "https://a.ngrok.app" }] };
  const fetcher = (page: Response | Error) => (async (url: string | URL | Request) => {
    if (String(url).includes("4040")) return Response.json(api);
    if (page instanceof Error) throw page;
    return page;
  }) as typeof fetch;
  expect(await checkTunnel(fetcher(new Response("sign in", { status: 302 })))).toEqual({ url: "https://a.ngrok.app", up: true });
  expect(await checkTunnel(fetcher(new Response("offline", { status: 404, headers: { "ngrok-error-code": "ERR_NGROK_3200" } }))))
    .toEqual({ url: "https://a.ngrok.app", up: false });
  expect(await checkTunnel(fetcher(new Error("no internet")))).toEqual({ url: "https://a.ngrok.app", up: false });
  expect(await checkTunnel((async () => { throw new Error("ngrok not running"); }) as unknown as typeof fetch)).toEqual({ url: null, up: false });
});

test("phone access label says online, offline since a time, or not set up", () => {
  const now = new Date(2026, 9, 13, 23, 0);
  expect(phoneAccessLabel({ state: "online", since: null, url: "https://a" }, now)).toBe("Phone access: online");
  expect(phoneAccessLabel({ state: "offline", since: new Date(2026, 9, 13, 21, 4).toISOString(), url: "https://a" }, now))
    .toBe("Phone access: offline since 21:04");
  expect(phoneAccessLabel({ state: "offline", since: new Date(2026, 9, 12, 9, 5).toISOString(), url: "https://a" }, now))
    .toMatch(/^Phone access: offline since .*12.*, 09:05$/);
  expect(phoneAccessLabel({ state: "none", since: null, url: null }, now)).toBe("Phone access: not set up");
});
