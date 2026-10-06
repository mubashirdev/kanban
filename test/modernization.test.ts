import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/server/store";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { ticketMetadata } from "../src/server/ticket-metadata";
import { ticketReview } from "../src/server/review";
import {
  Notifications,
  validateSubscription,
} from "../src/server/notifications";
import { CodexSessions } from "../src/server/codex-session";
import { codexArgs, startCodexRun } from "../src/server/codex-runner";
import { run } from "../src/server/git";
import { makeRepo, tempDir } from "./helpers";
const fake = join(import.meta.dir, "fixtures/fake-codex.ts");
const environment = { ...process.env };
afterEach(() => {
  for (const key of [
    "FAKE_CODEX_LOG",
    "FAKE_CODEX_DELAY",
    "FAKE_CODEX_FAIL",
    "FAKE_ARGS_FILE",
  ]) {
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
});
function fixture(path = tempDir()) {
  const store = new Store(tempDir());
  const profile = {
    name: "Test",
    slug: "test",
    path,
    baseBranch: "main",
    maxParallel: 1,
    model: null,
    createdAt: new Date().toISOString(),
  };
  store.saveProfile(profile);
  return { store, profile };
}
const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("metadata validates enums and bounded labels; properties survive storage without starting work", async () => {
  expect(
    ticketMetadata({
      priority: "urgent",
      kind: "bug",
      labels: [" auth ", "auth"],
      agent: "codex",
    })
  ).toEqual({
    priority: "urgent",
    kind: "bug",
    labels: ["auth"],
    agent: "codex",
  });
  for (const value of [
    { priority: "critical" },
    { kind: "bad" },
    { agent: "bad" },
    { labels: "auth" },
    { labels: ["a\nb"] },
    { labels: Array(11).fill("a") },
    { labels: ["a".repeat(33)] },
  ])
    expect(() => ticketMetadata(value)).toThrow();
  const { store } = fixture(),
    bus = new Bus(),
    board = new Board(store, bus, { claudeBin: "/bin/false" });
  const server = createServer({
    store,
    bus,
    board,
    port: 0,
    webDir: tempDir(),
  });
  const base = `http://127.0.0.1:${server.port}/api/profiles/test/tickets`;
  try {
    for (const body of [
      { title: "bad", priority: "bad" },
      { title: "bad", agent: "codex", sessionId: "fake" },
    ])
      expect((await fetch(base, json("POST", body))).status).toBe(400);
    expect(store.listTickets("test")).toHaveLength(0);
    const response = await fetch(
      base,
      json("POST", {
        title: "Test",
        status: "backlog",
        priority: "high",
        kind: "bug",
        labels: ["frontend"],
        agent: "codex",
      })
    );
    expect(response.status).toBe(201);
    const ticket: any = await response.json();
    expect(
      (await fetch(base + `/${ticket.id}`, json("PATCH", { codexEffort: 5 })))
        .status
    ).toBe(400);
    expect(
      (
        await fetch(
          base + `/${ticket.id}`,
          json("PATCH", { priority: "urgent", codexEffort: "high" })
        )
      ).status
    ).toBe(200);
    const loaded = new Store(store.root).getTicket("test", ticket.id)!;
    expect(loaded.priority).toBe("urgent");
    expect(loaded.codexEffort).toBe("high");
    expect(loaded.runCount).toBe(0);
    expect(loaded.sessionId).toBeNull();
    expect(
      store
        .workspaceActivity("test")
        .some((x) => x.changes.includes("priority: urgent"))
    ).toBe(true);
    const events = store.workspaceActivity("test").length;
    store.updateTicket("test", ticket.id, { lastActivity: "streaming" });
    expect(store.workspaceActivity("test")).toHaveLength(events);
  } finally {
    server.stop(true);
  }
});

test("review compares committed worktree changes, staged changes, new files and rejects arbitrary paths", async () => {
  const repo = await makeRepo(),
    { store, profile } = fixture(repo);
  const worktree = tempDir();
  await run(
    ["git", "worktree", "add", "-qb", "feature-test", worktree, "main"],
    repo
  );
  writeFileSync(join(worktree, "README.md"), "committed change\n");
  await run(["git", "add", "."], worktree);
  await run(
    [
      "git",
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "change",
    ],
    worktree
  );
  writeFileSync(
    join(worktree, "README.md"),
    "committed change\nstaged change\n"
  );
  await run(["git", "add", "."], worktree);
  writeFileSync(join(worktree, "new file.txt"), "untracked text\n");
  writeFileSync(join(worktree, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(worktree, "ignored.txt"), "private\n");
  symlinkSync("/etc/hosts", join(worktree, "link"));
  const t = store.createTicket("test", {
    title: "Review",
    body: "",
    status: "review",
  });
  const ticket = store.updateTicket("test", t.id, { worktree });
  const review = await ticketReview(profile, ticket, store);
  expect(review.files.some((f) => f.path === "README.md")).toBe(true);
  expect(review.files.some((f) => f.path === "ignored.txt")).toBe(false);
  expect(
    (await ticketReview(profile, ticket, store, "README.md")).diff
  ).toContain("+staged change");
  expect(
    (await ticketReview(profile, ticket, store, "new file.txt")).diff
  ).toContain("+untracked text");
  expect(
    (await ticketReview(profile, ticket, store, "link")).diff
  ).not.toContain("localhost");
  expect(
    ticketReview(profile, ticket, store, "../../etc/hosts")
  ).rejects.toThrow("Choose a changed file");
  expect(
    (await ticketReview(profile, { ...ticket, worktree: null }, store)).warning
  ).toContain("Shared repository");
});

const subscription = (endpoint = "https://web.push.apple.com/device/test") => ({
  endpoint,
  keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
  topics: { attention: true, completed: true, failed: true },
});
test("push accepts only browser push services and keeps keys private, deduplicates devices and reports test failures", async () => {
  for (const endpoint of [
    "http://web.push.apple.com/a",
    "https://localhost/a",
    "https://web.push.apple.com.evil.test/a",
    "https://user:pass@web.push.apple.com/a",
    "https://web.push.apple.com:8443/a",
  ])
    expect(() => validateSubscription(subscription(endpoint))).toThrow();
  const { store } = fixture();
  const sent: any[] = [];
  const push = new Notifications(store, async (...args: any[]) => {
    sent.push(args);
    return {} as any;
  });
  push.subscribe(subscription());
  push.subscribe(subscription());
  expect(
    JSON.parse(
      readFileSync(join(store.root, "push-subscriptions.json"), "utf8")
    )
  ).toHaveLength(1);
  expect(statSync(join(store.root, "push-keys.json")).mode & 0o777).toBe(0o600);
  expect(push.publicKey()).toBe(new Notifications(store).publicKey());
  await push.test(subscription().endpoint);
  expect(sent).toHaveLength(1);
  expect(sent[0][2].vapidDetails.subject).not.toContain("https://localhost");
  const broken = new Notifications(store, async () => {
    throw { statusCode: 410 };
  });
  expect(broken.test(subscription().endpoint)).rejects.toThrow(
    "Push delivery failed"
  );
  expect(
    JSON.parse(
      readFileSync(join(store.root, "push-subscriptions.json"), "utf8")
    )
  ).toHaveLength(0);
});

test("push covers new tickets and planning questions, avoids old events, busy runs, duplicates and private titles", async () => {
  const { store } = fixture(),
    bus = new Bus(),
    sent: any[] = [];
  let running = true;
  const push = new Notifications(store, async (_sub: any, payload: any) => {
    sent.push(JSON.parse(payload));
    return {} as any;
  });
  push.subscribe(subscription());
  const summaries = new Map<string, any>();
  const stop = push.start(
    bus,
    () => running,
    (_slug, ticket) => summaries.get(ticket.id) ?? null
  );
  try {
    const t = store.createTicket("test", {
      title: "Private medical data",
      body: "secret",
      status: "planning",
    });
    bus.emit({ type: "ticket.updated", profile: "test", ticket: t });
    await Bun.sleep(550);
    expect(sent).toHaveLength(0);
    running = false;
    summaries.set(t.id, {
      openQuestions: 1,
      pendingNewTickets: [],
      lastMessage: { role: "assistant", at: "now" },
    });
    bus.emit({
      type: "session.updated",
      profile: "test",
      id: t.id,
      session: summaries.get(t.id),
    });
    await Bun.sleep(550);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain("Private medical");
    bus.emit({ type: "ticket.updated", profile: "test", ticket: t });
    await Bun.sleep(550);
    expect(sent).toHaveLength(1);
    const done = store.updateTicket("test", t.id, {
      status: "review",
      outcome: "done",
      runCount: 1,
    });
    summaries.delete(t.id);
    bus.emit({ type: "ticket.updated", profile: "test", ticket: done });
    await Bun.sleep(550);
    expect(sent.at(-1).body).toBe("Work is ready for review.");
  } finally {
    stop();
  }
});

test("Codex runner maps JSON events, preserves read-only planning and reports failure", async () => {
  expect(codexArgs({ refine: true })).toContain('sandbox_mode="read-only"');
  expect(
    codexArgs({ refine: false, sessionId: "thread", effort: "high" })
  ).toContain("resume");
  const events: any[] = [];
  const result = await startCodexRun({
    bin: fake,
    cwd: tempDir(),
    args: codexArgs({ refine: true }),
    input: "Test prompt",
    onEvent: (event) => events.push(event),
  }).done;
  expect(result.code).toBe(0);
  expect(events.find((e) => e.type === "codex.thread").sessionId).toBe(
    "12345678-1234-1234-1234-123456789abc"
  );
  expect(
    events.some((e) => e.message?.content?.[0]?.type === "tool_result")
  ).toBe(true);
  expect(events.at(-1).result).toContain("CKANBAN_RESULT");
  const failed = await startCodexRun({
    bin: fake,
    cwd: tempDir(),
    args: [],
    input: "Fail",
    env: { FAKE_CODEX_FAIL: "1" },
    onEvent: () => {},
  }).done;
  expect(failed.code).toBe(1);
  expect(failed.stderr).toContain("Fake provider failure");
});

test("ticket providers resume separate sessions, queue Codex messages and preserve Claude when switching back", async () => {
  const { store } = fixture(),
    bus = new Bus();
  process.env.FAKE_CODEX_LOG = join(tempDir(), "calls.jsonl");
  process.env.FAKE_ARGS_FILE = join(tempDir(), "claude.jsonl");
  const board = new Board(store, bus, {
    claudeBin: join(import.meta.dir, "fixtures/fake-claude.ts"),
    codexBin: fake,
  });
  const t = await board.createTicket("test", {
    title: "Providers",
    body: "",
    status: "backlog",
    agent: "codex",
  });
  await board.updateTicket("test", t.id, {
    codexModel: "test-model",
    codexEffort: "high",
  });
  process.env.FAKE_CODEX_DELAY = "150";
  await board.chat("test", t.id, "Explain");
  await Bun.sleep(30);
  expect(
    board.updateTicket("test", t.id, { agent: "claude" })
  ).rejects.toThrow();
  await board.chat("test", t.id, "Second prompt");
  await board.whenIdle();
  const calls = readFileSync(process.env.FAKE_CODEX_LOG, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls).toHaveLength(2);
  expect(calls[0].args).not.toContain("resume");
  expect(calls[1].args).toContain("resume");
  expect(calls[1].prompt).toContain("Second prompt");
  expect(calls[0].args).toContain("test-model");
  const after = store.getTicket("test", t.id)!;
  expect(after.queued ?? []).toHaveLength(0);
  expect(after.sessionStarted).not.toBe(true);
  expect(after.codexSessionId).toBeTruthy();
  const cache = new CodexSessions(store);
  const parsed = cache.get("test", t.id)!;
  expect(parsed.entries.some((e) => e.text.includes("Verified"))).toBe(true);
  expect(cache.get("test", t.id)).toBe(parsed);
  await board.updateTicket("test", t.id, { agent: "claude" });
  await board.chat("test", t.id, "Use Claude");
  await board.whenIdle();
  const claudeCall = JSON.parse(
    readFileSync(process.env.FAKE_ARGS_FILE, "utf8").trim().split("\n").at(-1)!
  );
  expect(claudeCall.args).not.toContain("--resume");
  await board.updateTicket("test", t.id, { agent: "codex" });
  expect(store.getTicket("test", t.id)!.codexSessionId).toBe(
    after.codexSessionId
  );
  expect(board.chat("test", t.id, "/model")).rejects.toThrow("settings button");
});

test("review reports CI and recorded verification without treating an agent summary as proof", async () => {
  const repo = await makeRepo(),
    { store, profile } = fixture(repo);
  const t = store.createTicket("test", {
    title: "Checks",
    body: "",
    status: "review",
  });
  store.appendActivity("test", t.id, 1, {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "test-run",
          name: "Bash",
          input: { command: "bun test test" },
        },
      ],
    },
  });
  store.appendActivity("test", t.id, 1, {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "test-run",
          is_error: true,
          content: "1 test failed",
        },
      ],
    },
  });
  store.appendActivity("test", t.id, 1, {
    type: "result",
    result: "Tests pass (unverified assertion).",
    total_cost_usd: "wrong",
    duration_ms: 250,
  });
  const { reviewCommand } = await import("../src/server/review");
  const response = await ticketReview(
    profile,
    { ...t, prUrl: "https://github.com/example/test/pull/1" },
    store,
    undefined,
    async (cmd, cwd) =>
      cmd[0] === "gh"
        ? {
            code: 0,
            stdout: JSON.stringify({
              statusCheckRollup: [
                {
                  name: "Tests",
                  conclusion: "FAILURE",
                  detailsUrl: "https://github.com/example/check",
                },
              ],
            }),
            stderr: "",
            truncated: false,
          }
        : reviewCommand(cmd, cwd)
  );
  expect(response.checks[0].state).toBe("FAILURE");
  expect(response.recordedChecks[0]).toEqual({
    command: "bun test test",
    state: "failed",
    output: "1 test failed",
  });
  expect(response.verification!.costUsd).toBeNull();
});

test("Codex catalog exposes visible model metadata only and handles absent or corrupt caches", async () => {
  const { codexModels } = await import("../src/server/codex-catalog");
  const file = join(tempDir(), "models.json");
  writeFileSync(
    file,
    JSON.stringify({
      secret: "must not be exposed",
      models: [
        {
          slug: "model-a",
          display_name: "Model A",
          visibility: "list",
          secret: "private",
          supported_reasoning_levels: [
            { effort: "high" },
            { effort: "unknown" },
          ],
        },
        { slug: "hidden", visibility: "hide" },
      ],
    })
  );
  expect(codexModels(file)).toEqual([
    { value: "model-a", displayName: "Model A", efforts: ["high"] },
  ]);
  writeFileSync(file, "broken");
  expect(codexModels(file)).toEqual([]);
  expect(codexModels(file + "missing")).toEqual([]);
  expect(
    codexArgs({ refine: true, writableRoots: ["/tmp/outputs"] }).some((value) =>
      value.includes("writable_roots")
    )
  ).toBe(false);
  expect(
    codexArgs({ refine: false, writableRoots: ["/tmp/outputs"] })
  ).toContain('sandbox_workspace_write.writable_roots=["/tmp/outputs"]');
});

test("Codex stop terminates a running process and messages remain queued instead of being lost", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const handle = startCodexRun({
    bin: fake,
    cwd: tempDir(),
    args: [],
    input: "Wait",
    env: { FAKE_CODEX_DELAY: "10000" },
    onEvent: (event) => {
      if (event.type === "codex.thread") started();
    },
  });
  await ready;
  expect(handle.send("Later")).toBe(false);
  handle.stop();
  expect(handle.stopped).toBe(true);
  expect((await handle.done).code).not.toBe(0);
});
