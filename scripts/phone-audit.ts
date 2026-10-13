#!/usr/bin/env bun
// Drives a throwaway board as phones, iPads and a desktop, in light and dark, and fails on layout problems:
// tap targets under 44px on touch screens, round buttons squashed into ovals, sideways overflow, controls cut off
// at the screen edge, unlabelled icon buttons, tiny text and text that is hard to read on its background.
// Needs Google Chrome installed. Usage: bun run audit:phone  (AUDIT_SHOTS=<existing folder> also saves a screenshot per screen)
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

// A free port, so audits from parallel tickets don't talk to each other's server.
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const PORT = probe.port;
probe.stop();
const DEVICES = [
  { name: "phone-320", width: 320, height: 760, touch: true },
  { name: "phone-390", width: 390, height: 844, touch: true },
  { name: "ipad-portrait", width: 834, height: 1194, touch: true },
  { name: "ipad-landscape", width: 1210, height: 834, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false },
];
const BASE = `http://localhost:${PORT}`;
// Problems other tickets are fixing, as "screen: problem" (sizes left out). They're counted but don't fail the run.
// Delete a line once its fix lands; the audit says when a line no longer matches anything.
const KNOWN: RegExp[] = [
  // No ticket yet: Changes tab controls and file letters, the "Your turn" pill next to an open ticket
  /^ticket changes: tiny target \S+ "(|Comment on line \d+|Msettings.ts|Atoggle.ts|▾src)" /,
  /^ticket changes: tiny text \S+ "[MA]"/,
  /^ticket (huddle( composer| people| findings)?|changes|outputs): tiny text \S+ "Your turn"/,
];
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

// A saved Claude conversation with the kinds of chat events a phone has to fit: tool steps, a diff, a table, a quote.
const sessionId = "11111111-1111-4111-8111-111111111111";
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 7, 10, 0, seconds)).toISOString();
const line = (type: string, content: unknown, seconds = 0) => JSON.stringify({ type, uuid: crypto.randomUUID(), timestamp: at(seconds), message: { role: type, content } });
const tool = (id: string, name: string, input: unknown) => [{ type: "tool_use", id, name, input }];
const result = (id: string, text: string, isError = false) => [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }];
const reply = "## Fix\nSet `SameSite=None` on the cookie.\n\n```diff\n-const lax = true;\n+const lax = false; // a long line that scrolls sideways instead of widening the page\n```\n\n| Browser | Result |\n|---|---|\n| Safari | ok |\n\n> Needs HTTPS in development.";
const commandAsk = { id: "ask1", tool: "Bash", detail: "rm -rf node_modules/.cache && bun test test/auth.test.ts --bail --coverage", canAlways: true };
const planAsk = { id: "ask2", tool: "ExitPlanMode", detail: "", plan: "## Plan\n1. Set `SameSite=None` on the session cookie.\n2. Add a Safari test for the redirect.\n3. Run `bun test test`." };
mkdirSync(join(home, "claude-cfg", "projects", "-audit"), { recursive: true });
writeFileSync(join(home, "claude-cfg", "projects", "-audit", `${sessionId}.jsonl`), [
  line("user", "Fix the redirect loop"),
  line("assistant", tool("t1", "Read", { file_path: "/repo/src/redirect.ts" }), 1),
  line("user", result("t1", "export function redirectAfterLogin() {}"), 2),
  line("assistant", tool("t2", "Bash", { command: "bun test test/auth.test.ts --bail --coverage --reporter=junit --timeout 20000" }), 3),
  line("user", result("t2", "1 fail\n  expected /home, got /login (auth.test.ts:42)", true), 9),
  line("assistant", tool("t3", "Edit", { file_path: "/repo/src/redirect.ts", old_string: "const lax = true;", new_string: "const lax = false; // a long line that scrolls sideways instead of widening the page" }), 10),
  line("user", result("t3", "File updated"), 11),
  line("assistant", [{ type: "tool_use", id: "h1", name: "Agent", input: { description: "Find every place that sets the session cookie", subagent_type: "Explore" } }], 11),
  line("user", result("h1", "Two places: src/auth/cookie.ts:14 and src/redirect.ts:3."), 11),
  line("assistant", [{ type: "tool_use", id: "h2", name: "Agent", input: { description: "Run the full auth test suite on Safari settings" } }], 11),
  line("assistant", [{ type: "text", text: reply }], 12),
].join("\n") + "\n");

await sh(["git", "init", "-q"], repo);
mkdirSync(join(repo, "src"));
writeFileSync(join(repo, "src", "settings.ts"), "export const theme = \"light\";\nexport const fontSize = 14;\n");
await sh(["git", "add", "-A"], repo);
await sh(["git", "commit", "-q", "-m", "init"], repo);
const baseSha = (await new Response(Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout).text()).trim();
// What the Changes tab shows: an edit with a long line and a new file, committed so the board's folder stays clean.
writeFileSync(join(repo, "src", "settings.ts"), "export const theme = \"dark\"; // a long line that scrolls sideways instead of widening the page\nexport const fontSize = 14;\n");
writeFileSync(join(repo, "src", "toggle.ts"), "export function toggleTheme() {\n  return true;\n}\n");
await sh(["git", "add", "-A"], repo);
await sh(["git", "commit", "-q", "-m", "dark mode"], repo);

// The Huddle, Changes and Outputs tabs of one ticket: a stopped huddle (so no Claude run starts), the commit above as
// its changes in the board's folder, and a report and an image in its outputs folder.
function seedPolish(id: string) {
  const board = join(home, "profiles", "audit");
  const ticketFile = join(board, "tickets", id, "ticket.md");
  writeFileSync(ticketFile, readFileSync(ticketFile, "utf8").replace(/^---\n/, `---\nbaseSha: ${baseSha}\n`));
  const outputs = join(board, "tickets", id, "outputs");
  mkdirSync(outputs, { recursive: true });
  writeFileSync(join(outputs, "report.md"), "# Settings review\n\nTL;DR: ship it after the contrast fix.\n\n| Screen | Result |\n|---|---|\n| Settings | ok |\n");
  writeFileSync(join(outputs, "mockup.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const person = (handle: string, role: string, kind: string, extra = {}) => ({
    handle, role, kind, preset: null, prompt: "", model: null, mode: "tagged", lead: handle === "main", canEdit: handle === "main", workspace: "shared",
    sessionId: null, status: "idle", cursor: 4, joinedAt: at(0), costUsd: 0.42, ...extra,
  });
  const hid = "h_audit";
  mkdirSync(join(board, "huddles"), { recursive: true });
  writeFileSync(join(board, "huddles", `${hid}.json`), JSON.stringify({
    id: hid, hostTicket: id, status: "stopped", stopReason: null, maxParticipants: 6, invited: [], seq: 5, maxCostUsd: 20, posts: 4,
    participants: [person("main", "Coordinator", "ticket-main", { ticketId: id }), person("reviewer", "Code reviewer", "agent", { preset: "reviewer" }), person("you", "You", "human")],
    findings: [{ id: "f1", text: "Settings toggle has low contrast in dark mode (settings.ts:1)", by: "reviewer", status: "open", resolvedBy: null, at: at(3) }],
    brief: { text: "Goal: review the settings page before it ships.", by: "main", at: at(0) },
    closeRequest: { by: "main", at: at(5), reason: "Review done: one finding is fixed and the settings page is ready to ship." },
    createdAt: at(0), updatedAt: at(4),
  }));
  const message = (seq: number, from: string, text: string, mentions: string[], kind = "message") => JSON.stringify({ id: `m${seq}`, seq, ts: at(seq), from, text, mentions, kind, source: "mcp" });
  writeFileSync(join(board, "huddles", `${hid}.messages.jsonl`), [
    message(1, "main", "@reviewer please review src/settings.ts and src/toggle.ts before this ships.", ["reviewer"]),
    message(2, "reviewer", "Looking now. The long line in settings.ts scrolls fine; checking the dark theme next.", []),
    message(3, "reviewer", "[MUST] settings.ts:1 - the toggle has low contrast in dark mode - use the accent color. @main", ["main"], "finding"),
    message(4, "main", "Thanks, fixing it. @you anything else before I land it?", ["you"]),
    JSON.stringify({ id: "m5", seq: 5, ts: at(5), from: "system", kind: "system", mentions: [], source: "none",
      text: "@main added @qa (QA tester: Try src/settings.ts and src/toggle.ts on a phone. Check the dark theme, the long lines, " +
        "the keyboard focus order and what a screen reader says for the toggle. Report each problem as a finding with the file and line.)." }),
  ].join("\n") + "\n");
}
const server = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "start"], {
  env: { ...process.env, CKANBAN_HOME: home, CKANBAN_PORT: String(PORT), CLAUDE_CONFIG_DIR: join(home, "claude-cfg") }, stdout: "ignore", stderr: "ignore",
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
  const events = await api("/profiles/audit/tickets", { title: "Fix the redirect loop", body: "", agent: "claude", standalone: true, sessionId });
  const polish = await api("/profiles/audit/tickets", { title: "Polish the settings page", body: "Details.", status: "review" });
  seedPolish(polish.id);

  // Runs in the page: returns a list of problems on whatever is on screen.
  const findProblems = (minTarget: number) => {
    const problems: string[] = [];
    const label = (e: Element) => (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 24) || String(e.className).slice(0, 24);
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    // Text color against the first solid background behind it; null when it can't tell (images, gradients, see-through).
    const contrast = (e: Element) => {
      const fg = getComputedStyle(e).color;
      if (!fg.startsWith("rgb") || rgb(fg)[3] < 1 || Number(getComputedStyle(e).opacity) < 1) return null;
      for (let a: Element | null = e; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.backgroundImage !== "none") return null;
        if (!cs.backgroundColor.startsWith("rgb")) return null;
        const bg = rgb(cs.backgroundColor);
        if (bg.length > 3 && bg[3] === 0) continue;
        if (bg.length > 3 && bg[3] < 1) return null;
        const [l1, l2] = [lum(rgb(fg)), lum(bg)].sort((x, y) => y - x);
        return (l1 + 0.05) / (l2 + 0.05);
      }
      return null;
    };
    const shown = (e: Element) => {
      const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && r.bottom > 0 && r.top < innerHeight;
    };
    document.querySelectorAll("button, a[href], summary, textarea, select, input:not([type=hidden])").forEach((e) => {
      if (!shown(e) || (e.tagName === "TEXTAREA" && e.closest(".composer-card"))) return; // the whole card focuses it
      const r = (e.closest("label") ?? e).getBoundingClientRect(), cs = getComputedStyle(e); // a label around a checkbox is its tap area
      if (r.width < minTarget || r.height < minTarget) problems.push(`tiny target ${Math.round(r.width)}x${Math.round(r.height)} "${label(e)}" (${e.tagName.toLowerCase()}.${String(e.className).replace(/ +/g, ".")})`);
      if (cs.borderRadius.includes("50%") && Math.abs(r.width - r.height) > 2) problems.push(`not round ${Math.round(r.width)}x${Math.round(r.height)} "${label(e)}"`);
      const named = e.getAttribute("aria-label") || e.getAttribute("title") || (e.textContent || "").trim() || e.tagName !== "BUTTON";
      if (!named) problems.push(`unlabelled button ${String(e.className).slice(0, 30)}`);
    });
    document.querySelectorAll("body *").forEach((e) => {
      if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) || !shown(e)) return;
      if (parseFloat(getComputedStyle(e).fontSize) < 11) problems.push(`tiny text ${getComputedStyle(e).fontSize} "${label(e)}"`);
      const ratio = contrast(e);
      if (ratio && ratio < 3) problems.push(`low contrast ${ratio.toFixed(1)} "${label(e)}"`);
    });
    // A control that runs past the screen edge, outside anything that scrolls sideways.
    document.querySelectorAll("button, a[href], input, select").forEach((e) => {
      const r = e.getBoundingClientRect();
      if (!shown(e) || (r.left >= -1 && r.right <= innerWidth + 1)) return;
      for (let a = e.parentElement; a; a = a.parentElement) if (/auto|scroll/.test(getComputedStyle(a).overflowX)) return;
      problems.push(`cut off at the edge "${label(e)}"`);
    });
    // The composer's model and effort names must fit, not end in "…".
    document.querySelectorAll(".model-pill-part").forEach((e) => {
      if (shown(e) && e.scrollWidth > e.clientWidth) problems.push(`text cut short "${label(e)}"`);
    });
    if (document.documentElement.scrollWidth > innerWidth) problems.push(`sideways overflow ${document.documentElement.scrollWidth}>${innerWidth}`);
    return [...new Set(problems)];
  };

  const browser = await chromium.launch({ channel: "chrome" });
  const failures: string[] = [];
  const known = new Map<RegExp, number>();
  const screens = new Set<string>();
  for (const device of DEVICES) for (const theme of ["light", "dark"] as const) {
    const { name, width, height, touch } = device;
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 2 });
    await context.addInitScript((t) => localStorage.setItem("esa.theme", t), theme);
    // The helper and permission cards only show while Claude is working: pretend these two runs are live.
    // Board tickets, one ticket and the chats list (/api/tickets); not their conversations.
    await context.route(/\/api\/(profiles\/audit\/tickets(\/[^/?]+)?|tickets)(\?|$)/, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const res = await route.fetch();
      const data = await res.json();
      const live = (t: any) => {
        if (t?.id === events.id) Object.assign(t, { running: true, runStartedAt: at(0), permissionAsk: commandAsk });
        if (t?.id === ticket.id) Object.assign(t, { running: true, runStartedAt: at(0), permissionAsk: planAsk });
      };
      if (Array.isArray(data)) data.forEach(live);
      else live(data);
      await route.fulfill({ response: res, json: data });
    });
    // A connection that needs a fresh login, so the header menu shows what needs you.
    await context.route(/\/api\/mcp$/, (route) => route.request().method() !== "GET" ? route.continue() : route.fulfill({ json: {
      servers: [{ name: "GitHub", target: "https://api.githubcopilot.com/mcp/", transport: "http", scope: "user", status: "needs_auth", message: null, attention: true, login: null }],
      unparsed: [], checkedAt: at(0), checking: false, error: null,
    } }));
    // The Inbox's Status section: a stuck ticket that answered a Nudge and a huddle, with long titles and steps.
    await context.route(/\/api\/status$/, (route) => route.fulfill({ json: [
      { kind: "ticket", profile: "audit", profileName: "audit", id: ticket.id, title: "Add a dark mode toggle to the settings page", agent: "Claude", startedAt: at(0), costUsd: 1.234,
        step: "Editing SettingsToggleSwitch.tsx", steps: ["Reading settings.ts", "Running tests", "Editing SettingsToggleSwitch.tsx"], stalledMinutes: 12,
        nudge: { at: at(5), answer: "Done: the toggle and its styles.\nLeft: the Safari test. No blocker." } },
      { kind: "huddle", profile: "audit", profileName: "audit", id: polish.id, huddleId: "h_audit", title: "Huddle: Polish the settings page", agent: "Huddle · 2 working", startedAt: at(0), costUsd: 0.42,
        step: "@reviewer: Searching for \"contrast\"", steps: ["@main: Reading toggle.ts", "@reviewer: Searching for \"contrast\""], stalledMinutes: null, nudge: null },
    ] }));
    const page = await context.newPage();
    const phone = width < 768 || (touch && width <= 900); // same as PHONE in web/src/useMediaQuery.ts
    const check = async (screen: string, setup: (p: Page) => Promise<void>) => {
      await setup(page);
      await page.waitForTimeout(900);
      await page.evaluate(() => document.querySelectorAll("details.tool-group, details.step-output, details.helper-card").forEach((d) => ((d as HTMLDetailsElement).open = true)));
      if (process.env.AUDIT_SHOTS) await page.screenshot({ path: join(process.env.AUDIT_SHOTS, `${name}-${theme}-${screen.replace(/\W+/g, "-")}.png`) });
      screens.add(screen);
      for (const problem of await page.evaluate(findProblems, touch ? 44 : 20)) {
        const match = KNOWN.find((k) => k.test(`${screen}: ${problem}`));
        if (match) known.set(match, (known.get(match) ?? 0) + 1);
        else failures.push(`${name} ${theme} ${screen}: ${problem}`);
      }
    };
    const newButton = (p: Page) => (phone ? p.locator(".fab") : p.locator(".new-ticket-btn")).click();
    // A full load: a hash change alone can be undone by the history step of a dialog that just closed.
    const open = async (p: Page, id: string) => { await p.goto(`${BASE}/#/audit/${id}`); await p.reload(); };
    const showChats = (p: Page) => (phone ? p.locator(".tabbar button").nth(1) : p.locator(".mode-switch button").nth(1)).click();
    await page.goto(`${BASE}/#/audit`);
    await page.evaluate(() => sessionStorage.setItem("ck-inbox-landed", "1"));
    await page.reload();
    await page.waitForSelector(".topbar");
    if (phone) for (const lane of ["backlog", "planning", "review"]) await check(`board ${lane}`, (p) => p.locator(`button[data-column="${lane}"]`).click());
    else await check("board", async () => {});
    await check("new ticket dialog", newButton);
    await page.keyboard.press("Escape");
    await check("header menu", (p) => p.locator('button[aria-label^="More"]').click());
    await page.keyboard.press("Escape");
    await check("daily usage sheet", async (p) => { await p.locator('button[aria-label^="More"]').click(); await p.getByText("Daily usage").click(); });
    await page.keyboard.press("Escape");
    await check("search dialog", async (p) => {
      await p.locator('button[aria-label^="More"]').click();
      await p.getByText("Search tickets & chats").click();
      await p.getByRole("searchbox").fill("login");
      await p.waitForSelector(".search-hits .sheet-action");
    });
    await page.keyboard.press("Escape");
    await check("activity sheet", async (p) => { await p.locator('button[aria-label^="More"]').click(); await p.getByText("Activity", { exact: true }).click(); await p.waitForSelector(".activity-timeline"); });
    await page.keyboard.press("Escape");
    await check("report a bug", async (p) => { await p.locator('button[aria-label^="More"]').click(); await p.getByText("Report a bug").click(); await p.waitForSelector(".bug-block"); });
    await page.keyboard.press("Escape");
    await check("notification sheet", async (p) => { if (await p.locator(".inbox-pill").count()) await p.locator(".inbox-pill").click(); });
    await check("status row open", (p) => p.locator(".run-line").first().click());
    await page.keyboard.press("Escape");
    if (touch) await check("long-press card sheet", async (p) => {
      if (phone) await p.locator('button[data-column="backlog"]').click();
      const box = (await p.locator(".sortable-card").first().boundingBox())!;
      await p.locator(".sortable-card").first().dispatchEvent("pointerdown", { clientX: box.x + 20, clientY: box.y + 20, pointerType: "touch", isPrimary: true, bubbles: true });
      await p.waitForTimeout(700);
    });
    await page.keyboard.press("Escape");
    await check("chats list", showChats);
    await check("new chat dialog", newButton);
    await page.keyboard.press("Escape");
    await check("session chat", (p) => open(p, session.id));
    await check("fork dialog", async (p) => {
      await p.locator('button[aria-label="Session actions"]').click();
      await p.getByText("Fork chat…").click();
    });
    await page.keyboard.press("Escape");
    await check("ticket chat with plan", (p) => open(p, ticket.id));
    await check("ticket actions menu", (p) => p.locator(".panel-head .more-btn").click());
    await page.keyboard.press("Escape");
    await check("chat events", async (p) => {
      await open(p, events.id);
      // A live ticket update can replace the faked running state; a reload fetches it again.
      await p.locator(".ask-card").waitFor({ timeout: 5000 }).catch(() => p.reload());
    });
    await check("chat code block", (p) => p.locator(".code-block").first().scrollIntoViewIfNeeded());
    await check("helper cards", (p) => p.locator(".helper-card").first().scrollIntoViewIfNeeded());
    await check("permission card", (p) => p.locator(".ask-card").first().scrollIntoViewIfNeeded());
    const ticketTab = (name: string) => (p: Page) => p.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
    await check("ticket huddle", async (p) => {
      await p.goto(`${BASE}/#/audit/${polish.id}`);
      await ticketTab("Huddle")(p);
    });
    await check("ticket huddle composer", (p) => p.getByLabel("Message the huddle").focus());
    if (width <= 720) { // the huddle's phone layout (usePhone in web/src/usePhone.ts)
      await check("ticket huddle people", ticketTab("People"));
      await check("ticket huddle findings", ticketTab("Findings"));
    }
    await check("ticket changes", ticketTab("Changes"));
    await check("ticket outputs", ticketTab("Outputs"));
    await check("huddle start", async (p) => {
      await p.goto(`${BASE}/#/audit/${ticket.id}`);
      await ticketTab("Huddle")(p);
    });
    await check("team list", async (p) => {
      await p.goto(`${BASE}/#/audit`);
      await p.waitForSelector(".topbar");
      await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // the T shortcut doesn't fire in a text box
      await p.keyboard.press("t");
      await p.waitForSelector(".team .tm-row");
    });
    await check("teammate detail", (p) => p.locator(".tm-row").first().click());
    await check("teammate editor", (p) => p.getByRole("button", { name: "Copy to customise" }).click());
    await check("team templates", (p) => p.locator(".team-bar [role=tab]").nth(1).click());
    await check("template editor", (p) => p.locator(".tt-row button").filter({ hasText: /^(Copy to customise|Edit)$/ }).first().click());
    await context.close();
  }
  await browser.close();

  console.log(`Checked ${screens.size} screens: ${[...screens].join(", ")}.`);
  if (known.size) console.log(`Known problems, left to other tickets (KNOWN in this script):\n${[...known].map(([k, n]) => `- ${n} x ${k}`).join("\n")}`);
  const fixed = KNOWN.filter((k) => !known.has(k));
  if (fixed.length) console.log(`No longer seen, delete from KNOWN:\n- ${fixed.join("\n- ")}`);
  if (failures.length) {
    console.error(`Layout audit found ${failures.length} problem${failures.length === 1 ? "" : "s"}:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  } else console.log(`Layout audit passed: ${DEVICES.length} sizes x light and dark, no new layout problems.`);
} finally {
  server.kill();
}
