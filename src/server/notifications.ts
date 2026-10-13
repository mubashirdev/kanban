import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import type { Store } from "./store";
import type { Bus } from "./events";
import { attentionFor, type Attention } from "./attention";
import { planActive } from "./plan";
import type { SessionSummary } from "./session";
import type { Ticket } from "./types";

export type Topic = "attention" | "completed" | "failed" | "stuck" | "waiting";
type Subscription = webpush.PushSubscription & {
  topics: Record<Topic, boolean>;
  /** Show the ticket title and what is needed (the command, the question, the result) in this device's alerts. */
  details: boolean;
};
/** A board open and visible on a device pings this often; that device gets no alerts until it goes quiet. */
export const PRESENCE_MS = 45_000;

/** Which alert a ticket's state sends, or null. running: a run is going on for it right now. */
export function topicFor(t: Ticket, a: Attention | null, running: boolean): Topic | null {
  if (a?.kind === "failed") return "failed";
  if (a?.kind === "review") return "completed";
  if (a?.kind === "stalled") return "stuck";
  if (a) return "attention";
  // The run ended but left the ticket In Progress (e.g. it waits on a huddle); not one the user stopped.
  // A running plan's planner waits on its children.
  if (!running && t.status === "in_progress" && !t.outcome && !t.standalone && t.lastRunAt && !t.slotWait && !planActive(t.plan)) return "waiting";
  return null;
}

/** Looks like a secret: key=value with a secret-ish name, a Bearer token, user:password@ in a URL, a long random word. */
const SECRETS: [RegExp, string][] = [
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],
  [/((?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|auth)[\w-]*["']?\s*[=:]\s*)(?!(?:bearer|basic)\b)["']?[^\s"'&]+/gi, "$1***"],
  [/(:\/\/[^\s/:@]+:)[^\s/@]+@/g, "$1***@"],
  [/\b(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{24,}/g, "***"],
];
/** One line for a phone alert: obvious secrets masked, cut to max characters. */
export function alertLine(text: string, max = 80): string {
  let line = text.trim().split("\n")[0].trim();
  for (const [re, to] of SECRETS) line = line.replace(re, to);
  return line.length > max ? line.slice(0, max - 1).trimEnd() + "…" : line;
}

/**
 * What the alert says. details off: only the agent's name, no title or contents (as before the setting existed).
 * details on: the ticket title, and what is needed in a line (the command, the question, the result summary).
 * result: the ticket's last AI comment (the run's summary).
 */
export function alertText(
  topic: Topic, t: Ticket, a: Attention | null, s: SessionSummary | null, result: string | null, details: boolean,
): { title: string; body: string } {
  const agent = t.agent === "codex" ? "Codex" : "Claude";
  const minutes = t.stalled?.minutes ?? 10;
  const ask = t.permissionAsk;
  const generic = ask
    ? `${agent} asks for your approval.`
    : topic === "stuck"
    ? `No progress for ${minutes} min.`
    : topic === "waiting"
    ? "Finished, waiting for you."
    : t.standalone
    ? topic === "failed"
      ? `${agent} hit an error in a session.`
      : `${agent} replied in a session.`
    : topic === "failed"
    ? "A ticket failed and needs review."
    : topic === "attention"
    ? "A ticket needs your input."
    : "Work is ready for review.";
  if (!details) return { title: "Muba AI", body: generic };
  const reason = ask
    ? ask.tool === "ExitPlanMode"
      ? "Approve the plan"
      : `${ask.tool}: ${alertLine(ask.command || ask.detail)}`
    : topic === "stuck"
    ? `No progress for ${minutes} min`
    : topic === "waiting"
    ? `Finished, waiting for you${result ? ": " + alertLine(result) : ""}`
    : a?.kind === "questions" && s?.firstQuestion
    ? alertLine(s.firstQuestion)
    : a?.kind === "reply" && s?.lastMessage?.text
    ? alertLine(s.lastMessage.text)
    : (a?.kind === "questions" || a?.kind === "review" || a?.kind === "failed" || a?.kind === "blocked") && result
    ? `${a.label}: ${alertLine(result)}`
    : a?.label ?? generic;
  return { title: alertLine(t.title || "Muba AI", 60), body: ask ? `Asks for approval · ${reason}` : reason };
}

/** Where tapping the alert lands: approvals on the permission card, questions and replies in the chat's composer. */
export function alertUrl(slug: string, t: Ticket, a: Attention | null): string {
  const base = `/#/${encodeURIComponent(slug)}/${encodeURIComponent(t.id)}`;
  if (t.permissionAsk) return base + "/approve";
  if (a?.kind === "questions" || a?.kind === "reply") return base + "/reply";
  return base;
}
export function validateSubscription(value: any): Subscription {
  let url: URL;
  try {
    url = new URL(value?.endpoint);
  } catch {
    throw new Error("Invalid push subscription");
  }
  // Only public browser push services may receive requests from this endpoint.
  const hosts = [
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
    "wns.windows.com",
  ];
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    value.endpoint.length > 2048 ||
    !hosts.some(
      (host) => url.hostname === host || url.hostname.endsWith("." + host)
    )
  )
    throw new Error("Unsupported push service");
  if (
    !/^[A-Za-z0-9_-]{87}$/.test(value?.keys?.p256dh ?? "") ||
    !/^[A-Za-z0-9_-]{22}$/.test(value?.keys?.auth ?? "")
  )
    throw new Error("Invalid push encryption keys");
  return {
    endpoint: value.endpoint,
    keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
    topics: {
      attention: value.topics?.attention !== false,
      completed: value.topics?.completed !== false,
      failed: value.topics?.failed !== false,
      stuck: value.topics?.stuck !== false,
      waiting: value.topics?.waiting !== false,
    },
    details: value.details !== false,
  };
}

export class Notifications {
  private file: string;
  private keyFile: string;
  private subscriptions: Subscription[] = [];
  private keys: { publicKey: string; privateKey: string } | null = null;
  private seen = new Map<string, string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Devices (push endpoints) with the board open and visible, and when they last said so. */
  private present = new Map<string, number>();
  constructor(private store: Store, private send = webpush.sendNotification) {
    this.file = join(store.root, "push-subscriptions.json");
    this.keyFile = join(store.root, "push-keys.json");
    if (existsSync(this.file))
      try {
        this.subscriptions = JSON.parse(readFileSync(this.file, "utf8")).map(
          validateSubscription
        );
      } catch {}
  }
  private save() {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.subscriptions), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
  publicKey() {
    if (!this.keys) {
      if (existsSync(this.keyFile))
        this.keys = JSON.parse(readFileSync(this.keyFile, "utf8"));
      else {
        this.keys = webpush.generateVAPIDKeys();
        writeFileSync(this.keyFile, JSON.stringify(this.keys), { mode: 0o600 });
      }
    }
    return this.keys!.publicKey;
  }
  subscribe(value: unknown) {
    const subscription = validateSubscription(value);
    if (
      this.subscriptions.length >= 100 &&
      !this.subscriptions.some((s) => s.endpoint === subscription.endpoint)
    )
      throw new Error("Device limit reached");
    this.publicKey();
    this.subscriptions = [
      ...this.subscriptions.filter((s) => s.endpoint !== subscription.endpoint),
      subscription,
    ];
    this.save();
  }
  unsubscribe(endpoint: string) {
    this.subscriptions = this.subscriptions.filter(
      (s) => s.endpoint !== endpoint
    );
    this.save();
  }
  /** The board on this device is visible (or not): alerts skip it while it is. */
  presence(endpoint: string, visible: boolean, now = Date.now()) {
    if (!this.subscriptions.some((s) => s.endpoint === endpoint)) return;
    if (visible) this.present.set(endpoint, now);
    else this.present.delete(endpoint);
  }
  private watching(endpoint: string, now = Date.now()) {
    return now - (this.present.get(endpoint) ?? -Infinity) < PRESENCE_MS;
  }
  private async deliver(
    subscription: Subscription,
    payload: object,
    strict = false
  ) {
    this.publicKey();
    try {
      await this.send(subscription, JSON.stringify(payload), {
        vapidDetails: {
          subject:
            process.env.CKANBAN_PUSH_SUBJECT ?? this.store.config().publicUrl ?? "https://kanban-muba.ngrok.app",
          ...this.keys!,
        },
        TTL: 3600,
        // Delivered at once, even while the phone is idle or locked.
        urgency: "high",
        timeout: 10000,
      });
    } catch (error: any) {
      if (error.statusCode === 404 || error.statusCode === 410)
        this.unsubscribe(subscription.endpoint);
      else console.warn("Push delivery failed; the next event will retry.");
      if (strict)
        throw new Error(
          "Push delivery failed. Check your device subscription and try again."
        );
    }
  }
  async test(endpoint: string) {
    const subscription = this.subscriptions.find(
      (s) => s.endpoint === endpoint
    );
    if (!subscription) throw new Error("This device is not subscribed");
    await this.deliver(
      subscription,
      {
        title: "Muba AI",
        body: "Notifications are connected.",
        url: "/",
        tag: "esa-test",
      },
      true
    );
  }
  private state(ticket: Ticket, session: SessionSummary | null = null, running = false) {
    const attention = attentionFor(ticket, session, running);
    const topic = topicFor(ticket, attention, running);
    return {
      attention,
      fingerprint: JSON.stringify([
        ticket.status,
        ticket.outcome,
        ticket.runCount,
        ticket.lastRunAt,
        ticket.permissionAsk?.id,
        // A new stall after output resumed alerts again; the same stall doesn't.
        ticket.stalled?.at,
        attention?.kind,
        topic,
        session?.lastMessage?.at,
        session?.openQuestions,
        session?.pendingProposal,
      ]),
      topic,
    };
  }
  start(
    bus: Bus,
    isRunning: (slug: string, id: string) => boolean,
    summary: (slug: string, ticket: Ticket) => SessionSummary | null = () =>
      null
  ) {
    for (const profile of this.store.listProfiles())
      for (const ticket of this.store.listTickets(profile.slug))
        this.seen.set(
          profile.slug + "/" + ticket.id,
          this.state(ticket, summary(profile.slug, ticket)).fingerprint
        );
    const off = bus.on((event) => {
      if (event.type === "ticket.deleted") {
        const key = event.profile + "/" + event.id;
        clearTimeout(this.timers.get(key));
        this.timers.delete(key);
        this.seen.delete(key);
        return;
      }
      if (event.type !== "ticket.updated" && event.type !== "session.updated")
        return;
      const id = event.type === "ticket.updated" ? event.ticket.id : event.id;
      const key = event.profile + "/" + id;
      if (!this.seen.has(key)) this.seen.set(key, "new");
      clearTimeout(this.timers.get(key));
      this.timers.set(
        key,
        setTimeout(() => {
          this.timers.delete(key);
          const ticket = this.store.getTicket(event.profile, id);
          const running = isRunning(event.profile, id);
          // A running ticket only notifies when Claude stops to ask for permission or goes silent (stalled).
          if (!ticket || (running && !ticket.permissionAsk && !ticket.stalled)) return;
          const session = summary(event.profile, ticket);
          const state = this.state(ticket, session, running),
            before = this.seen.get(key);
          this.seen.set(key, state.fingerprint);
          const topic = state.topic;
          if (state.fingerprint === before || !topic) return;
          const result = this.store.lastAiComment(event.profile, id);
          const url = alertUrl(event.profile, ticket, state.attention);
          void Promise.all(
            this.subscriptions
              .filter((s) => s.topics[topic] && !this.watching(s.endpoint))
              .map((s) =>
                this.deliver(s, {
                  ...alertText(topic, ticket, state.attention, session, result, s.details),
                  url,
                  tag: "esa-" + ticket.id,
                })
              )
          );
        }, 500)
      );
    });
    return () => {
      off();
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
    };
  }
}
