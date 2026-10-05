import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

/** Cache public UI files only. Navigations always authenticate against the server. */
export function serviceWorkerSource(version: string, files: string[]): string {
  return `const CACHE = ${JSON.stringify(`ckanban-ui-${version}`)};
const FILES = ${JSON.stringify(files)};
const allowed = new Set(FILES);
const valid = (path, response) => response.ok && !response.redirected &&
  (response.headers.get('content-type') || '').includes(path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
self.addEventListener('install', event => event.waitUntil((async () => {
  const responses = await Promise.all(FILES.map(async path => {
    const response = await fetch(new Request(path, { credentials: 'include', cache: 'reload' }));
    if (!valid(path, response)) throw new Error('Could not cache Kanban UI');
    return [path, response];
  }));
  const cache = await caches.open(CACHE);
  await Promise.all(responses.map(([path, response]) => cache.put(path, response)));
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('ckanban-ui-') && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));
// Wait until the user chooses to reload, or every old tab is closed.
self.addEventListener('message', event => { if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting(); });
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    event.respondWith(fetch(request).catch(async () => {
      const response = await (await caches.open(CACHE)).match('/offline.html');
      return response || new Response('Kanban is offline. Reconnect and try again.', { status: 503, headers: { 'content-type': 'text/plain' } });
    }));
  } else if (!url.search && allowed.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE), saved = await cache.match(url.pathname);
      if (saved) return saved;
      const response = await fetch(request);
      if (valid(url.pathname, response)) await cache.put(url.pathname, response.clone());
      return response;
    })());
  }
});
`;
}

export function pwaPlugin(): Plugin {
  return {
    name: "kanban-pwa", apply: "build",
    generateBundle(_options, bundle) {
      const publicFiles = ["offline.html", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/kanban.svg"];
      const assets = Object.keys(bundle).filter((file) => file.startsWith("assets/") && /\.(js|css)$/.test(file));
      const hash = createHash("sha256");
      for (const output of Object.values(bundle)) hash.update(output.type === "chunk" ? output.code : output.source);
      for (const file of [...publicFiles, "manifest.webmanifest"]) hash.update(readFileSync(new URL(`./public/${file}`, import.meta.url)));
      this.emitFile({ type: "asset", fileName: "sw.js", source: serviceWorkerSource(hash.digest("hex").slice(0, 16), [...publicFiles, ...assets].map((file) => `/${file}`)) });
    },
  };
}
