import { Notifications } from "./notifications";
import { ticketReview } from "./review";
import { ticketMetadata } from "./ticket-metadata";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { ConflictError, type Board } from "./board";
import { dailyUsage } from "./usage-daily";
import { claudeDefaults, listClaudeProjects, listSessions, liveSessionMatch, pickFolder, processCommands } from "./claude";
import type { Bus, BusEvent } from "./events";
import { detectBaseBranch, isGitRepo, resolveBaseBranch, which } from "./git";
import { checkPr } from "./prpoller";
import { resumeCommand } from "./prompts";
import { cronError, describeCron, nextRuns, parseCron } from "./cron";
import { shellQuote } from "./util";
import { RUN_HEADER, ScheduleError, Scheduler } from "./scheduler";
import { QuestionError, Questions } from "./questions";
import { attentionFor } from "./attention";
import { childrenOf, isComplete, MAX_RETRIES, planActive } from "./plan";
import { BugReportError, draftReport, submitReport, type BugBlockId, type BugSource, type GhRunner } from "./bugreport";
import { AttachmentError, attachmentFile, attachmentType, IMAGE_TYPES, saveAttachment } from "./attachments";
import { FileError, listDir, openWithSystem, readFileForView } from "./files";
import { McpError, McpManager } from "./mcp";
import { AGENT_IDS, AgentError, AgentRegistry, type AgentId } from "./agents";
import { codexModels } from "./codex-catalog";
import { codexCommands, codexSkills } from "./codex-commands";
import { searchFiles } from "./git-actions";
import { CodexSessions, listCodexSessions } from "./codex-session";
import { SessionCache, mergeCommandEntries } from "./session";
import { ptySupported, ShellManager, type PtyKind, type Shell } from "./shell";
import type { TerminalWatcher } from "./terminals";
import { UpdateChecker } from "./update";
import { fetchUsage, type UsageResult } from "./usage";
import type { Store } from "./store";
import { STATUSES, type Config, type Profile, type ScheduleEditor, type Status, type Ticket } from "./types";
import { nowIso, slugify } from "./util";
import { authorizeLan, createLanSignIn, type LanAccess } from "./lan";
import { ClaudeCommands, effortOptions } from "./commands";

export interface ServerDeps {
  store: Store;
  bus: Bus;
  board: Board;
  port: number;
  webDir: string;
  /** Opt-in private LAN access; localhost remains available to the CLI. */
  lan?: LanAccess;
  /** URL path → embedded file (standalone binary). When non-empty, used instead of webDir. */
  assets?: Record<string, string>;
  sessions?: SessionCache;
  updates?: UpdateChecker;
  terminals?: TerminalWatcher;
  shells?: ShellManager;
  mcp?: McpManager;
  scheduler?: Scheduler;
  agents?: AgentRegistry;
  questions?: Questions;
  /** Restart the daemon once no run is active (POST /api/restart); missing when not running as the daemon. */
  restart?: () => { running: number; alreadyPending: boolean };
  /** Runs `gh` for bug reports (tests pass a fake). */
  gh?: GhRunner;
  /** Claude plan usage for the header pill (tests pass a fake). */
  usage?: () => Promise<UsageResult>;
  notifications?: Notifications;
  /** Shared with the notifier so both read each Codex transcript once. */
  codexSessions?: CodexSessions;
  commands?: Pick<ClaudeCommands, "get"> & Partial<Pick<ClaudeCommands, "catalog">>;
}

interface ShellSocket {
  kind: PtyKind;
  slug: string;
  /** Profile display name (the quick chat tells Claude which board it is on). */
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  shell?: Shell;
  unsubscribe?: () => void;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
const DEFAULT_MAX_PARALLEL = 5;
const CLEAR_COMMAND = { name: "clear", description: "Start a new conversation", argumentHint: "", aliases: ["new"], builtin: true };
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const INBOX_KINDS = new Set(["questions", "proposal", "reply", "blocked", "failed"]);
/** Output extensions served with their image type (raster only) so the Outputs tab can preview them. */
const OUTPUT_IMAGE_TYPES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(IMAGE_TYPES).map(([t, e]) => [e, t])),
  jpeg: "image/jpeg",
};

export function isAllowedRequest(req: Request, port: number, lanHost?: string): boolean {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  const hosts = lanHost ? [...LOCAL_HOSTS, lanHost] : LOCAL_HOSTS;
  if (!hosts.some((h) => host === `${h}:${port}`)) return false;
  const origin = req.headers.get("origin");
  // LAN cookies authorize one origin, including WebSocket upgrades and GETs.
  if (lanHost && origin && origin !== `http://${host}`) return false;
  if (req.method !== "GET" && req.method !== "HEAD" && origin) {
    if (!hosts.some((h) => origin === `http://${h}:${port}`)) return false;
  }
  return true;
}

/** WebSocket upgrades are GETs, so they need their own Origin check (browsers always send one). */
export function isAllowedSocket(req: Request, port: number, lanHost?: string): boolean {
  const origin = req.headers.get("origin");
  return isAllowedRequest(req, port, lanHost) && !!origin &&
    [...LOCAL_HOSTS, ...(lanHost ? [lanHost] : [])].some((h) => origin === `http://${h}:${port}`);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function body(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export function createServer(deps: ServerDeps) {
  if (deps.lan && !/^[a-f0-9]{64}$/.test(deps.lan.token)) throw new Error("LAN access requires a 256-bit hex token");
  if (deps.lan?.pairingCode && !/^[a-f0-9]{12}$/.test(deps.lan.pairingCode)) throw new Error("LAN pairing requires a 48-bit hex code");
  const signInLan = deps.lan ? createLanSignIn(deps.lan) : undefined;
  const { store, bus, board } = deps;
  const codexSessions = deps.codexSessions ?? new CodexSessions(store);
  const sessions = deps.sessions ?? new SessionCache();
  const updates = deps.updates ?? new UpdateChecker();
  const shells = deps.shells ?? new ShellManager();
  const mcp = deps.mcp ?? new McpManager(bus, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude" });
  const scheduler = deps.scheduler ?? new Scheduler(board, store, bus);
  const agents = deps.agents ?? new AgentRegistry();
  const questions = deps.questions ?? new Questions(store, board);
  const notifications = deps.notifications ?? new Notifications(store);
  const commands = deps.commands ?? new ClaudeCommands(process.env.CKANBAN_CLAUDE_BIN ?? "claude");

  const profileOr404 = (slug: string): Profile => {
    const p = store.getProfile(slug);
    if (!p) throw new HttpError(404, `profile ${slug} not found`);
    return p;
  };
  const ticketOr404 = (slug: string, id: string): Ticket => {
    const t = store.getTicket(slug, id);
    if (!t) throw new HttpError(404, `ticket ${id} not found`);
    return t;
  };
  // Only read when a planner has proposed tickets, so listing the board stays cheap.
  const childTitles = (slug: string, id: string) =>
    new Set(store.listTickets(slug).filter((c) => c.parentId === id).map((c) => c.title));
  /**
   * Board runs send RUN_HEADER ("<profile>/<ticket id>") with ticket changes. Runs can't change the board,
   * except a running plan's planner on its own child tickets. Returns that planner, or undefined for the user.
   */
  const plannerFor = (req: Request, slug: string, target?: Ticket): Ticket | undefined => {
    const h = req.headers.get(RUN_HEADER);
    if (!h) return undefined;
    const [runSlug, runId] = h.split("/");
    const planner = runSlug === slug && runId ? board.activePlanner(slug, runId) : null;
    if (!planner) {
      throw new HttpError(403, "changing the board is disabled inside a board run, so runs can't create or start other runs; " +
        "only the planner of a running plan may change its own child tickets");
    }
    if (target && target.parentId !== planner.id) {
      throw new HttpError(403, `${target.id} is not a child ticket of plan ${planner.id}; the planner may only change its own child tickets`);
    }
    return planner;
  };
  /** The board run's ticket (RUN_HEADER), null outside runs; a run may only reach tickets on its own board. */
  const runTicket = (req: Request, slug: string): string | null => {
    const h = req.headers.get(RUN_HEADER);
    if (!h) return null;
    const [runSlug, runId] = h.split("/");
    if (runSlug !== slug || !runId) throw new HttpError(403, `tickets can only talk to tickets on their own board (${runSlug})`);
    return runId;
  };
  const metadata = (input: Record<string, unknown>) => {
    try { return ticketMetadata(input); } catch (error) { throw new HttpError(400, (error as Error).message); }
  };
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : undefined;
  // Only read for stuck plans, so listing the board stays cheap.
  const planComplete = (slug: string, id: string) => {
    const kids = childrenOf(store.listTickets(slug), id);
    return kids.length > 0 && kids.every(isComplete);
  };
  const view = (p: Profile, t: Ticket) => {
    const running = board.isRunning(p.slug, t.id);
    const codexParsed = t.agent === "codex" ? codexSessions.get(p.slug, t.id) : null;
    const session = t.agent === "codex" ? (codexParsed ? { ...codexParsed, updatedAt: t.updatedAt } : null) : t.sessionId ? sessions.summary(t.sessionId) : null;
    return {
      ...t,
      running,
      resumeCommand: t.agent === "codex" ? (t.codexSessionId ? `cd ${shellQuote(t.workdir ?? t.worktree ?? p.path)} && codex resume ${shellQuote(t.codexSessionId)}` : null) : t.sessionId ? resumeCommand(t.workdir ?? t.worktree ?? p.path, t.sessionId) : null,
      session,
      /** Linked session is open in a terminal right now (board chat still works, UI warns). */
      terminalOpen: deps.terminals?.isOpen(p.slug, t.id) ?? false,
      attention: attentionFor(t, session, running, {
        createdTitles: session?.pendingNewTickets.length ? childTitles(p.slug, t.id) : undefined,
        managed: t.parentId ? planActive(store.getTicket(p.slug, t.parentId)?.plan) : false,
        planComplete: t.plan?.state === "stuck" ? planComplete(p.slug, t.id) : undefined,
      }),
    };
  };

  async function api(req: Request, url: URL): Promise<Response | undefined> {
    const parts = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
    const m = req.method;
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

    // Image uploads send the raw bytes. image/* types are not CORS-safelisted, so they preflight like JSON does.
    if (parts[0] === "attachments") {
      if (m === "POST" && parts.length === 1) {
        if (!IMAGE_TYPES[type]) throw new HttpError(415, "only PNG, JPEG, GIF and WebP images are supported");
        try {
          const name = saveAttachment(store.attachmentsDir, type, new Uint8Array(await req.arrayBuffer()));
          return json({ url: `/api/attachments/${name}`, path: join(store.attachmentsDir, name) }, 201);
        } catch (e) {
          if (e instanceof AttachmentError) throw new HttpError(e.status, e.message);
          throw e;
        }
      }
      if (m === "GET" && parts.length === 2) {
        const file = attachmentFile(store.attachmentsDir, parts[1]);
        if (!file) throw new HttpError(404, "attachment not found");
        return new Response(Bun.file(file), {
          headers: {
            "content-type": attachmentType(parts[1])!,
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox",
            "cache-control": "private, max-age=31536000, immutable",
          },
        });
      }
      throw new HttpError(404, "not found");
    }

    // Only JSON mutations: blocks HTML <form> posts (text/plain, urlencoded) that skip CORS preflight.
    if ((m === "POST" || m === "PATCH" || m === "PUT") && type !== "application/json") {
      throw new HttpError(415, "content-type must be application/json");
    }

    if (parts[0] === "health" && m === "GET") {
      const [claude, git, gh] = await Promise.all([
        which(process.env.CKANBAN_CLAUDE_BIN ?? "claude"), which("git"), which("gh"),
      ]);
      return json({ claude, git, gh, pty: ptySupported() });
    }

    if (parts[0] === "events" && m === "GET") return sse(req);
    if (parts[0] === "version" && m === "GET") return json(await updates.status());
    if (parts[0] === "usage" && m === "GET") return json(await (deps.usage ?? fetchUsage)());
    if (parts[0] === "inbox" && m === "GET") {
      // Every board: tickets where Claude is waiting on the user (Review is left out on purpose).
      const out = [];
      for (const p of store.listProfiles()) {
        for (const t of store.listTickets(p.slug)) {
          const att = view(p, t).attention;
          if (att && INBOX_KINDS.has(att.kind)) out.push({ profile: p.slug, profileName: p.name, id: t.id, title: t.title, attention: att });
        }
      }
      return json(out);
    }

    if (parts[0] === "notifications") {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "Notification preferences are only available outside a run");
      if (parts.length === 1 && m === "GET") return json({ publicKey: notifications.publicKey() });
      try {
        if (parts.length === 1 && m === "POST") {
          notifications.subscribe(await body(req));
          return json({ ok: true });
        }
        if (parts.length === 1 && m === "DELETE") {
          notifications.unsubscribe(String((await body(req)).endpoint ?? ""));
          return json({ ok: true });
        }
        if (parts.length === 2 && parts[1] === "test" && m === "POST") {
          await notifications.test(String((await body(req)).endpoint ?? ""));
          return json({ ok: true });
        }
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      throw new HttpError(404, "not found");
    }

    // Connections panel: Claude Code MCP servers (always from the home dir, user scope for edits).
    if (parts[0] === "mcp") {
      const name = parts[1];
      if (parts.length === 1 && m === "GET") return json(mcp.state());
      if (parts.length === 1 && m === "POST") {
        await mcp.add(await body(req));
        return json(mcp.state(), 201);
      }
      if (parts.length === 2 && name === "refresh" && m === "POST") {
        mcp.refresh();
        return json(mcp.state(), 202);
      }
      if (parts.length === 2 && m === "DELETE") {
        await mcp.remove(name);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "login") {
        mcp.login(name);
        return json(mcp.state(), 202);
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "cancel-login") {
        mcp.cancelLogin(name);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "logout") {
        await mcp.logout(name);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "recheck") {
        const s = await mcp.recheck(name);
        if (!s) throw new HttpError(502, `couldn't check ${name}; try Refresh`);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "GET" && parts[2] === "config") return json(mcp.config(name));
      if (parts.length === 2 && m === "PUT") {
        await mcp.update(name, await body(req));
        return json(mcp.state());
      }
      throw new HttpError(404, "not found");
    }

    if (parts[0] === "daily-usage" && m === "GET") return json(dailyUsage(store, 7));
    if (parts[0] === "settings" && parts.length === 1) {
      if (m === "PATCH") {
        const b = await body(req);
        const patch: Partial<Config> = {};
        for (const key of ["claudeModel", "codexModel"] as const) {
          if (b[key] === undefined) continue;
          if (b[key] !== null && !/^[a-zA-Z0-9._:\[\]-]{1,100}$/.test(String(b[key]))) throw new HttpError(400, `Invalid ${key}`);
          patch[key] = b[key] || null;
        }
        for (const key of ["claudeEffort", "codexEffort"] as const) {
          if (b[key] === undefined) continue;
          if (b[key] !== null && !EFFORTS.includes(b[key])) throw new HttpError(400, `Invalid ${key}`);
          patch[key] = b[key] || null;
        }
        store.saveConfig(patch);
      }
      const { claudeModel = null, codexModel = null, claudeEffort = null, codexEffort = null } = store.config();
      return json({ claudeModel, codexModel, claudeEffort, codexEffort });
    }

    // Connections panel: is `ckanban mcp` registered with Claude Code / Codex, and (un)register it.
    if (parts[0] === "agents") {
      if (parts.length === 1 && m === "GET") return json(await agents.status());
      if (parts.length === 3 && parts[1] === "codex" && parts[2] === "models" && m === "GET") return json(codexModels());
      const id = parts[1] as AgentId;
      if (parts.length === 3 && m === "POST" && AGENT_IDS.includes(id) && (parts[2] === "install" || parts[2] === "uninstall")) {
        await (parts[2] === "install" ? agents.install(id) : agents.uninstall(id));
        if (id === "claude") mcp.refresh();
        return json(await agents.status());
      }
      throw new HttpError(404, "not found");
    }

    // Schedule form preview: is the expression valid, what it means, when it fires next.
    if (parts[0] === "cron" && parts[1] === "preview" && parts.length === 2 && m === "GET") {
      const expr = (url.searchParams.get("expr") ?? "").trim();
      const error = expr ? cronError(expr) : "cron expression is required";
      if (error) return json({ valid: false, error, summary: null, next: [] });
      return json({ valid: true, error: null, summary: describeCron(expr), next: nextRuns(parseCron(expr), new Date(), 3).map((d) => d.toISOString()) });
    }

    if (parts[0] === "claude" && parts[1] === "projects" && m === "GET") {
      const taken = new Set(store.listProfiles().map((p) => p.path));
      return json(listClaudeProjects().map((p) => ({ ...p, hasProfile: taken.has(p.path) })));
    }
    if (parts[0] === "claude" && parts[1] === "defaults" && m === "GET") return json(claudeDefaults());
    if (parts[0] === "claude" && parts[1] === "models" && m === "GET") {
      try {
        const catalog = commands.catalog ? await commands.catalog(homedir(), false) : { models: [] };
        return json(catalog.models.filter((model) => model.value !== "default"));
      } catch (error) { throw new HttpError(503, (error as Error).message); }
    }
    if (parts[0] === "pick-folder" && m === "POST") return json({ path: await pickFolder() });
    if (parts[0] === "restart" && parts.length === 1) {
      if (m === "GET") return json(board.restartState());
      if (m === "POST") {
        if (!deps.restart) throw new HttpError(501, "restart is only available on the daemon");
        return json(deps.restart());
      }
    }

    // Report bug: context preview, then file a GitHub issue on the ckanban repo.
    if (parts[0] === "bug-report" && m === "POST" && parts.length <= 2) {
      const b = await body(req);
      const ref = b.ticketId ? { slug: String(b.profile ?? ""), id: String(b.ticketId) } : null;
      try {
        const draft = draftReport(store, ref);
        if (parts[1] === "draft") return json(draft);
        if (parts.length !== 1) throw new HttpError(404, "not found");
        const source: BugSource = b.source === "ai" || b.source === "cli" ? b.source : "ui";
        const include = Array.isArray(b.include) ? (b.include.map(String) as BugBlockId[]) : undefined;
        const r = await submitReport(
          { title: String(b.title ?? ""), description: String(b.description ?? ""), blocks: draft.blocks, include, source },
          { dataRoot: store.root, gh: deps.gh },
        );
        return json(r, r.url ? 201 : 200);
      } catch (e) {
        if (e instanceof BugReportError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }

    if (parts[0] !== "profiles") throw new HttpError(404, "not found");

    // /profiles
    if (parts.length === 1) {
      if (m === "GET") {
        return json(store.listProfiles().map((p) => ({ ...p, pathExists: existsSync(p.path), running: board.running(p.slug) })));
      }
      if (m === "POST") {
        const b = await body(req);
        const name = String(b.name ?? "").trim();
        const path = String(b.path ?? "").trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
        if (!name) throw new HttpError(400, "name is required");
        if (!path || !existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(400, `path is not a directory: ${path}`);
        let slug = slugify(name);
        for (let i = 2; store.getProfile(slug); i++) slug = `${slugify(name)}-${i}`;
        const profile: Profile = {
          name, slug, path,
          // Empty when there is nothing to branch from yet (not a repo, or no commits); runs re-detect it.
          baseBranch: b.baseBranch || ((await isGitRepo(path)) ? (await resolveBaseBranch(path, await detectBaseBranch(path))) ?? "" : ""),
          maxParallel: Math.max(1, Number(b.maxParallel) || DEFAULT_MAX_PARALLEL),
          model: b.model || null,
          createdAt: nowIso(),
        };
        store.saveProfile(profile);
        bus.emit({ type: "profile.updated", slug, profile });
        return json(profile, 201);
      }
    }

    const slug = parts[1];
    const profile = profileOr404(slug);

    // /profiles/:p
    if (parts.length === 2) {
      if (m === "GET") return json(profile);
      if (m === "PATCH") {
        const b = await body(req);
        const next: Profile = { ...profile };
        if (b.name !== undefined) next.name = String(b.name);
        if (b.path !== undefined) next.path = String(b.path);
        if (b.baseBranch !== undefined) next.baseBranch = String(b.baseBranch);
        if (b.maxParallel !== undefined) next.maxParallel = Math.max(1, Number(b.maxParallel) || 1);
        if (b.model !== undefined) next.model = b.model || null;
        if (next.path !== profile.path) shells.kill(slug);
        store.saveProfile(next);
        bus.emit({ type: "profile.updated", slug, profile: next });
        board.dispatch(slug);
        return json(next);
      }
      if (m === "DELETE") {
        if (board.running(slug) > 0) throw new HttpError(409, "profile has running tickets");
        store.deleteProfile(slug);
        shells.kill(slug);
        bus.emit({ type: "profile.updated", slug, profile: null });
        return new Response(null, { status: 204 });
      }
    }

    // /profiles/:p/sessions — Claude Code sessions started in the profile folder
    if (parts[2] === "sessions" && parts.length === 3 && m === "GET") {
      const commands = await processCommands();
      const linked = new Map(store.listTickets(slug).filter((t) => t.sessionId).map((t) => [t.sessionId!, t]));
      return json(listSessions(profile.path).map((s) => ({
        ...s,
        live: liveSessionMatch(commands, s),
        ticket: linked.has(s.id) ? { id: linked.get(s.id)!.id, title: linked.get(s.id)!.title } : null,
      })));
    }

    if (parts[2] === "codex-sessions" && parts.length === 3 && m === "GET") {
      const linked = new Map(store.listTickets(slug).filter((t) => t.codexSessionId).map((t) => [t.codexSessionId!, t]));
      return json((await listCodexSessions(profile.path)).map((s) => ({
        ...s, live: false,
        ticket: linked.has(s.id) ? { id: linked.get(s.id)!.id, title: linked.get(s.id)!.title } : null,
      })));
    }

    // /profiles/:p/files?path= (one directory level) and /profiles/:p/file?path= (read-only contents)
    if ((parts[2] === "files" || parts[2] === "file") && parts.length === 3 && m === "GET") {
      const rel = url.searchParams.get("path") ?? "";
      try {
        if (parts[2] === "files") return json({ path: rel, entries: await listDir(profile.path, rel) });
        return json(readFileForView(profile.path, rel));
      } catch (e) {
        if (e instanceof FileError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    // /profiles/:p/open-file { path } — open a file from the explorer in its default app
    if (parts[2] === "open-file" && parts.length === 3 && m === "POST") {
      const rel = String((await body(req)).path ?? "");
      try {
        openWithSystem(profile.path, rel, process.env.CKANBAN_OPEN_BIN);
      } catch (e) {
        if (e instanceof FileError) throw new HttpError(e.status, e.message);
        throw e;
      }
      return json({ ok: true });
    }

    // /profiles/:p/shell — WebSocket to the profile's interactive shell
    if (parts[2] === "shell" && parts.length === 3 && m === "GET") {
      if (!ptySupported()) throw new HttpError(501, `terminal needs Bun 1.3.5 or newer (running ${Bun.version})`);
      if (!isAllowedSocket(req, server.port ?? deps.port, deps.lan?.host)) throw new HttpError(403, "forbidden");
      const dim = (k: string, d: number) => Math.min(1000, Math.max(1, Number(url.searchParams.get(k)) || d));
      const data: ShellSocket = { kind: "shell", slug, name: profile.name, cwd: profile.path, cols: dim("cols", 80), rows: dim("rows", 24) };
      if (server.upgrade(req, { data })) return undefined;
      throw new HttpError(400, "expected a WebSocket upgrade");
    }

    // /profiles/:p/claude — WebSocket to the dock's quick Claude chat (interactive `claude` in the profile folder)
    if (parts[2] === "claude" && parts.length === 3 && m === "GET") {
      if (!ptySupported()) throw new HttpError(501, `terminal needs Bun 1.3.5 or newer (running ${Bun.version})`);
      if (!isAllowedSocket(req, server.port ?? deps.port, deps.lan?.host)) throw new HttpError(403, "forbidden");
      const dim = (k: string, d: number) => Math.min(1000, Math.max(1, Number(url.searchParams.get(k)) || d));
      const data: ShellSocket = { kind: "claude", slug, name: profile.name, cwd: profile.path, cols: dim("cols", 80), rows: dim("rows", 24) };
      if (server.upgrade(req, { data })) return undefined;
      throw new HttpError(400, "expected a WebSocket upgrade");
    }

    // /profiles/:p/claude/session — which Claude session the quick chat runs, and whether it has messages yet
    if (parts[2] === "claude" && parts[3] === "session" && parts.length === 4 && m === "GET") {
      const pty = shells.current(slug, "claude");
      const id = pty?.sessionId ?? null;
      const summary = id ? sessions.summary(id) : null;
      return json({ sessionId: id, running: !!pty && !pty.exited, started: !!summary, title: summary?.title ?? null });
    }

    // /profiles/:p/schedules — recurring ticket templates
    if (parts[2] === "schedules") {
      // Set by the ckanban MCP tools inside a board run ("<profile>/<ticket id>"): the edit is credited to that ticket.
      const run = req.headers.get(RUN_HEADER)?.split("/")[1] ?? "";
      const by: ScheduleEditor = /^t_[a-z0-9_]+$/i.test(run) ? { ticketId: run } : "user";
      if (parts.length === 3 && m === "GET") return json(store.listSchedules(slug).map((s) => scheduler.view(slug, s)));
      if (parts.length === 3 && m === "POST") return json(scheduler.view(slug, scheduler.create(slug, (await body(req)) ?? {}, by)), 201);
      const sid = parts[3];
      if (parts.length === 4 && m === "PATCH") return json(scheduler.view(slug, scheduler.update(slug, sid, (await body(req)) ?? {}, by)));
      if (parts.length === 4 && m === "DELETE") {
        scheduler.remove(slug, sid, by);
        return new Response(null, { status: 204 });
      }
      if (parts.length === 5 && parts[4] === "history" && m === "GET") return json(scheduler.history(slug, sid));
      if (parts.length === 5 && parts[4] === "run" && m === "POST") {
        const entry = await scheduler.runNow(slug, sid);
        return json({ entry, schedule: scheduler.view(slug, scheduler.get(slug, sid)) });
      }
      throw new HttpError(404, "not found");
    }

    // /profiles/:p/questions/:q/(poll|reply) — ticket-to-ticket questions (ask_ticket / reply_ticket)
    if (parts[2] === "questions" && parts.length === 5 && m === "POST") {
      const b = await body(req);
      const runId = runTicket(req, slug);
      if (parts[4] === "poll") {
        if (!runId) throw new HttpError(403, "only the asking ticket's run can wait for a reply");
        return json(questions.poll(slug, parts[3], runId, !!b.final));
      }
      if (parts[4] === "reply") return json(await questions.reply(slug, parts[3], runId, String(b.text ?? "")));
      throw new HttpError(404, "not found");
    }

    if (parts[2] === "activity" && parts.length === 3 && m === "GET") return json(store.workspaceActivity(slug));

    // /profiles/:p/tickets
    if (parts[2] !== "tickets") throw new HttpError(404, "not found");
    if (parts.length === 3) {
      if (m === "GET") return json(store.listTickets(slug).map((t) => view(profile, t)));
      if (m === "POST") {
        const b = await body(req);
        const title = String(b.title ?? "").trim();
        if (!title) throw new HttpError(400, "title is required");
        const planner = plannerFor(req, slug);
        let status: Status = STATUSES.includes(b.status) ? b.status : "backlog";
        let mode: "auto" | "interview" = b.mode === "auto" ? "auto" : "interview";
        let parentId = typeof b.parentId === "string" && b.parentId ? b.parentId : undefined;
        const planKey = typeof b.planKey === "string" && b.planKey.trim() ? b.planKey.trim() : undefined;
        const dependsOn = strings(b.dependsOn);
        if (planner) {
          // A planner adds children to its own plan; the board starts them when their dependencies are done.
          const kids = store.listTickets(slug).filter((c) => c.parentId === planner.id);
          const cap = 2 * Math.max(1, planner.plan!.originalCount);
          if (kids.length >= cap) throw new HttpError(409, `child ticket limit reached (${cap}) for this plan`);
          const missing = (dependsOn ?? []).filter((d) => !kids.some((k) => k.id === d || k.planKey === d));
          if (missing.length) throw new HttpError(400, `unknown dependency ${missing.join(", ")}: use a sibling's ticket id or key`);
          [parentId, status, mode] = [planner.id, "backlog", "auto"];
        }
        if (parentId && !store.getTicket(slug, parentId)) throw new HttpError(400, `parent ticket ${parentId} not found`);
        if (b.agent === "codex" && b.sessionId) throw new HttpError(400, "Existing Claude sessions cannot be linked to Codex tickets");
        if (b.codexSessionId !== undefined && (b.agent !== "codex" || !/^[a-f0-9-]{36}$/i.test(String(b.codexSessionId)))) throw new HttpError(400, "Use a Codex session id with a Codex session");
        // A standalone session never sits in a running column: messages start its runs.
        const standalone = b.standalone === true && !planner;
        let t = await board.createTicket(slug, {
          ...metadata(b), title, body: String(b.body ?? ""), status: standalone ? "backlog" : b.sessionId && !planner ? "backlog" : status, mode, parentId, planKey, dependsOn,
          ...(standalone ? { standalone, access: b.access === "edit" ? "edit" : "read", isolated: b.isolated === true } : {}),
          ...(b.codexSessionId ? { codexSessionId: String(b.codexSessionId) } : {}),
        });
        if (planner) store.addComment(slug, t.id, "ai", `Created by the planner of plan ${planner.id}.`);
        if (b.sessionId && !planner) {
          try {
            await board.linkSession(slug, t.id, String(b.sessionId));
            // linkSession lands board tickets in Review; a session stays in its own place.
            t = await board.updateTicket(slug, t.id, { status: standalone ? "backlog" : status });
          } catch (e) {
            await board.deleteTicket(slug, t.id);
            throw new HttpError(400, (e as Error).message);
          }
        }
        return json(view(profile, store.getTicket(slug, t.id)!), 201);
      }
    }

    const id = parts[3];
    ticketOr404(slug, id);

    if (parts.length === 4) {
      if (m === "GET") return json(view(profile, store.getTicket(slug, id)!));
      if (m === "PATCH") {
        const b = await body(req);
        if (b.status !== undefined && !STATUSES.includes(b.status)) throw new HttpError(400, `invalid status ${b.status}`);
        const target = store.getTicket(slug, id)!;
        const planner = plannerFor(req, slug, target);
        const patch: Parameters<Board["updateTicket"]>[2] = metadata(b);
        for (const key of ["codexModel", "codexEffort"]) if (key in b && b[key] !== null && typeof b[key] !== "string") throw new HttpError(400, `Invalid ${key}`);
        if (b.codexModel === null || typeof b.codexModel === "string") patch.codexModel = b.codexModel;
        if (b.codexEffort === null || typeof b.codexEffort === "string") patch.codexEffort = b.codexEffort;
        if (b.access === "read" || b.access === "edit") patch.access = b.access;
        if (typeof b.readAt === "string" && !Number.isNaN(Date.parse(b.readAt))) patch.readAt = b.readAt;
        if (b.standalone === false) patch.standalone = false;
        const deps = strings(b.dependsOn);
        if (deps) patch.dependsOn = deps;
        if (b.mode === "auto" || b.mode === "interview") patch.mode = b.mode;
        if (typeof b.expectedBody === "string") patch.expectedBody = b.expectedBody;
        if (typeof b.title === "string") patch.title = b.title;
        if (typeof b.body === "string") patch.body = b.body;
        if (b.status) patch.status = b.status;
        if (typeof b.order === "number") patch.order = b.order;
        if (b.notice === null) patch.notice = null;
        if (planner) {
          delete patch.order;
          delete patch.notice;
          if (patch.status === "ready" && target.status !== "ready" && target.runCount > 0) {
            try {
              board.countRetry(slug, planner.id, id, MAX_RETRIES);
            } catch (e) {
              throw new HttpError(409, (e as Error).message);
            }
          }
        }
        let t: Ticket;
        try {
          t = await board.updateTicket(slug, id, patch);
        } catch (e) {
          if (e instanceof ConflictError) throw e;
          throw new HttpError(400, (e as Error).message);
        }
        if (planner) {
          const what = Object.entries(patch).map(([k, v]) => (k === "status" ? `moved it to ${v}` : `changed ${k}`)).join(", ");
          if (what) store.addComment(slug, id, "ai", `Planner ${what}.`);
        }
        return json(view(profile, t));
      }
      if (m === "DELETE") {
        if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "deleting tickets is disabled inside a board run");
        await board.deleteTicket(slug, id);
        return new Response(null, { status: 204 });
      }
    }

    const action = parts[4];
    if (action === "review" && parts.length === 5 && m === "GET") {
      try { return json(await ticketReview(profile, ticketOr404(slug, id), store, url.searchParams.get("file") ?? undefined)); }
      catch (error) { throw new HttpError(400, (error as Error).message); }
    }
    if (action === "commands" && parts.length === 5 && m === "GET") {
      const ticket = store.getTicket(slug, id)!;
      const cwd = ticket.workdir ?? ticket.worktree ?? profile.path;
      if (ticket.agent === "codex") {
        const skills = codexSkills(cwd).map((skill) => ({ name: skill.name, description: skill.description, argumentHint: "", aliases: [], builtin: false, insert: `$${skill.name} ` }));
        return json({ commands: [...codexCommands(), ...skills], models: [], efforts: [], outputStyles: [], defaultModel: store.config().codexModel ?? null });
      }
      try {
        const plan = ticket.status === "backlog" || ticket.status === "planning", refresh = url.searchParams.get("refresh") === "1";
        const catalog = commands.catalog ? await commands.catalog(cwd, plan, refresh) : { commands: await commands.get(cwd, plan, refresh), models: [] };
        // Headless Claude can't /clear itself; the board starts the new conversation (see Board.chat).
        const list = catalog.commands.some((c) => c.name === "clear") ? catalog.commands : [CLEAR_COMMAND, ...catalog.commands];
        return json({ ...catalog, commands: list, efforts: effortOptions(catalog.commands), outputStyles: catalog.outputStyles ?? [], defaultModel: profile.model ?? store.config().claudeModel ?? null });
      } catch (error) { throw new HttpError(503, (error as Error).message); }
    }
    if (["model", "effort", "output-style"].includes(action) && parts.length === 5 && m === "POST") {
      if (store.getTicket(slug,id)?.agent === "codex") throw new HttpError(400, "Use Codex ticket settings");
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "Claude settings are only available outside a board run");
      const b = await body(req), ticket = store.getTicket(slug, id)!;
      const field = action === "output-style" ? "outputStyle" : action;
      const value = b[field];
      if (value !== null) {
        let catalog;
        try {
          const cwd = ticket.workdir ?? ticket.worktree ?? profile.path, plan = ticket.status === "backlog" || ticket.status === "planning";
          catalog = commands.catalog ? await commands.catalog(cwd, plan) : { commands: await commands.get(cwd, plan), models: [] };
        }
        catch (error) { throw new HttpError(503, (error as Error).message); }
        const available = action === "model" ? catalog.models.some((model) => model.value === value) : action === "effort" ? effortOptions(catalog.commands, catalog.models, ticket.model ?? profile.model).some((level) => level === value) : catalog.outputStyles?.includes(value);
        if (typeof value !== "string" || !available) throw new HttpError(400, `Choose an available Claude ${action}`);
      }
      return json(view(profile, await board.updateTicket(slug, id, { [field]: value })));
    }
    if (action === "activity" && m === "GET") return json(store.readActivity(slug, id));
    if (action === "outputs" && m === "GET") {
      if (parts.length === 5) return json(store.listOutputs(slug, id));
      const file = store.outputPath(slug, id, parts.slice(5).join("/"));
      if (!file) throw new HttpError(404, "output not found");
      // Plain text + sandbox: files are written by Claude and must never run as HTML on this origin.
      // Only raster images get their real type so the viewer can preview them; SVG stays text (it can carry scripts).
      const image = OUTPUT_IMAGE_TYPES[file.slice(file.lastIndexOf(".") + 1).toLowerCase()];
      return new Response(Bun.file(file), {
        headers: {
          "content-type": image ?? "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
        },
      });
    }
    if (action === "conversation" && m === "GET") {
      // Read-only view of the ticket's Claude session file (terminal chat + board runs), newest last.
      const t = store.getTicket(slug, id)!;
      const parsed = t.agent === "codex" ? codexSessions.get(slug, id) : t.sessionId ? sessions.get(t.sessionId) : null;
      const all = mergeCommandEntries(parsed?.entries ?? [], t.agent === "codex" ? [] : store.readCommandEntries(slug, id).filter((entry) => entry.sessionId === t.sessionId));
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : all.length;
      const end = Math.max(0, Math.min(all.length, before));
      const start = Math.max(0, end - limit);
      return json({ entries: all.slice(start, end), start, total: all.length, title: parsed?.title ?? null });
    }
    if (action === "comments") {
      if (m === "GET") return json(store.listComments(slug, id));
      if (m === "POST") {
        const b = await body(req);
        const text = String(b.text ?? "").trim();
        if (!text) throw new HttpError(400, "text is required");
        // The child reads user comments on its next run; mark who wrote this one.
        const planner = plannerFor(req, slug, store.getTicket(slug, id)!);
        return json(board.addComment(slug, id, planner ? `Planner: ${text}` : text), 201);
      }
    }
    // Another ticket's Claude asks this ticket's Claude (ask_ticket); the asker then polls questions/:q/poll.
    if (m === "POST" && action === "ask") {
      const from = runTicket(req, slug);
      if (!from) throw new HttpError(403, "ask_ticket only works inside a board run (it asks on behalf of that run's ticket)");
      const b = await body(req);
      const q = await questions.ask(slug, from, id, String(b.question ?? ""), Number(b.waitMs) || 0);
      return json(q, 201);
    }
    if (m === "POST" && action === "chat") {
      plannerFor(req, slug, store.getTicket(slug, id)!);
      const b = await body(req);
      const text = String(b.text ?? "").trim();
      if (!text) throw new HttpError(400, "text is required");
      const t = await board.chat(slug, id, text);
      return json(view(profile, t), 202);
    }
    // A message Stop left unsent: POST .../queued/<msgId> sends it, DELETE discards it.
    if (action === "queued" && parts[5] && (m === "POST" || m === "DELETE")) {
      try {
        const t = m === "POST" ? await board.sendQueued(slug, id, parts[5]) : board.discardQueued(slug, id, parts[5]);
        return json(view(profile, t), m === "POST" ? 202 : 200);
      } catch (e) {
        if (e instanceof ConflictError) throw e;
        throw new HttpError(404, (e as Error).message);
      }
    }
    if (m === "POST" && action === "link-session") {
      const b = await body(req);
      try {
        const t = await board.linkSession(slug, id, b.sessionId ? String(b.sessionId) : null);
        return json(view(profile, t));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    if (m === "POST" && action === "stop") {
      const planner = plannerFor(req, slug, store.getTicket(slug, id)!);
      const stopped = board.stop(slug, id);
      if (planner && stopped) store.addComment(slug, id, "ai", "Planner stopped this run.");
      return json({ stopped });
    }
    // Start / pause / resume / mark done a planner's plan, or change how many children run at once.
    if (m === "POST" && action === "plan") {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can start or pause a plan");
      const b = await body(req);
      const n = b.maxConcurrent === undefined ? undefined : Number(b.maxConcurrent);
      try {
        const t = b.action === "pause" ? board.pausePlan(slug, id)
          : b.action === "start" || b.action === "resume" ? board.startPlan(slug, id, { maxConcurrent: n })
          : b.action === "done" ? board.markPlanDone(slug, id)
          : b.action === "concurrency" && n !== undefined ? board.setPlanConcurrency(slug, id, n)
          : null;
        if (!t) throw new HttpError(400, "action must be start, pause, resume, done or concurrency");
        return json(view(profile, store.getTicket(slug, id) ?? t));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
    }
    if (action === "files" && parts.length === 5 && m === "GET") {
      const t = store.getTicket(slug, id)!;
      return json(await searchFiles(t.workdir ?? t.worktree ?? profile.path, url.searchParams.get("q") ?? ""));
    }
    if (action === "git" && parts.length === 5 && m === "POST") {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "git actions are only available outside a board run");
      const b = await body(req);
      if (!["commit", "push", "pr"].includes(b.action)) throw new HttpError(400, "action must be commit, push or pr");
      try {
        return json(view(profile, await board.gitAction(slug, id, b.action, String(b.message ?? ""))));
      } catch (e) {
        if (e instanceof ConflictError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
    }
    if (m === "POST" && action === "check-pr") {
      const state = await checkPr(board, store, slug, id);
      return json({ state, ticket: view(profile, store.getTicket(slug, id)!) });
    }
    if (m === "POST" && action === "planning-command") {
      try {
        return json({ command: await board.planningCommand(slug, id) });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    throw new HttpError(404, "not found");
  }

  function sse(req: Request): Response {
    let unsubscribe = () => {};
    let ping: ReturnType<typeof setInterval>;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (s: string) => {
          try {
            controller.enqueue(enc.encode(s));
          } catch {}
        };
        send(": connected\n\n");
        unsubscribe = bus.on((e: BusEvent) => {
          let out: unknown = e;
          if (e.type === "ticket.updated") {
            const p = store.getProfile(e.profile);
            if (p) out = { ...e, ticket: view(p, e.ticket) };
          }
          send(`data: ${JSON.stringify(out)}\n\n`);
          // Session changes (terminal chat, new questions) change the ticket's "your turn" state too.
          if (e.type === "session.updated") {
            const p = store.getProfile(e.profile);
            const t = p && store.getTicket(e.profile, e.id);
            if (p && t) send(`data: ${JSON.stringify({ type: "ticket.updated", profile: e.profile, ticket: view(p, t) })}\n\n`);
          }
        });
        ping = setInterval(() => send(": ping\n\n"), 15_000);
        req.signal.addEventListener("abort", () => {
          unsubscribe();
          clearInterval(ping);
          try {
            controller.close();
          } catch {}
        });
      },
      cancel() {
        unsubscribe();
        clearInterval(ping);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  function staticFile(url: URL): Response {
    const respond = (path: string, file: string) => {
      const headers: Record<string, string> = {};
      if (path === "/sw.js") {
        headers["content-type"] = "application/javascript; charset=utf-8";
        headers["cache-control"] = "no-cache";
        headers["service-worker-allowed"] = "/";
      } else if (path === "/manifest.webmanifest") {
        headers["content-type"] = "application/manifest+json; charset=utf-8";
        headers["cache-control"] = "no-cache";
      } else if (path.endsWith(".html")) headers["cache-control"] = "no-cache";
      else if (["/pwa-shell.js", "/pwa-shell.css"].includes(path)) headers["cache-control"] = "no-cache";
      return new Response(Bun.file(file), { headers });
    };
    // A missing script/icon/manifest must not become an HTML response or be cached as one.
    const requiredAsset = url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/") ||
      ["/sw.js", "/manifest.webmanifest", "/offline.html", "/pwa-shell.js", "/pwa-shell.css"].includes(url.pathname);
    const assets = deps.assets ?? {};
    if (Object.keys(assets).length) {
      const exact = assets[url.pathname];
      const hit = exact ?? (!requiredAsset ? assets["/index.html"] : undefined);
      if (!hit) return new Response("not found", { status: 404 });
      return respond(exact ? url.pathname : "/index.html", hit);
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(deps.webDir, rel);
    if (file.startsWith(deps.webDir) && existsSync(file) && statSync(file).isFile()) return respond(url.pathname, file);
    if (requiredAsset) return new Response("not found", { status: 404 });
    const index = join(deps.webDir, "index.html");
    if (existsSync(index)) return respond("/index.html", index);
    return new Response("UI not built. Run: bun run build:web", { status: 404 });
  }

  function attachShell(ws: import("bun").ServerWebSocket<ShellSocket>, restart = false, resumeChat = false) {
    const d = ws.data;
    d.unsubscribe?.();
    let shell: Shell;
    try {
      // An exited quick chat that has messages comes back on the same session ("Start again").
      const prev = shells.current(d.slug, d.kind);
      const resume = resumeChat && !!prev?.sessionId && sessions.version(prev.sessionId) !== null;
      shell = shells.get(d.slug, d.cwd, d.cols, d.rows, restart, d.kind, resume, d.name);
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: (e as Error).message }));
      return;
    }
    d.shell = shell;
    const back = shell.scrollback();
    if (back.length) ws.sendBinary(back);
    if (shell.exited) ws.send(JSON.stringify({ type: "exit", code: shell.exitCode }));
    else shell.resize(d.cols, d.rows);
    d.unsubscribe = shell.subscribe((e) => {
      if (e.type === "data") ws.sendBinary(e.data);
      else ws.send(JSON.stringify({ type: "exit", code: e.code }));
    });
  }

  const server = Bun.serve<ShellSocket>({
    hostname: deps.lan ? "0.0.0.0" : "127.0.0.1",
    port: deps.port,
    idleTimeout: 0,
    async fetch(req): Promise<Response> {
      if (!isAllowedRequest(req, server.port ?? deps.port, deps.lan?.host)) return new Response("forbidden", { status: 403 });
      if (deps.lan) {
        if (new URL(req.url).pathname === "/lan/sign-in" && req.method === "POST") {
          return signInLan!(req, server.requestIP(req)?.address);
        }
        const denied = authorizeLan(req, server.requestIP(req)?.address, deps.lan);
        if (denied) return denied;
      }
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/api/")) return staticFile(url);
      try {
        return (await api(req, url)) as Response;
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        if (e instanceof ConflictError) return json({ error: e.message }, 409);
        if (e instanceof McpError) return json({ error: e.message }, e.status);
        if (e instanceof AgentError) return json({ error: e.message }, e.status);
        if (e instanceof ScheduleError) return json({ error: e.message }, e.status);
        if (e instanceof QuestionError) return json({ error: e.message }, e.status);
        if (e instanceof URIError) return json({ error: "malformed URL" }, 400);
        console.error(e);
        return json({ error: (e as Error).message ?? "internal error" }, 500);
      }
    },
    websocket: {
      open: (ws) => attachShell(ws),
      message(ws, raw) {
        let msg: any;
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        } catch {
          return;
        }
        const shell = ws.data.shell;
        if (msg.type === "input" && typeof msg.data === "string") shell?.write(msg.data);
        else if (msg.type === "resize") {
          ws.data.cols = Math.min(1000, Math.max(1, Number(msg.cols) || 80));
          ws.data.rows = Math.min(1000, Math.max(1, Number(msg.rows) || 24));
          shell?.resize(ws.data.cols, ws.data.rows);
        } else if (msg.type === "restart") {
          // Another tab may already have restarted it: then just join the new shell.
          ws.send(JSON.stringify({ type: "reset" }));
          attachShell(ws, shells.current(ws.data.slug, ws.data.kind) === shell, msg.resume === true);
        }
      },
      close: (ws) => ws.data.unsubscribe?.(),
    },
  });
  return server;
}
