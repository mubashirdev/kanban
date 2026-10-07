#!/usr/bin/env bun
// Drives a throwaway board as a touch phone (320px and 390px) and fails on layout problems that only show up on real phones:
// tiny tap targets, round buttons squashed into ovals, sideways overflow, unlabelled icon buttons and tiny text.
// Needs Google Chrome installed. Usage: bun run audit:phone
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const PORT = 7791;
const BASE = `http://localhost:${PORT}`;
const home = mkdtempSync(join(tmpdir(), "ck-audit-home-"));
const repo = mkdtempSync(join(tmpdir(), "ck-audit-repo-"));

async function sh(cmd: string[], cwd: string) {
  const p = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore" });
  await p.exited;
}

async function api(path: string, body?: unknown) {
  const res = await fetch(`${BASE}/api${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return res.json() as Promise<any>;
}

await sh(["git", "init", "-q"], repo);
await sh(["git", "commit", "-q", "--allow-empty", "-m", "init"], repo);
const server = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "start"], {
  env: { ...process.env, CKANBAN_HOME: home, CKANBAN_PORT: String(PORT) }, stdout: "ignore", stderr: "ignore",
});

try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(BASE).then((r) => r.ok, () => false)) break;
    await Bun.sleep(200);
  }
  await api("/profiles", { name: "audit", path: repo });
  await api("/profiles/audit/tickets", { title: "Fix the login redirect loop on Safari", body: "Details.", status: "backlog" });
  await api("/profiles/audit/tickets", { title: "Plan the billing migration", body: "Details.", status: "planning" });
  const session = await api("/profiles/audit/tickets", { title: "Explain the build setup", body: "", agent: "claude", standalone: true });
  const ticket = await api("/profiles/audit/tickets", { title: "Add a dark mode toggle", body: "Details.", status: "review" });

  // Runs in the page: returns a list of problems on whatever is on screen.
  const findProblems = () => {
    const problems: string[] = [];
    const label = (e: Element) => (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 24) || String(e.className).slice(0, 24);
    const shown = (e: Element) => {
      const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && r.bottom > 0 && r.top < innerHeight;
    };
    document.querySelectorAll("button, a[href], summary, textarea, select, input:not([type=hidden])").forEach((e) => {
      if (!shown(e) || (e.tagName === "TEXTAREA" && e.closest(".composer-card"))) return; // the whole card focuses it
      const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      if (r.width < 32 || r.height < 32) problems.push(`tiny target ${Math.round(r.width)}x${Math.round(r.height)} "${label(e)}"`);
      if (cs.borderRadius.includes("50%") && Math.abs(r.width - r.height) > 2) problems.push(`not round ${Math.round(r.width)}x${Math.round(r.height)} "${label(e)}"`);
      const named = e.getAttribute("aria-label") || e.getAttribute("title") || (e.textContent || "").trim() || e.tagName !== "BUTTON";
      if (!named) problems.push(`unlabelled button ${String(e.className).slice(0, 30)}`);
    });
    document.querySelectorAll("body *").forEach((e) => {
      if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) || !shown(e)) return;
      if (parseFloat(getComputedStyle(e).fontSize) < 11) problems.push(`tiny text ${getComputedStyle(e).fontSize} "${label(e)}"`);
    });
    if (document.documentElement.scrollWidth > innerWidth) problems.push(`sideways overflow ${document.documentElement.scrollWidth}>${innerWidth}`);
    return [...new Set(problems)];
  };

  const browser = await chromium.launch({ channel: "chrome" });
  const failures: string[] = [];
  for (const width of [320, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 760 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const check = async (screen: string, setup: (p: Page) => Promise<void>) => {
      await setup(page);
      await page.waitForTimeout(1200);
      for (const problem of await page.evaluate(findProblems)) failures.push(`${width}px ${screen}: ${problem}`);
    };
    await page.goto(`${BASE}/#/audit`);
    await page.evaluate(() => sessionStorage.setItem("ck-inbox-landed", "1"));
    await page.reload();
    await page.waitForSelector(".tabbar");
    for (const lane of ["backlog", "planning", "review"]) await check(`board ${lane}`, (p) => p.locator(`button[data-column="${lane}"]`).click());
    await check("new ticket dialog", (p) => p.locator(".fab").click());
    await page.keyboard.press("Escape");
    await check("header menu", (p) => p.locator('button[aria-label="More"]').click());
    await page.keyboard.press("Escape");
    await check("daily cost sheet", async (p) => { await p.locator('button[aria-label="More"]').click(); await p.getByText("Daily cost").click(); });
    await page.keyboard.press("Escape");
    await check("notification sheet", async (p) => { if (await p.locator(".inbox-pill").count()) await p.locator(".inbox-pill").click(); });
    await page.keyboard.press("Escape");
    await check("long-press card sheet", async (p) => {
      await p.locator('button[data-column="backlog"]').click();
      await p.locator(".sortable-card").first().dispatchEvent("pointerdown", { clientX: 60, clientY: 300, pointerType: "touch", isPrimary: true, bubbles: true });
      await p.waitForTimeout(700);
    });
    await page.keyboard.press("Escape");
    await check("chats list", (p) => p.locator(".tabbar button").nth(1).click());
    await check("new chat dialog", (p) => p.locator(".fab").click());
    await page.keyboard.press("Escape");
    await check("session chat", (p) => p.goto(`${BASE}/#/audit/${session.id}`).then(() => undefined));
    await check("ticket chat", (p) => p.goto(`${BASE}/#/audit/${ticket.id}`).then(() => undefined));
    await context.close();
  }
  await browser.close();

  if (failures.length) {
    console.error(`Phone audit found ${failures.length} problem${failures.length === 1 ? "" : "s"}:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  } else console.log("Phone audit passed: 2 widths x 12 screens, no layout problems.");
} finally {
  server.kill();
}
