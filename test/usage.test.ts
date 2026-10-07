import { expect, test } from "bun:test";
import { fetchUsage, normalizeExtra, normalizeUsage, parseCredentials, USAGE_URL } from "../src/server/usage";
import { parseCliUsage, pillText, resetText, usageTone, worstTone } from "../web/src/usage";

const FULL = {
  five_hour: { utilization: 42, resets_at: "2026-10-05T16:10:00+00:00" },
  seven_day: { utilization: 81.4, resets_at: "2026-10-09T09:00:00+00:00" },
  seven_day_opus: { utilization: 12, resets_at: "2026-10-09T09:00:00+00:00" },
  seven_day_oauth_apps: null,
  extra_usage: { is_enabled: false, used_credits: null },
};

test("normalizeUsage maps a full response in plan order", () => {
  expect(normalizeUsage(FULL)).toEqual([
    { key: "five_hour", label: "Current session", percent: 42, resetsAt: "2026-10-05T16:10:00+00:00" },
    { key: "seven_day", label: "Current week (all models)", percent: 81.4, resetsAt: "2026-10-09T09:00:00+00:00" },
    { key: "seven_day_opus", label: "Current week (Opus)", percent: 12, resetsAt: "2026-10-09T09:00:00+00:00" },
  ]);
});

test("normalizeUsage skips null windows and keeps unknown window keys", () => {
  const w = normalizeUsage({
    seven_day_sonnet: { utilization: 3, resets_at: null },
    five_hour: null,
    seven_day: { utilization: 150, resets_at: "not a date" },
    seven_day_haiku_extra: { utilization: 5 },
    some_flag: true,
  })!;
  expect(w.map((x) => x.key)).toEqual(["seven_day", "seven_day_sonnet", "seven_day_haiku_extra"]);
  expect(w[0]).toMatchObject({ percent: 100, resetsAt: null });
  expect(w[2].label).toBe("Current week (haiku extra)");
});

test("normalizeUsage rejects a bad shape", () => {
  expect(normalizeUsage(null)).toBeNull();
  expect(normalizeUsage("nope")).toBeNull();
  expect(normalizeUsage([1, 2])).toBeNull();
  expect(normalizeUsage({ error: { type: "x" } })).toBeNull();
  // Known keys but all empty: valid, just no windows.
  expect(normalizeUsage({ five_hour: null, seven_day: null })).toEqual([]);
});

test("parseCredentials", () => {
  expect(parseCredentials('{"claudeAiOauth":{"accessToken":"t","expiresAt":5}}')).toEqual({ token: "t", expiresAt: 5 });
  expect(parseCredentials('{"claudeAiOauth":{"accessToken":"t","subscriptionType":"max"}}')).toEqual({ token: "t", expiresAt: null, plan: "max" });
  expect(parseCredentials("{}")).toHaveProperty("error");
  expect(parseCredentials("garbage")).toHaveProperty("error");
});

const creds = (expiresAt: number | null = null) => async () => ({ token: "secret-token", expiresAt });

test("fetchUsage sends the token only to Anthropic and never returns it", async () => {
  let seen: { url: string; auth: string | null } | null = null;
  const f = (async (url: string, init: RequestInit) => {
    seen = { url, auth: new Headers(init.headers).get("authorization") };
    return new Response(JSON.stringify(FULL));
  }) as unknown as typeof fetch;
  const r = await fetchUsage({ credentials: creds(), fetchFn: f, now: () => 0 });
  expect(seen!).toEqual({ url: USAGE_URL, auth: "Bearer secret-token" });
  expect("windows" in r && r.windows.length).toBe(3);
  expect(JSON.stringify(r)).not.toContain("secret-token");
});

test("fetchUsage explains failures in plain words", async () => {
  const never = (async () => { throw new Error("should not fetch"); }) as unknown as typeof fetch;
  expect(await fetchUsage({ credentials: async () => ({ error: "Not logged in to Claude Code" }), fetchFn: never }))
    .toMatchObject({ error: "Not logged in to Claude Code" });
  expect(await fetchUsage({ credentials: creds(1000), fetchFn: never, now: () => 2000 }))
    .toMatchObject({ error: expect.stringContaining("Token expired") });
  const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  expect(await fetchUsage({ credentials: creds(), fetchFn: offline })).toMatchObject({ error: expect.stringContaining("offline") });
  const status = (n: number) => (async () => new Response("{}", { status: n })) as unknown as typeof fetch;
  expect(await fetchUsage({ credentials: creds(), fetchFn: status(401) })).toMatchObject({ error: expect.stringContaining("Token rejected") });
  expect(await fetchUsage({ credentials: creds(), fetchFn: status(500) })).toMatchObject({ error: "Anthropic answered HTTP 500" });
  const weird = (async () => new Response("<html>")) as unknown as typeof fetch;
  expect(await fetchUsage({ credentials: creds(), fetchFn: weird })).toMatchObject({ error: expect.stringContaining("Unexpected") });
});

test("pill colour thresholds", () => {
  expect(usageTone(0)).toBe("ok");
  expect(usageTone(79.9)).toBe("ok");
  expect(usageTone(80)).toBe("warn");
  expect(usageTone(94.9)).toBe("warn");
  expect(usageTone(95)).toBe("err");
  const w = (key: string, percent: number) => ({ key, label: key, percent, resetsAt: null });
  expect(worstTone([w("five_hour", 10), w("seven_day", 85)])).toBe("warn");
  expect(worstTone([w("five_hour", 99), w("seven_day", 85)])).toBe("err");
  expect(worstTone([])).toBe("ok");
});

test("pillText and resetText", () => {
  const w = (key: string, percent: number) => ({ key, label: key, percent, resetsAt: null });
  expect(pillText([w("five_hour", 42.4), w("seven_day", 81), w("seven_day_opus", 12)])).toBe("Usage · 5h 42% · week 81%");
  const now = Date.parse("2026-10-05T12:00:00Z");
  expect(resetText(null, now)).toBeNull();
  expect(resetText("2026-10-05T14:15:00Z", now)).toMatch(/^Resets .+ \(in 2h 15m\)$/);
  expect(resetText("2026-10-09T09:00:00Z", now)).not.toContain("(in");
  expect(resetText("2026-10-05T11:00:00Z", now)).toBe("Resets now");
});

test("per-model weekly limits and extra usage come through like Claude Code's /usage", () => {
  const body = {
    five_hour: { utilization: 20, resets_at: "2026-10-06T11:40:00+00:00" },
    seven_day: { utilization: 60, resets_at: "2026-10-08T17:00:00+00:00" },
    limits: [
      { kind: "weekly_all", percent: 60, resets_at: "2026-10-08T17:00:00+00:00", scope: null },
      { kind: "weekly_scoped", percent: 37, resets_at: "2026-10-08T17:00:00+00:00", scope: { model: { display_name: "Fable" } } },
    ],
    extra_usage: { is_enabled: false, credits_ever_enabled: true, used_credits: 30031, monthly_limit: 30000, decimal_places: 2, spend_limit_reached: true },
  };
  expect(normalizeUsage(body)!.map((w) => [w.label, w.percent])).toEqual([
    ["Current session", 20], ["Current week (all models)", 60], ["Current week (Fable)", 37],
  ]);
  expect(normalizeExtra(body)).toEqual({ usedDollars: 300.31, limitDollars: 300, limitReached: true, enabled: false });
  expect(normalizeExtra({ extra_usage: { is_enabled: false, used_credits: null } })).toBeNull();
});

test("Claude Code's /usage text becomes bars for the chat", () => {
  const text = `You are currently using your subscription to power your Claude Code usage

Current session: 1% used · resets Oct 7 at 12:40am (Asia/Kuala_Lumpur)
Current week (all models): 60% used · resets Oct 9 at 1am (Asia/Kuala_Lumpur)
Current week (Fable): 37% used · resets Oct 9 at 12:59am (Asia/Kuala_Lumpur)

What's contributing to your limits usage?
Last 24h · 1578 requests · 60 sessions`;
  const u = parseCliUsage(text)!;
  expect(u.intro).toBe("You are currently using your subscription to power your Claude Code usage");
  expect(u.windows).toEqual([
    { label: "Current session", percent: 1, resets: "Resets Oct 7 at 12:40am" },
    { label: "Current week (all models)", percent: 60, resets: "Resets Oct 9 at 1am" },
    { label: "Current week (Fable)", percent: 37, resets: "Resets Oct 9 at 12:59am" },
  ]);
  expect(u.rest.startsWith("What's contributing")).toBe(true);
  expect(parseCliUsage("Done, tests pass.")).toBeNull();
});
