// Fills Leo's static files with our brand at build time, so his index.html, manifest and sw.js stay untouched.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { BRAND } from "../src/addons/brand";

/** Leo's manifest with our name and icons. Also used by the phone login proxy (src/server/addons/public-proxy.ts). */
export function brandManifest(json: string) {
  return {
    ...JSON.parse(json),
    name: BRAND.name,
    short_name: BRAND.name,
    icons: [
      { src: BRAND.icons.png192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: BRAND.icons.png512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: BRAND.icons.png512, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

export function brandPlugin(): Plugin {
  let outDir = "";
  return {
    name: "muba-brand",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    transformIndexHtml(html) {
      return html
        .replace(/<title>ckanban<\/title>/, `<title>${BRAND.name}</title>`)
        .replace(/(apple-mobile-web-app-title" content=")ckanban"/, `$1${BRAND.name}"`)
        .replace(/<link rel="apple-touch-icon"[^>]*>/, `<link rel="apple-touch-icon" href="${BRAND.icons.appleTouch}" />`)
        .replace(/<link rel="icon" href="[^"]*" \/>/, `<link rel="icon" type="image/png" sizes="32x32" href="${BRAND.icons.png32}" />`);
    },
    writeBundle() {
      const manifestPath = join(outDir, "manifest.webmanifest");
      writeFileSync(manifestPath, JSON.stringify(brandManifest(readFileSync(manifestPath, "utf8")), null, 2) + "\n");

      const swPath = join(outDir, "sw.js");
      const sw = readFileSync(swPath, "utf8")
        .replace('data.title || "ckanban"', `data.title || ${JSON.stringify(BRAND.name)}`)
        .replaceAll('"/icon-192.png"', JSON.stringify(BRAND.icons.png192));
      writeFileSync(swPath, sw);
    },
  };
}
