import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { serviceWorkerSource } from "../web/pwa";
import { readFileSync } from "node:fs";

const origin = "https://kanban.example";
const files = ["/offline.html", "/icons/icon-192.png", "/assets/app-abcd.js", "/assets/app-abcd.css"];

test("PWA layout detects Safari's standalone flag before render and follows display-mode changes", () => {
  const source = readFileSync(new URL("../web/public/pwa-shell.js", import.meta.url), "utf8");
  for (const [media, safari, expected] of [[false, false, false], [true, false, true], [false, true, true]]) {
    let active = false, changed: () => void = () => {};
    const mode = { matches: media, addEventListener: (_: string, fn: () => void) => { changed = fn; } };
    runInNewContext(source, { matchMedia: () => mode, navigator: { standalone: safari }, document: {
      documentElement: { toggleAttribute: (_: string, value: boolean) => { active = value; } },
    } });
    expect(active).toBe(expected);
    mode.matches = !media; changed();
    expect(active).toBe(!media || safari);
  }
});

function worker() {
  const handlers: Record<string, (event: any) => void> = {};
  const saved = new Map<string, Map<string, Response>>();
  const requested: Request[] = [];
  let response: (request: Request) => Response = (request) => new Response(new URL(request.url).pathname, {
    headers: { "content-type": request.url.endsWith(".js") ? "application/javascript" : request.url.endsWith(".css") ? "text/css" : request.url.endsWith(".png") ? "image/png" : "text/html" },
  });
  let offline = false, skipped = 0, claimed = 0;
  runInNewContext(serviceWorkerSource("test", files), {
    URL, Response,
    Request: class extends Request { constructor(input: string, options?: RequestInit) { super(new URL(input, origin).href, options); } },
    fetch: async (request: Request) => { requested.push(request); if (offline) throw new Error("offline"); return response(request); },
    self: { location: { origin }, addEventListener: (type: string, fn: any) => { handlers[type] = fn; },
      skipWaiting: () => { skipped++; }, clients: { claim: async () => { claimed++; } } },
    caches: {
      keys: async () => [...saved.keys()],
      delete: async (name: string) => saved.delete(name),
      open: async (name: string) => {
        if (!saved.has(name)) saved.set(name, new Map());
        const cache = saved.get(name)!;
        return { put: async (path: string, value: Response) => { cache.set(path, value.clone() as Response); }, match: async (path: string) => cache.get(path)?.clone() };
      },
    },
  });
  return {
    saved, requested,
    respond: (fn: typeof response) => { response = fn; },
    offline: () => { offline = true; },
    stats: () => ({ skipped, claimed }),
    lifecycle: async (type: string) => { let done: Promise<void> | undefined; handlers[type]({ waitUntil: (p: Promise<void>) => { done = p; } }); await done; },
    message: (type: string) => handlers.message({ data: { type } }),
    fetch: (path: string, init: RequestInit & { mode?: string } = {}) => {
      let result: Promise<Response> | undefined;
      // navigate mode cannot be constructed by user code; model the browser's request.
      const request = { url: new URL(path, origin).href, method: init.method ?? "GET", mode: init.mode ?? "cors" } as Request;
      handlers.fetch({ request, respondWith: (p: Promise<Response>) => { result = p; } });
      return result;
    },
  };
}

test("PWA installs only versioned UI files; activation waits for user or closed tabs", async () => {
  const w = worker(); await w.lifecycle("install");
  expect([...w.saved.get("ckanban-ui-test")!.keys()]).toEqual(files);
  expect(w.requested.every((request) => request.credentials === "include" && request.cache === "reload")).toBe(true);
  expect(w.stats().skipped).toBe(0);
  w.saved.set("ckanban-ui-old", new Map()); w.saved.set("another-app", new Map());
  await w.lifecycle("activate");
  expect([...w.saved.keys()]).toEqual(["ckanban-ui-test", "another-app"]);
  expect(w.stats().claimed).toBe(1);
  w.message("unknown"); expect(w.stats().skipped).toBe(0);
  w.message("ACTIVATE_UPDATE"); expect(w.stats().skipped).toBe(1);
});

test("PWA never intercepts API, SSE, login pages, mutations, query tokens or foreign origins", async () => {
  const w = worker(); await w.lifecycle("install");
  for (const path of ["/api/profiles", "/api/events", "/api/profiles/x/shell", "/auth/login", "/auth/setup", "/auth/passkeys.js", "/pwa-shell.js", "/pwa-shell.css", "/lan/sign-in", "/lan?token=secret", "/icons/icon-192.png?token=secret", "https://other.example/assets/app-abcd.js"])
    expect(w.fetch(path)).toBeUndefined();
  expect(w.fetch("/", { method: "POST" })).toBeUndefined();
  expect(w.fetch("/assets/unknown.js")).toBeUndefined();
});

test("PWA navigations stay network-only; offline shows reconnect page without board data", async () => {
  const w = worker(); await w.lifecycle("install");
  w.respond(() => new Response("live private board", { headers: { "content-type": "text/html" } }));
  expect(await (await w.fetch("/", { mode: "navigate" })!).text()).toBe("live private board");
  expect(w.saved.get("ckanban-ui-test")!.has("/")).toBe(false);
  w.offline();
  expect(await (await w.fetch("/index.html", { mode: "navigate" })!).text()).toBe("/offline.html");
  expect(await (await w.fetch("/assets/app-abcd.js")!).text()).toBe("/assets/app-abcd.js");
});

test("PWA preserves authentication failures instead of serving a cached board", async () => {
  const w = worker(); await w.lifecycle("install");
  w.respond(() => new Response("Sign in", { status: 401 }));
  expect((await w.fetch("/", { mode: "navigate" })!).status).toBe(401);
});

test("PWA refuses authentication errors and HTML masquerading as cached JavaScript", async () => {
  for (const status of [401, 200]) {
    const w = worker();
    w.respond(() => new Response("Sign in", { status, headers: { "content-type": "text/html" } }));
    await expect(w.lifecycle("install")).rejects.toThrow("Could not cache Kanban UI");
    expect(w.saved.size).toBe(0);
  }
});

test("push notifications tolerate bad payloads, use app icons and only open the app origin", async () => {
  const handlers: Record<string,(event:any)=>void>={},shown:any[]=[],opened:string[]=[];
  runInNewContext(serviceWorkerSource("push-test",[]),{URL,self:{location:{origin},addEventListener:(name:string,handler:any)=>{handlers[name]=handler;},registration:{showNotification:async(title:string,options:any)=>{shown.push({title,...options});}}},clients:{matchAll:async()=>[],openWindow:async(url:string)=>{opened.push(url);}}});
  for(const data of [null,{body:"Work is ready",url:"https://evil.example",tag:"test"},{body:"Question waiting",url:"/#/board/ticket"}]){let done:Promise<any>|undefined;handlers.push({data:{json:()=>data},waitUntil:(value:Promise<any>)=>{done=value;}});await done;}
  expect(shown).toHaveLength(3);expect(shown[0].body).toBe("A ticket has an update.");expect(shown[1].data.url).toBe("/");expect(shown[2].icon).toBe("/icons/esa-192.png");
  let done:Promise<any>|undefined;handlers.notificationclick({notification:{data:{url:"/#/board/ticket"},close:()=>{}},waitUntil:(value:Promise<any>)=>{done=value;}});await done;expect(opened).toEqual([origin+"/#/board/ticket"]);
  handlers.notificationclick({notification:{data:{url:"https://evil.example"},close:()=>{}},waitUntil:()=>{throw new Error("Foreign URL must not be opened");}});expect(opened).toHaveLength(1);
});
