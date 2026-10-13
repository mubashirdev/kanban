import { beforeEach, expect, test } from "bun:test";
import { attentionFor } from "../src/server/attention";
import { Bus } from "../src/server/events";
import { alertLine, alertText, alertUrl, Notifications, PRESENCE_MS, topicFor } from "../src/server/notifications";
import type { SessionSummary } from "../src/server/session";
import { Store } from "../src/server/store";
import type { Ticket } from "../src/server/types";
import { tempDir } from "./helpers";

const T = (p: Partial<Ticket>): Ticket => ({
  id: "t1", title: "Fix login", body: "", status: "in_progress", order: 0, createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z", outcome: null, runCount: 1, error: null, lastRunAt: "2026-10-01T00:00:00Z", ...p,
} as Ticket);
const S = (p: Partial<SessionSummary> = {}): SessionSummary => ({
  title: null, lastMessage: null, artifacts: [], updatedAt: "", openQuestions: 0, pendingProposal: null, pendingNewTickets: [], pendingTeammates: [], ...p,
});
const ASK = { id: "r1", tool: "Bash", detail: "Push the branch", command: "git push origin main", canAlways: false, at: "" };

test("topic mapping: approvals and questions, review, failed, stuck, finished but waiting", () => {
  const topic = (t: Ticket, s: SessionSummary | null, running: boolean) => topicFor(t, attentionFor(t, s, running), running);
  expect(topic(T({ permissionAsk: ASK }), null, true)).toBe("attention");
  expect(topic(T({ status: "planning" }), S({ openQuestions: 1 }), false)).toBe("attention");
  expect(topic(T({ status: "review", outcome: "done" }), null, false)).toBe("completed");
  expect(topic(T({ status: "review", outcome: "failed" }), null, false)).toBe("failed");
  expect(topic(T({ stalled: { at: "2026-10-01T00:10:00Z", minutes: 10 } }), null, true)).toBe("stuck");
  // A run ended but left the ticket In Progress (waiting on its huddle).
  expect(topic(T({}), null, false)).toBe("waiting");
  // Still running, never run, queued for a slot, a planner with a running plan, a chat: no alert.
  expect(topic(T({}), null, true)).toBeNull();
  expect(topic(T({ lastRunAt: null }), null, false)).toBeNull();
  expect(topic(T({ slotWait: { at: "", from: { status: "ready", outcome: null } } }), null, false)).toBeNull();
  expect(topic(T({ plan: { state: "running" } as Ticket["plan"] }), null, false)).toBeNull();
  expect(topic(T({ standalone: true }), null, false)).toBeNull();
  expect(topic(T({ outcome: "stopped" }), null, false)).toBeNull();
});

test("details on: the title and what is needed; off: no title or contents", () => {
  const approval = T({ permissionAsk: ASK });
  const a = attentionFor(approval, null, true);
  expect(alertText("attention", approval, a, null, null, true)).toEqual({ title: "Fix login", body: "Asks for approval · Bash: git push origin main" });
  expect(alertText("attention", approval, a, null, null, false)).toEqual({ title: "Muba AI", body: "Claude asks for your approval." });

  const asked = T({ status: "planning" }), s = S({ openQuestions: 2, firstQuestion: "Which database should we use?\nMore text" });
  expect(alertText("attention", asked, attentionFor(asked, s, false), s, null, true).body).toBe("Which database should we use?");

  const done = T({ status: "review", outcome: "done" });
  expect(alertText("completed", done, attentionFor(done, null, false), null, "Added login retries.\nDetails", true).body)
    .toBe("Ready for review: Added login retries.");
  expect(alertText("completed", done, attentionFor(done, null, false), null, "Added login retries.", false))
    .toEqual({ title: "Muba AI", body: "Work is ready for review." });

  const stuck = T({ stalled: { at: "x", minutes: 10 } });
  expect(alertText("stuck", stuck, attentionFor(stuck, null, true), null, null, true).body).toBe("No progress for 10 min");
  expect(alertText("waiting", T({}), null, null, "Opened the huddle.", true).body).toBe("Finished, waiting for you: Opened the huddle.");
  expect(alertText("waiting", T({}), null, null, null, false).body).toBe("Finished, waiting for you.");
});

test("alert lines mask obvious secrets and stay short", () => {
  expect(alertLine("curl -H 'Authorization: Bearer abcdef123456' https://api.x.com")).toBe("curl -H 'Authorization: Bearer ***' https://api.x.com");
  expect(alertLine("API_KEY=sk-live-123 npm run deploy")).toBe("API_KEY=*** npm run deploy");
  expect(alertLine("git clone https://bob:hunter2@github.com/x/y")).toBe("git clone https://bob:***@github.com/x/y");
  expect(alertLine("echo ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3")).toBe("echo ***");
  expect(alertLine("git push origin main")).toBe("git push origin main");
  const long = alertLine("x ".repeat(100));
  expect(long.length).toBe(80);
  expect(long.endsWith("…")).toBe(true);
});

test("approval links land on the permission card, questions in the composer", () => {
  expect(alertUrl("my board", T({ permissionAsk: ASK }), null)).toBe("/#/my%20board/t1/approve");
  const asked = T({ status: "planning" }), s = S({ openQuestions: 1 });
  expect(alertUrl("kb", asked, attentionFor(asked, s, false))).toBe("/#/kb/t1/reply");
  expect(alertUrl("kb", T({ status: "review" }), attentionFor(T({ status: "review" }), null, false))).toBe("/#/kb/t1");
});

const SUB = (n: number) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/device${n}`,
  keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
});

let store: Store, bus: Bus, sent: { endpoint: string; payload: any }[], running: Set<string>, notifications: Notifications, ticket: Ticket;
beforeEach(() => {
  store = new Store(tempDir("ck-push-"));
  bus = new Bus();
  sent = [];
  running = new Set();
  store.saveProfile({ name: "Kanban", slug: "kb", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" });
  ticket = store.createTicket("kb", { title: "Fix login", body: "b", status: "in_progress" });
  notifications = new Notifications(store, (async (s: any, payload: string) => { sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload) }); }) as any);
  notifications.subscribe({ ...SUB(1), details: true });
  notifications.subscribe({ ...SUB(2), details: false, topics: { stuck: false } });
  notifications.start(bus, (_slug, id) => running.has(id));
  running.add(ticket.id);
});
const update = async (patch: Partial<Ticket>) => {
  bus.emit({ type: "ticket.updated", profile: "kb", ticket: store.updateTicket("kb", ticket.id, patch) } as any);
  await Bun.sleep(600);
};

test("stuck: one alert per stall, none again until output resumed and it stalled again", async () => {
  await update({ stalled: { at: "2026-10-13T10:10:00Z", minutes: 10 } });
  // Device 2 turned stuck alerts off.
  expect(sent).toEqual([{ endpoint: SUB(1).endpoint, payload: { title: "Fix login", body: "No progress for 10 min", url: `/#/kb/${ticket.id}`, tag: "esa-" + ticket.id } }]);
  await update({ lastActivity: "still quiet" });
  expect(sent.length).toBe(1);
  // Output came back (the watchdog clears the flag), then it went quiet again.
  await update({ stalled: null, lastActivity: "Running tests" });
  expect(sent.length).toBe(1);
  await update({ stalled: { at: "2026-10-13T10:30:00Z", minutes: 10 } });
  expect(sent.length).toBe(2);
});

test("a run that asks for Bash permission names the command; the open board's device stays quiet", async () => {
  notifications.presence(SUB(2).endpoint, true);
  await update({ permissionAsk: ASK });
  expect(sent).toEqual([{
    endpoint: SUB(1).endpoint,
    payload: { title: "Fix login", body: "Asks for approval · Bash: git push origin main", url: `/#/kb/${ticket.id}/approve`, tag: "esa-" + ticket.id },
  }]);
});

test("presence lasts PRESENCE_MS after the last ping (fake clock) and ends when the board is hidden", () => {
  const watching = (n: number, now: number) => (notifications as any).watching(SUB(n).endpoint, now);
  notifications.presence(SUB(1).endpoint, true, 1000);
  expect(watching(1, 1000 + PRESENCE_MS - 1)).toBe(true);
  expect(watching(1, 1000 + PRESENCE_MS)).toBe(false);
  notifications.presence(SUB(1).endpoint, true, 5000);
  notifications.presence(SUB(1).endpoint, false, 6000);
  expect(watching(1, 6001)).toBe(false);
  // Unknown devices are ignored.
  notifications.presence("https://fcm.googleapis.com/fcm/send/other", true, 1000);
  expect((notifications as any).present.size).toBe(0);
});

test("a run that ends but leaves the ticket In Progress sends one Finished alert", async () => {
  running.delete(ticket.id);
  store.addComment("kb", ticket.id, "ai", "Done; the huddle reviews it now.");
  await update({ lastRunAt: "2026-10-13T11:00:00Z", runCount: 2 });
  expect(sent.map((s) => s.payload.body)).toEqual(["Finished, waiting for you: Done; the huddle reviews it now.", "Finished, waiting for you."]);
  await update({ lastActivity: "Waiting for the huddle" });
  expect(sent.length).toBe(2);
});
