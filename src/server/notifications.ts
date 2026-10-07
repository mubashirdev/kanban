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
import { attentionFor } from "./attention";
import type { SessionSummary } from "./session";
import type { Ticket } from "./types";

type Subscription = webpush.PushSubscription & {
  topics: { attention: boolean; completed: boolean; failed: boolean };
};
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
    },
  };
}

export class Notifications {
  private file: string;
  private keyFile: string;
  private subscriptions: Subscription[] = [];
  private keys: { publicKey: string; privateKey: string } | null = null;
  private seen = new Map<string, string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
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
            process.env.CKANBAN_PUSH_SUBJECT ?? "https://kanban-muba.ngrok.app",
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
  private state(ticket: Ticket, session: SessionSummary | null = null) {
    const attention = attentionFor(ticket, session, false);
    const topic: "attention" | "completed" | "failed" | null =
      attention?.kind === "failed"
        ? "failed"
        : attention?.kind === "review"
        ? "completed"
        : attention
        ? "attention"
        : null;
    return {
      fingerprint: JSON.stringify([
        ticket.status,
        ticket.outcome,
        ticket.runCount,
        ticket.lastRunAt,
        attention?.kind,
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
          if (!ticket || isRunning(event.profile, id)) return;
          const state = this.state(ticket, summary(event.profile, ticket)),
            before = this.seen.get(key);
          this.seen.set(key, state.fingerprint);
          const topic = state.topic;
          if (state.fingerprint === before || !topic) return;
          // Only the agent's name: titles stay out of push payloads.
          const agent = ticket.agent === "codex" ? "Codex" : "Claude";
          const body = ticket.standalone
            ? topic === "failed"
              ? `${agent} hit an error in a session.`
              : `${agent} replied in a session.`
            : topic === "failed"
            ? "A ticket failed and needs review."
            : topic === "attention"
            ? "A ticket needs your input."
            : "Work is ready for review.";
          void Promise.all(
            this.subscriptions
              .filter((s) => s.topics[topic])
              .map((s) =>
                this.deliver(s, {
                  title: "Muba AI",
                  body,
                  url: `/#/${encodeURIComponent(
                    event.profile
                  )}/${encodeURIComponent(ticket.id)}`,
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
