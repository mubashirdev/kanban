import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { brandPlugin } from "../web/addons/brand-plugin";

test("pwa-shell.js marks the installed app from display-mode or Safari's standalone flag, and follows changes", () => {
  const source = readFileSync(new URL("../web/public/addons/pwa-shell.js", import.meta.url), "utf8");
  for (const [media, safari, expected] of [[false, false, false], [true, false, true], [false, true, true]]) {
    let active = false, changed = () => {};
    const mode = { matches: media, addEventListener: (_: string, fn: () => void) => { changed = fn; } };
    runInNewContext(source, { matchMedia: () => mode, navigator: { standalone: safari }, document: {
      documentElement: { toggleAttribute: (_: string, value: boolean) => { active = value; } },
    } });
    expect(active).toBe(expected);
    mode.matches = !media; changed();
    expect(active).toBe(!media || safari);
  }
});

test("the brand plugin loads the status bar add-on into Leo's index.html", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const out = (brandPlugin().transformIndexHtml as (html: string) => string)(html);
  expect(out).not.toContain("apple-mobile-web-app-status-bar-style");
  expect(out).toContain('<link rel="stylesheet" href="/addons/pwa-shell.css" />');
  expect(out).toContain('<script src="/addons/pwa-shell.js"></script>\n  </head>');
  expect(out).toMatch(/<body>\s*<div class="pwa-status-anchor" aria-hidden="true"><\/div>\s*<div id="root">/);
});
