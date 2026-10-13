import { NotificationsDialog } from "./NotificationsDialog";
import { WorkspaceControls, WorkspaceActivity, TicketList, EMPTY_FILTER, type WorkspaceFilter } from "./Workspace";
import { metadataMatches } from "./ticketTemplates";
import { ChatsView, NewSessionDialog, SessionView } from "./Sessions";
import { Modal } from "./Modal";
import { usePersistentState } from "./usePersistentState";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, copy, COLUMNS, onReconnect, subscribe, waitsForSlot, type Health, type InboxItem, type McpServer, type McpState, type Profile, type Schedule, type Status, type Ticket } from "./api";
import { avatarColor, avatarLetter } from "./avatar";
import { BugReportDialog } from "./BugReportDialog";
import { ConnectionsDialog } from "./ConnectionsDialog";
import { HeaderMenu, withSections } from "./HeaderMenu";
import { AtIcon, BellIcon, BugIcon, ChatIcon, CheckIcon, ClockIcon, CloseIcon, ColumnsIcon, ContrastIcon, CopyIcon, DeviceIcon, DollarIcon, GearIcon, HistoryIcon, KeyboardIcon, PlusIcon, PlugIcon, RefreshIcon, SearchIcon, SlidersIcon, TeamIcon, TerminalIcon, TrashIcon } from "./icons";
import { buzz } from "./haptics";
import { Inbox } from "./Inbox";
import { AlertsDialog } from "./AlertsDialog";
import { AwayDialog } from "./AwayDialog";
import { phoneAccessLabel, type TunnelStatus } from "./awayText";
import { UsagePill } from "./UsagePill";
import { anyLayerOpen } from "./layers";
import { Board } from "./Board";
import { boardColumnOf, columnNeighbours, columnOrder } from "./columns";
import { NewTicketDialog } from "./NewTicketDialog";
import { DailyCostDialog } from "./DailyCostDialog";
import { QuickRepliesDialog } from "./QuickRepliesDialog";
import { DefaultModelsDialog } from "./DefaultModelsDialog";
import { ProfileDialog } from "./ProfileDialog";
import { SchedulesDialog } from "./SchedulesDialog";
import { SnippetsDialog } from "./SnippetsDialog";
import { Select } from "./Select";
import { SearchDialog } from "./SearchDialog";
import { BoardSwitcher, ShortcutsDialog } from "./Shortcuts";
import { CommandBar, type CommandAction } from "./CommandBar";
import { boardDigit, cardDir, isTyping, stepBoard, stepCard, type CardPos } from "./keynav";
import { KeyHint, useHintReveal } from "./KeyHint";
import { TicketDrawer } from "./TicketDrawer";
import { toast, Toaster } from "./toast";
import { PHONE, useMediaQuery } from "./useMediaQuery";
import { useViewport } from "./useViewport";
import { InstallDialog, usePwa } from "./Pwa";

import type { DockTab } from "./Dock";
import { setThemeChoice, themeChoice, type ThemeChoice } from "./theme";
import { SampleOffer } from "./SampleOffer";
import type { HuddleSeed, TeamRequest } from "./Team";
import { useBoardHuddles } from "./huddle";
import { hasOpenPr, runCounts } from "./boardStats";

// xterm.js and highlight.js only load once the panel is opened. After an upgrade the old chunk is gone:
// reload once to get the new build instead of blanking the whole page.
const Dock = lazy(() => import("./Dock").then((m) => {
  sessionStorage.removeItem("ckanban.chunkReload");
  return m;
}, () => {
  if (!sessionStorage.getItem("ckanban.chunkReload")) {
    sessionStorage.setItem("ckanban.chunkReload", "1");
    location.reload();
  }
  return { default: ({ onClose }: { onClose: () => void }) => <div className="dock dock-failed" role="alert">
    <p>Couldn't load the tools panel.</p><div className="actions">
      <button className="btn primary" onClick={() => location.reload()}>Reload</button>
      <button className="btn" onClick={onClose}>Close</button>
    </div>
  </div> };
}));
const DOCK_OPEN = "ckanban.dock.open";

const LAST_PROFILE = "ckanban.profile";
const LAST_OPEN = "ckanban.open";

/** The chat or ticket that was open in each repo, so coming back to a repo reopens it. */
function readOpenMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LAST_OPEN) ?? "{}");
  } catch {
    return {};
  }
}

function saveOpen(slug: string, id: string | null) {
  try {
    const map = readOpenMap();
    if (id) map[slug] = id;
    else delete map[slug];
    localStorage.setItem(LAST_OPEN, JSON.stringify(map));
  } catch {}
}

/** Board slug the sample ticket is offered on, until it is started or dismissed. */
const SAMPLE_OFFER = "ckanban.sample-offer";

/** URL hash is the source of truth for what's open: #/<profile> or #/<profile>/<ticketId>. */
function parseHash(): { slug: string | null; ticket: string | null } {
  const [, slug, ticket] = decodeURIComponent(location.hash.replace(/^#/, "")).split("/");
  return { slug: slug || null, ticket: ticket || null };
}

function hashFor(slug: string | null, ticket?: string | null): string {
  if (!slug) return "#/";
  return `#/${encodeURIComponent(slug)}${ticket ? `/${encodeURIComponent(ticket)}` : ""}`;
}

/** Cards on screen, per expanded column, in board order. */
function cardGrid(): HTMLElement[][] {
  return [...document.querySelectorAll<HTMLElement>(".board > .column:not(.collapsed)")]
    .map((c) => [...c.querySelectorAll<HTMLElement>(".column-body > .sortable-card")]);
}

function focusedCard(grid: HTMLElement[][]): CardPos | null {
  const el = (document.activeElement as HTMLElement | null)?.closest?.(".sortable-card");
  for (let col = 0; col < grid.length; col++) {
    const row = grid[col].findIndex((c) => c === el);
    if (row >= 0) return { col, row };
  }
  return null;
}

function focusCard(pos: CardPos | null, grid = cardGrid()) {
  const col = pos && grid[pos.col];
  const el = col && col[Math.min(pos.row, col.length - 1)];
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Board filter chips; several on = tickets matching any of them. */
const FILTERS = [
  { id: "you", label: "Needs you", test: (t: Ticket) => !!t.attention },
  { id: "running", label: "Running", test: (t: Ticket) => t.status === "in_progress" || !!t.running },
  { id: "pr", label: "Has PR", test: hasOpenPr },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];

const DISMISSED = "ckanban.dismissedBanners";
function readDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DISMISSED) ?? "[]"));
  } catch {
    return new Set();
  }
}

const tildePath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/** Background load: retry once after a few seconds, then say so (quietly) instead of failing silently. */
function quiet<T>(load: () => Promise<T>, what: string, set: (v: T) => void) {
  load().then(set).catch(() => {
    setTimeout(() => load().then(set).catch(() => toast(`Couldn't load ${what}. It will retry when the connection comes back.`, { tone: "error" })), 3000);
  });
}

/** Why Connections needs you, e.g. "GitHub needs you to log in again" or "2 connections failed". */
function connectionsReason(servers: McpServer[]): string {
  const bad = servers.filter((s) => s.attention);
  const failed = bad.filter((s) => s.status === "failed").length;
  if (bad.length === 1) return failed ? `${bad[0].name} failed to connect` : `${bad[0].name} needs you to log in again`;
  if (failed === bad.length) return `${bad.length} connections failed`;
  if (failed === 0) return `${bad.length} connections need you to log in again`;
  return `${bad.length} connections need you`;
}

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_PROFILE);
  } catch {
    return null;
  }
}

const THEME_ORDER: ThemeChoice[] = ["system", "light", "dark"];
const THEME_LABEL: Record<ThemeChoice, string> = { system: "System", light: "Light", dark: "Dark" };

export function App() {
  useViewport();
  const pwa = usePwa();
  const compact = useMediaQuery(PHONE);
  const narrow = useMediaQuery("(max-width: 900px)");
  // No keyboard to speak of: hides Keyboard shortcuts (iPads keep it).
  const phoneWidth = useMediaQuery("(max-width: 767px)");
  const [usageRequest, setUsageRequest] = useState(0);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [slug, setSlug] = useState<string | null>(parseHash().slug ?? readLast());
  // Switching repos reopens what was open there last.
  const switchRepo = (next: string) => {
    setSlug(next);
    setOpenId(readOpenMap()[next] ?? null);
  };
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [dockOpen, setDockOpen] = useState(() => {
    try {
      return localStorage.getItem(DOCK_OPEN) === "1";
    } catch {
      return false;
    }
  });
  const [openId, setOpenId] = useState<string | null>(() => parseHash().ticket ?? (slug ? readOpenMap()[slug] ?? null : null));
  // True when the open ticket was pushed onto browser history by us, so closing can go Back.
  const pushedOpen = useRef(false);
  // Board shown before that push: going Back to a different board would leave the ticket's board.
  const pushedFrom = useRef<string | null>(null);
  // The open ticket was reached with prev/next: the drawer stays put instead of sliding in again.
  const stepped = useRef(false);
  // Column and ticket order prev/next follow, frozen when the drawer opens (see below).
  const [navOrder, setNavOrder] = useState<{ column: Status; ids: string[] } | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const inboxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [profileDialog, setProfileDialog] = useState<"new" | "edit" | null>(null);
  const [newTicket, setNewTicket] = useState(false);
  const [sampleFor, setSampleForState] = useState(() => { try { return localStorage.getItem(SAMPLE_OFFER); } catch { return null; } });
  const setSampleFor = (v: string | null) => {
    setSampleForState(v);
    try { if (v) localStorage.setItem(SAMPLE_OFFER, v); else localStorage.removeItem(SAMPLE_OFFER); } catch {}
  };
  const setError = (msg: string) => toast(msg, { tone: "error" });
  const [activityOpen, setActivityOpen] = useState(false);
  const [newSession, setNewSession] = useState(false);
  // Board: tickets in lanes. Chats: sessions as a messenger, off the board.
  const [mode, setMode] = usePersistentState<"board" | "chats">("esa.mode", () => "board", () => false, (v) => v === "board" || v === "chats");
  const [theme, setTheme] = useState(themeChoice);
  const [cleanup, setCleanup] = useState<boolean | null>(null);
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
  const [awayOpen, setAwayOpen] = useState(false);
  useEffect(() => {
    api.settings().then((s) => setCleanup(!!s.cleanup), () => {});
    api.away().then((a) => setTunnel(a.tunnel), () => {});
  }, []);
  const [layout, setLayout] = useState<"board" | "list">("board");
  const [metadataFilter, setMetadataFilter] = useState<WorkspaceFilter>(EMPTY_FILTER);
  const [filters, setFilters] = useState<Set<FilterId>>(new Set());
  const [dismissed, setDismissed] = useState(readDismissed);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [defaultModelsOpen, setDefaultModelsOpen] = useState(false);
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(false);
  const [dailyCostOpen, setDailyCostOpen] = useState(false);
  // Phones: search and filters sit behind a magnifier until needed.
  const [searchOpen, setSearchOpen] = useState(false);
  const attentionSeen = useRef(new Map<string, string | null>());
  // Tickets already on screen count as seen, so only later changes buzz.
  useEffect(() => { for (const t of tickets) if (!attentionSeen.current.has(t.id)) attentionSeen.current.set(t.id, t.attention?.kind ?? null); }, [tickets]);
  // "#/<board>/<ticket>": a shared or reloaded ticket link should not be covered by the inbox.
  const startedOnTicket = useRef(!!openId);
  // The installed app's icon badge shows how many tickets and sessions wait on you.
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (count: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (inbox.length) nav.setAppBadge?.(inbox.length).catch(() => {});
    else nav.clearAppBadge?.().catch(() => {});
  }, [inbox.length]);
  const [shortcuts, setShortcuts] = useState(false);
  useHintReveal();
  const [bugReport, setBugReport] = useState(false);
  const [fullSearch, setFullSearch] = useState(false);
  // ⌘K command bar; the inbox and usage popovers open from it too (n makes repeats count).
  const [commandBar, setCommandBar] = useState(false);
  const [inboxRequest, setInboxRequest] = useState(0);
  const [boardSwitcher, setBoardSwitcher] = useState(false);
  // Command to type into the dock's terminal (e.g. "claude mcp login x"); n makes repeats count.
  const [dockCommand, setDockCommand] = useState<{ text: string; n: number } | null>(null);
  // Tab the dock should switch to (C opens the quick Claude chat).
  const [dockTab, setDockTab] = useState<{ tab: DockTab; n: number; team?: TeamRequest } | null>(null);
  // Tab the open dock shows (reported by the dock), for the header buttons' on state.
  const [dockShown, setDockShown] = useState<DockTab | null>(null);
  const chatOpen = dockOpen && dockShown === "claude";
  const termOpen = dockOpen && (dockShown === "terminal" || dockShown === "files");
  const teamOpen = dockOpen && dockShown === "team";
  /** team: what the Team tab shows (the new-teammate editor, a proposal to edit, a teammate). */
  const openDockOn = (tab: DockTab, team?: TeamRequest) => {
    setDockOpen(true);
    setDockTab({ tab, n: Date.now(), ...(team ? { team } : {}) });
  };
  const toggleTeam = () => (teamOpen ? setDockOpen(false) : openDockOn("team"));
  const [mcp, setMcp] = useState<McpState | null>(null);
  const [connections, setConnections] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const schedulesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [version, setVersion] = useState<{ version: string; latest: string | null; updateAvailable: boolean } | null>(null);

  const loadProfiles = useCallback(async () => {
    const ps = await api.profiles();
    setProfiles(ps);
    setSlug((cur) => (cur && ps.some((p) => p.slug === cur) ? cur : ps[0]?.slug ?? null));
  }, []);

  const slugRef = useRef(slug);
  slugRef.current = slug;
  const loadSchedules = useCallback((board: string) => api.schedules(board).then((list) => {
    // Ignore a late answer for a board we already left.
    if (slugRef.current === board) setSchedules(list);
  }).catch(() => {}), []);
  // Fires and ticket changes move "next run", "running" and errors: refetch for the computed fields.
  const refreshSchedulesSoon = useCallback((board: string) => {
    if (schedulesTimer.current) return;
    schedulesTimer.current = setTimeout(() => {
      schedulesTimer.current = null;
      loadSchedules(board);
    }, 300);
  }, [loadSchedules]);

  const [snoozed, setSnoozed] = useState<InboxItem[]>([]);
  const loadInbox = useCallback(() => quiet(api.inbox, "the inbox", (list) => {
    setInbox(list.filter((i) => !i.snoozedUntil));
    setSnoozed(list.filter((i) => i.snoozedUntil));
  }), []);
  const refreshInboxSoon = useCallback(() => {
    if (inboxTimer.current) return;
    inboxTimer.current = setTimeout(() => {
      inboxTimer.current = null;
      loadInbox();
    }, 400);
  }, [loadInbox]);

  useEffect(() => {
    loadProfiles().catch((e) => setError(e.message));
    loadInbox();
    quiet(api.health, "tool checks", setHealth);
    quiet(api.version, "the version", setVersion);
    quiet(api.mcp, "connections", setMcp);
  }, [loadProfiles, loadInbox]);
  // First visit with no boards yet: open New board straight away (it lists recent Claude Code folders).
  const autoOpened = useRef(false);
  useEffect(() => {
    if (profiles?.length !== 0 || autoOpened.current) return;
    autoOpened.current = true;
    setProfileDialog("new");
  }, [profiles]);

  // Browser Back/Forward and pasted links drive the open board and ticket.
  useEffect(() => {
    const onHash = () => {
      const h = parseHash();
      if (h.slug) setSlug(h.slug);
      setOpenId(h.ticket);
      stepped.current = false;
      if (!h.ticket) pushedOpen.current = false;
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Keep the URL in step with the board shown (replace, so switching boards doesn't pile up history).
  useEffect(() => {
    if (slug && (parseHash().slug !== slug || parseHash().ticket !== openId)) history.replaceState(null, "", hashFor(slug, openId));
  }, [slug]);

  useEffect(() => { if (slug) saveOpen(slug, openId); }, [slug, openId]);

  const openTicket = useCallback((id: string, board = slug) => {
    if (!board) return;
    pushedOpen.current = true;
    pushedFrom.current = slug;
    location.hash = hashFor(board, id);
  }, [slug]);

  // Prev/next in the drawer: replace the history entry, so one Close or Back still returns to the board.
  const stepTicket = useCallback((id: string) => {
    stepped.current = true;
    history.replaceState(null, "", hashFor(slug, id));
    setOpenId(id);
  }, [slug]);

  // A huddle badge or the dock's Huddles list: open the ticket on its Huddle tab.
  const [huddleTab, setHuddleTab] = useState<{ id: string; n: number; huddleId?: string } | null>(null);
  const openHuddle = useCallback((id: string, huddleId?: string) => {
    setHuddleTab({ id, n: Date.now(), huddleId });
    if (id !== openId) openTicket(id);
  }, [openId, openTicket]);
  const huddles = useBoardHuddles(slug);
  // The Team tab's Start huddle: the drawer's ticket (or a new one) opens on its Huddle tab with this roster filled in.
  const [huddleSeed, setHuddleSeed] = useState<{ id: string; seed: HuddleSeed; n: number } | null>(null);

  // An open chat's Huddle tab requests, like the drawer's (a huddle badge, the dock's Huddles list, Team's Start huddle).
  const sessionHuddle = {
    tabRequest: huddleTab && huddleTab.id === openId ? { tab: "huddle" as const, n: huddleTab.n, huddleId: huddleTab.huddleId } : null,
    huddleSeed: huddleSeed && huddleSeed.id === openId ? { seed: huddleSeed.seed, n: huddleSeed.n } : null,
    onOpenTeam: (r: TeamRequest) => { closeTicket(); openDockOn("team", r); },
  };

  const closeTicket = useCallback(() => {
    if (pushedOpen.current && pushedFrom.current === slug) history.back();
    else {
      pushedOpen.current = false;
      history.replaceState(null, "", hashFor(slug));
      setOpenId(null);
    }
  }, [slug]);

  // After the daemon restarts or the laptop wakes, events were missed: reload everything.
  // A pending daemon restart holds new runs on every board: show it so queued cards don't look stuck.
  const [restart, setRestart] = useState({ pending: false, waiting: 0 });
  useEffect(() => { api.restartState().then(setRestart).catch(() => {}); }, []);

  useEffect(() => onReconnect(() => {
    api.restartState().then(setRestart).catch(() => {});
    loadProfiles().catch(() => {});
    loadInbox();
    api.mcp().then(setMcp).catch(() => {});
    if (slug) {
      api.tickets(slug).then(setTickets).catch(() => {});
      loadSchedules(slug);
    }
  }), [slug, loadProfiles, loadInbox, loadSchedules]);

  const needYou = inbox.length;
  // A snooze ends by itself: reload when the first one runs out (the server only counts it again then).
  useEffect(() => {
    if (!snoozed.length) return;
    const first = Math.min(...snoozed.map((i) => Date.parse(i.snoozedUntil!)));
    const timer = setTimeout(() => {
      loadInbox();
      if (slugRef.current) api.tickets(slugRef.current).then(setTickets).catch(() => {});
    }, Math.min(Math.max(first - Date.now(), 0) + 1000, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [snoozed, loadInbox]);
  useEffect(() => {
    document.title = needYou ? `(${needYou}) Muba AI` : "Muba AI";
  }, [needYou]);

  useEffect(() => {
    try {
      localStorage.setItem(DOCK_OPEN, dockOpen ? "1" : "0");
    } catch {}
  }, [dockOpen]);
  // A tab request is one-shot: reopening the dock later keeps the user's last tab.
  useEffect(() => {
    if (!dockOpen) setDockTab(null);
  }, [dockOpen]);

  // Board switching (B picker, [ ] prev/next, 1…9) leaves the open ticket: it belongs to the old board.
  const switchBoard = useCallback((to: string) => {
    if (to === slugRef.current) return;
    pushedOpen.current = false;
    setOpenId(null);
    setSlug(to);
  }, []);
  // Latest values for the window key handler below, which is bound once per dialog state.
  const live = useRef({ profiles, tickets, markDone: (_id: string) => {} });

  // Shortcuts: N new ticket, / search, ? cheatsheet, C quick Claude chat, T Team, ⌘K command bar (tickets on every board, actions, boards), Ctrl+` terminal & files,
  // B board picker, [ ] previous / next board, 1…9 board N, J/K/H/L or arrows select a card, D marks a Review card done.
  // Esc is handled by the panel and dialogs (one layer at a time, see layers.ts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "`") {
        e.preventDefault();
        setDockOpen((o) => !o);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        if ((e.target as HTMLElement | null)?.closest?.(".xterm")) return;
        e.preventDefault();
        // Works without a board too; a second ⌘K closes the bar.
        const layer = anyLayerOpen();
        setCommandBar((o) => (o ? false : !layer));
        return;
      }
      const boards = live.current.profiles ?? [];
      const at = boards.findIndex((p) => p.slug === slug);
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
      if (openId || profileDialog || newTicket || connections || schedulesOpen || anyLayerOpen() || document.querySelector(".overlay")) return;
      // Plain 1…9 (Alt+digit is taken by Chrome's tab switching); the ticket panel's questions form uses digits too.
      const digit = e.shiftKey || e.isComposing ? null : boardDigit(e.code);
      if (digit !== null) {
        if (!boards[digit]) return;
        e.preventDefault();
        switchBoard(boards[digit].slug);
        return;
      }
      const dir = e.shiftKey && e.key.startsWith("Arrow") ? null : cardDir(e.key);
      if (dir) {
        // A picked-up card (Space) moves with the arrows instead: leave those to the drag.
        if (!slug || e.defaultPrevented || document.querySelector(".sortable-card[aria-pressed='true']")) return;
        // Arrows on a focused button or menu trigger belong to it; J/K/H/L work from anywhere.
        const focus = document.activeElement;
        if (e.key.startsWith("Arrow") && focus && focus !== document.body && !focus.closest(".sortable-card")) return;
        const grid = cardGrid();
        const next = stepCard(grid.map((c) => c.length), focusedCard(grid), dir);
        if (!next) return;
        e.preventDefault();
        focusCard(next, grid);
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (slug) setNewTicket(true);
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "?") {
        e.preventDefault();
        setShortcuts(true);
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        if (slug) openDockOn("claude");
      } else if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        if (slug) toggleTeam();
      } else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        if (boards.length) setBoardSwitcher(true);
      } else if (e.key === "[" || e.key === "]") {
        const to = boards[stepBoard(boards.length, at, e.key === "]" ? 1 : -1)];
        if (!to) return;
        e.preventDefault();
        switchBoard(to.slug);
      } else if (e.key === "d" || e.key === "D") {
        const id = (document.activeElement as HTMLElement | null)?.closest?.(".sortable-card")?.getAttribute("data-ticket");
        if (!id) return;
        e.preventDefault();
        live.current.markDone(id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, profileDialog, newTicket, connections, schedulesOpen, slug, switchBoard, dockOpen, dockShown]);

  const runInTerminal = useCallback((text: string) => {
    setDockOpen(true);
    setDockCommand({ text, n: Date.now() });
  }, []);

  const dismiss = (key: string) => setDismissed((d) => {
    const next = new Set(d).add(key);
    try {
      sessionStorage.setItem(DISMISSED, JSON.stringify([...next]));
    } catch {}
    return next;
  });

  useEffect(() => {
    if (!slug) return;
    try {
      localStorage.setItem(LAST_PROFILE, slug);
    } catch {}
    setTickets([]);
    setSchedules(null);
    api.tickets(slug).then(setTickets).catch((e) => setError(e.message));
    loadSchedules(slug);
  }, [slug, loadSchedules]);

  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === "mcp.updated") {
          setMcp(e.state);
          return;
        }
        if (e.type === "restart.updated") {
          setRestart({ pending: e.pending, waiting: e.waiting });
          return;
        }
        if (e.type === "tunnel.updated") {
          setTunnel(e.tunnel);
          return;
        }
        if (e.type === "profile.updated") {
          loadProfiles().catch(() => {});
          refreshInboxSoon();
          return;
        }
        if (e.type === "ticket.updated") {
          // A short buzz when a ticket starts waiting on you (finished, has questions, failed); the first sighting of a ticket never buzzes.
          const now = e.ticket.attention?.kind ?? null;
          const before = attentionSeen.current.get(e.ticket.id);
          attentionSeen.current.set(e.ticket.id, now);
          if (before !== undefined && now && now !== before && !e.ticket.running) buzz([30, 60, 30]);
        }
        if (e.type === "ticket.updated" || e.type === "ticket.deleted" || e.type === "session.updated" || e.type === "huddle.updated") refreshInboxSoon();
        if (e.type === "schedule.updated" && e.profile === slug) refreshSchedulesSoon(slug);
        if (e.type === "ticket.updated" && e.profile === slug && e.ticket.scheduleId) refreshSchedulesSoon(slug);
        if (e.type === "ticket.updated" && e.profile === slug) {
          setTickets((ts) => {
            const i = ts.findIndex((t) => t.id === e.ticket.id);
            const merged = { ...ts[i], ...e.ticket };
            if (i < 0) return [...ts, merged];
            const next = ts.slice();
            next[i] = merged;
            return next;
          });
        }
        if (e.type === "session.updated" && e.profile === slug) {
          setTickets((ts) => ts.map((t) => (t.id === e.id ? { ...t, session: e.session } : t)));
        }
        if (e.type === "ticket.deleted" && e.profile === slug) {
          setTickets((ts) => ts.filter((t) => t.id !== e.id));
        }
      }),
    [slug, loadProfiles, refreshInboxSoon, refreshSchedulesSoon],
  );

  const profile = useMemo(() => profiles?.find((p) => p.slug === slug) ?? null, [profiles, slug]);
  const open = tickets.find((t) => t.id === openId) ?? null;

  /** Start huddle from the Team tab: on the ticket open in the drawer, else on a new ticket in Planning. No picker. */
  const startHuddle = async (seed: HuddleSeed) => {
    if (!profile) return;
    let id = open?.id;
    if (!id) {
      try {
        const what = "preset" in seed ? `@${seed.preset}` : `the ${seed.template} template`;
        const t = await api.createTicket(profile.slug, {
          title: "preset" in seed ? `Huddle with @${seed.preset}` : `Huddle: ${seed.template}`,
          body: `Started from the Team tab: a huddle with ${what}. Say what it should work on.`, status: "planning",
        });
        setTickets((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]));
        id = t.id;
      } catch (e) {
        toast(`Couldn't create the ticket: ${(e as Error).message}`, { tone: "error" });
        return;
      }
    }
    setHuddleSeed({ id, seed, n: Date.now() });
    openHuddle(id);
  };
  // The drawer has taken the Huddle tab request (as its first tab, or switched to it): forget it.
  useEffect(() => {
    if (huddleTab && open?.id === huddleTab.id) setHuddleTab(null);
  }, [huddleTab, open?.id]);
  const q = query.trim().toLowerCase();
  const activeFilters = FILTERS.filter((f) => filters.has(f.id));
  // Sessions live on their own page; the board, its filters and counts only see board tickets.
  const boardTickets = tickets.filter((t) => !t.standalone);
  // The Sessions lane follows the search; ticket filters (priority, PR…) don't apply to chats.
  const sessions = tickets.filter((t) => t.standalone);
  const unreadChats = sessions.filter((t) => !t.running && t.attention).length;
  // Wide screens show an open chat inside Chats (two panes) instead of as a sliding panel.
  const wideChats = mode === "chats" && !narrow;
  // Leaving Chats closes the open chat; otherwise Board would show it again as a side panel.
  const switchMode = (next: "board" | "chats") => {
    if (next === "board" && open?.standalone) closeTicket();
    setMode(next);
  };
  // Centered in the top bar on phones (like iOS Messages), next to the repo picker on desktop.
  const modeSwitch = (
    <div className="segmented mode-switch" role="radiogroup" aria-label="View">
      <button type="button" role="radio" aria-checked={mode === "board"} onClick={() => switchMode("board")} title="Tickets in lanes">
        <ColumnsIcon size={16} />Board
      </button>
      <button type="button" role="radio" aria-checked={mode === "chats"} onClick={() => switchMode("chats")} title="Chats with Claude and Codex">
        <ChatIcon size={16} />Chats
        {unreadChats > 0 && <span className="mode-dot" aria-label={`${unreadChats} new`} />}
      </button>
    </div>
  );
  const shownTickets = boardTickets.filter((t) =>
    metadataMatches(t, metadataFilter) && (!q || `${t.title}\n${t.body}`.toLowerCase().includes(q)) && (!activeFilters.length || activeFilters.some((f) => f.test(t))));
  const filtering = !!q || activeFilters.length > 0 || Object.values(metadataFilter).some(Boolean);
  // Prev/next walk the visible tickets of the column the drawer opened in, in its order at that time, so
  // moving the open ticket (e.g. Planning to Done) keeps Next in Planning, and the ends of the column stop
  // there. Stepping keeps that order; deleted tickets are skipped.
  const liveOrder = open ? { column: boardColumnOf(open), ids: columnOrder(shownTickets, boardColumnOf(open)) } : null;
  const orderMissing = !!openId && !navOrder?.ids.includes(openId);
  useEffect(() => {
    if (!openId) setNavOrder(null);
    else if (!stepped.current || orderMissing) setNavOrder(liveOrder);
  }, [openId, orderMissing, tickets.length > 0]);
  // navOrder is null until the effect above runs (and whenever no ticket is open): fall back to the live order.
  const navIn = orderMissing ? liveOrder : navOrder ?? liveOrder;
  const { prev: prevId, next: nextId } = open && navIn ? columnNeighbours(navIn.ids, navIn.column, open.id, tickets) : { prev: null, next: null };
  const perBoard = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of inbox) m.set(i.profile, (m.get(i.profile) ?? 0) + 1);
    return m;
  }, [inbox]);

  // Without an order the server puts the ticket where a column entry goes (e.g. top of Done).
  const move = async (id: string, status: Status, order?: number, undo = true) => {
    const board = slug!;
    const before = tickets.find((t) => t.id === id);
    setTickets((ts) => ts.map((t) => (t.id === id ? { ...t, status, ...(order === undefined ? {} : { order }) } : t)));
    try {
      await api.updateTicket(board, id, order === undefined ? { status } : { status, order });
      if (undo && before && before.status !== status) {
        const label = COLUMNS.find((c) => c.id === status)?.label ?? status;
        toast(<>Moved <b>{before.title}</b> to {label}</>, {
          action: { label: "Undo", run: () => { if (slugRef.current === board) move(id, before.status, before.order, false); } },
        });
      }
    } catch (e: any) {
      setError(`Couldn't move the ticket: ${e.message}`);
      api.tickets(board).then(setTickets).catch(() => {});
    }
  };

  // D on a focused Review card; focus stays at the same spot on the board for the next key.
  const markDone = (id: string) => {
    if (tickets.find((t) => t.id === id)?.status !== "review") return;
    const pos = focusedCard(cardGrid());
    void move(id, "done");
    setTimeout(() => focusCard(pos));
  };
  live.current = { profiles, tickets, markDone };

  const mcpAttention = mcp?.servers.filter((s) => s.attention).length ?? 0;
  const scheduleErrors = schedules?.filter((s) => s.lastError).length ?? 0;
  const missing = health ? (["claude", "git", "gh"] as const).filter((k) => !health[k]) : [];
  // Every active ticket run (chat replies and Planning too); slots: the ones holding a maxParallel slot, as the server counts them.
  const running = runCounts(tickets, huddles);
  const queued = tickets.filter((t) => t.status === "ready" || waitsForSlot(t)).length;

  const updateKey = `update:${version?.latest}`;
  const pathKey = `path:${missing.join(",")}`;
  const folderKey = `folder:${profile?.slug}`;
  const toggleFilter = (id: FilterId) => setFilters((f) => {
    const next = new Set(f);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  // Inbox triage on any board: the entry leaves the list (and the counts) at once, the server confirms.
  const inboxDone = async (i: InboxItem) => {
    setInbox((l) => l.filter((x) => x !== i));
    setSnoozed((l) => l.filter((x) => x !== i));
    if (i.profile === slug) return move(i.id, "done").finally(loadInbox);
    try {
      await api.updateTicket(i.profile, i.id, { status: "done" });
      toast(<>Moved <b>{i.title}</b> to Done</>);
    } catch (e: any) {
      setError(`Couldn't move the ticket: ${e.message}`);
      loadInbox();
    }
  };
  const inboxSnooze = async (i: InboxItem, on: boolean) => {
    const until = new Date(Date.now() + 24 * 3600_000).toISOString();
    if (on) {
      setInbox((l) => l.filter((x) => x !== i));
      setSnoozed((l) => [...l, { ...i, snoozedUntil: until }]);
    } else {
      setSnoozed((l) => l.filter((x) => x !== i));
      setInbox((l) => [...l, { ...i, snoozedUntil: undefined }]);
    }
    if (i.profile === slug) setTickets((ts) => ts.map((t) => (t.id === i.id ? { ...t, attention: on ? null : i.attention, snoozed: on ? { attention: i.attention, until } : null } : t)));
    try {
      const t = await (on ? api.snooze(i.profile, i.id) : api.unsnooze(i.profile, i.id));
      const merge = (t: Ticket) => { if (i.profile === slugRef.current) setTickets((ts) => ts.map((x) => (x.id === t.id ? { ...x, ...t } : x))); };
      if (on) toast(<>Snoozed <b>{i.title}</b> for a day</>, { action: { label: "Undo", run: () => void api.unsnooze(i.profile, i.id).then((t) => { merge(t); loadInbox(); }, () => {}) } });
      merge(t);
    } catch (e: any) {
      setError(`Couldn't ${on ? "snooze" : "unsnooze"} the ticket: ${e.message}`);
      if (i.profile === slugRef.current) api.tickets(i.profile).then(setTickets).catch(() => {});
    }
    loadInbox();
  };

  const openFrom = (board: string, id: string) => {
    if (board !== slug) setSlug(board);
    openTicket(id, board);
  };

  // ⌘K actions run the same handlers as their buttons and menu items.
  const commandActions: CommandAction[] = [
    ...(profile ? [
      { id: "new", label: "New ticket", keys: ["N"], run: () => setNewTicket(true) },
      { id: "dock", label: "Open terminal & files", keys: ["Ctrl", "`"], icon: <TerminalIcon size={14} />, run: () => openDockOn("terminal") },
      { id: "chat", label: "Quick Claude chat", keys: ["C"], icon: <ChatIcon size={14} />, run: () => openDockOn("claude") },
    ] : []),
    ...(profile ? [
      { id: "team", label: "Open Team", keys: ["T"], icon: <TeamIcon size={14} />, hint: "teammates, templates, notes", run: () => openDockOn("team") },
      { id: "new-teammate", label: "New teammate…", run: () => openDockOn("team", { action: "new" }) },
    ] : []),
    ...(inbox.length ? [{ id: "inbox", label: `Open inbox (${inbox.length} need you)`, run: () => setInboxRequest(Date.now()) }] : []),
    ...(profile ? [{ id: "schedules", label: "Schedules", icon: <ClockIcon size={14} />, run: () => setSchedulesOpen(true) }] : []),
    { id: "connections", label: "Connections", icon: <PlugIcon size={14} />, run: () => setConnections(true) },
    ...(profile ? [{ id: "snippets", label: "Snippets", icon: <AtIcon size={14} />, run: () => setSnippetsOpen(true) }] : []),
    { id: "usage", label: "Usage", run: () => setUsageRequest(Date.now()) },
    ...(profile ? [{ id: "settings", label: "Board settings", icon: <GearIcon size={14} />, run: () => setProfileDialog("edit") }] : []),
    { id: "new-board", label: "New board", run: () => setProfileDialog("new") },
    { id: "notifications", label: "Notifications", icon: <BellIcon size={14} />, hint: "push to this device", run: () => setNotificationsOpen(true) },
    { id: "alerts", label: "Mac & webhook alerts", icon: <BellIcon size={14} />, hint: "macOS banner, ntfy / webhook", run: () => setAlertsOpen(true) },
    { id: "shortcuts", label: "Keyboard shortcuts", keys: ["?"], icon: <KeyboardIcon size={14} />, run: () => setShortcuts(true) },
    { id: "bug", label: "Report a bug", icon: <BugIcon size={14} />, run: () => setBugReport(true) },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="brand-icon" src="/icons/esa-192.png?v=7" width="28" height="28" alt="" />
          <span className="brand-name">Muba AI</span>
        </div>
        {profiles && profiles.length > 0 && (
          <Select
            className="profile-select"
            ariaLabel="Board"
            value={slug ?? ""}
            onChange={switchRepo}
            menuClassName="profile-menu"
            menuMaxHeight={440}
            options={profiles.map((p) => ({ value: p.slug, label: p.name, hint: tildePath(p.path) }))}
            renderOption={(o, selected) => (
              <>
                <span className="profile-avatar" style={{ background: avatarColor(o.value) }} aria-hidden>{avatarLetter(String(o.label))}</span>
                <span className="profile-body">
                  <span className="profile-row">
                    <span className="profile-name">{o.label}</span>
                    {!!perBoard.get(o.value) && <span className="need-chip">{perBoard.get(o.value)} need you</span>}
                  </span>
                  <span className="profile-path" title={profiles.find((p) => p.slug === o.value)?.path}>{o.hint}</span>
                </span>
                <span className="profile-check" aria-hidden>{selected && <CheckIcon size={13} />}</span>
              </>
            )}
            renderValue={() => profile?.name}
            badge={<KeyHint keys="B  [ ]" />}
            footer={[
              ...(profile ? [{
                label: "Copy folder path",
                icon: <CopyIcon size={12} />,
                onSelect: () => { copy(profile.path).then(() => toast(<>Copied <code>{tildePath(profile.path)}</code></>, { tone: "ok" })); },
              }] : []),
              { label: "New board…", onSelect: () => setProfileDialog("new") },
            ]}
          />
        )}
        {profile && (
          <span className="pill" title={`${running.runs} ticket ${running.runs === 1 ? "run" : "runs"} active, ${running.slots} of ${profile.maxParallel} slots in use. Slots apply to ticket runs: at most ${profile.maxParallel} work at the same time on this board. Planning chats and replies to other tickets don't take a slot.${running.agents ? ` Huddle agents (${running.agents} working) run outside the slots.` : ""}`}>
            {running.runs}/{profile.maxParallel} running{running.agents > 0 && <> · {running.agents} huddle {running.agents === 1 ? "agent" : "agents"}</>}{queued > 0 && <> · {queued} queued</>}
          </span>
        )}
        <UsagePill compact={narrow} openRequest={usageRequest} />
        {restart.pending && (
          <span className="pill warn" title="The daemon restarts once every active run (on any board) has finished. Until then nothing new starts: queued tickets, chat replies and Planning interviews wait.">
            Restart pending{restart.waiting > 0 ? ` · waiting for ${restart.waiting} ${restart.waiting === 1 ? "run" : "runs"}` : ""}
          </span>
        )}
        {profile && compact && (
          // Phones: the repo's avatar opens the repo picker (its name sits on the second row).
          <button type="button" className="repo-avatar" aria-label={`Switch repo, now ${profile.name}`} style={{ backgroundColor: avatarColor(profile.slug) }}
            onClick={() => document.querySelector<HTMLButtonElement>(".topbar .profile-select .select-trigger")?.click()}>
            {avatarLetter(profile.name)}
          </button>
        )}
        {profile && !compact && modeSwitch}
        {profile && compact && mode === "board" && (
          <button type="button" className={`icon-btn search-toggle${searchOpen || query ? " on" : ""}`} aria-label="Search and filter" aria-pressed={searchOpen}
            onClick={() => { setSearchOpen((o) => !o); if (!searchOpen) setTimeout(() => searchRef.current?.focus(), 50); }}>
            <SearchIcon size={20} />
            {(query || activeFilters.length > 0) && <span className="search-dot" aria-hidden />}
          </button>
        )}
        <div className="spacer" />
        <Inbox items={inbox} snoozed={snoozed} landOnInbox={narrow && !startedOnTicket.current} openRequest={inboxRequest} onPick={(i) => openFrom(i.profile, i.id)}
          onMarkDone={(i) => void inboxDone(i)} onSnooze={(i, on) => void inboxSnooze(i, on)} />
        {profile && !compact && (
          <button className={`btn ghost icon-label${dockOpen && !chatOpen ? " on" : ""}`}
            onClick={() => (chatOpen ? openDockOn("terminal") : setDockOpen((o) => !o))}
            aria-pressed={dockOpen && !chatOpen} title="Terminal and files for this folder (Ctrl+`)" aria-label="Terminal and files">
            <TerminalIcon /><span className="label">Terminal & files</span>
          </button>
        )}
        {profile && !compact && (
          <button className={`btn ghost icon-label${chatOpen ? " on" : ""}`}
            onClick={() => (chatOpen ? setDockOpen(false) : openDockOn("claude"))}
            aria-pressed={chatOpen} title="Quick chat with Claude in this folder, no ticket needed (C)" aria-label="Quick Claude chat">
            <ChatIcon /><span className="label">Claude</span><KeyHint keys="C" />
          </button>
        )}
        {profile && !compact && (
          <button className="btn ghost icon-label" onClick={() => setSchedulesOpen(true)} aria-label="Schedules"
            title={scheduleErrors ? `${scheduleErrors} schedule${scheduleErrors === 1 ? "" : "s"} could not start their last run` : "Recurring tickets on a cron schedule"}>
            <ClockIcon /><span className="label">Schedules</span>
            {schedules && schedules.length > 0 && !scheduleErrors && <span className="muted small">{schedules.filter((s) => s.enabled).length}</span>}
            {scheduleErrors > 0 && <span className="need-chip">{scheduleErrors}</span>}
          </button>
        )}
        {!compact && <button className="btn ghost icon-label" onClick={() => setConnections(true)} aria-label="Connections"
          title={mcpAttention ? `${mcpAttention} MCP server${mcpAttention === 1 ? "" : "s"} failed or need you to log in again` : "Claude Code MCP servers"}>
          <PlugIcon /><span className="label">Connections</span>
          {mcpAttention > 0 && <span className="need-chip">{mcpAttention}</span>}
        </button>}
        {profile && !compact && (
          <button className={`btn ghost icon-label${teamOpen ? " on" : ""}`} onClick={toggleTeam}
            aria-pressed={teamOpen} title="Teammates, templates and notes (T)" aria-label="Team">
            <TeamIcon /><span className="label">Team</span>
          </button>
        )}
        {profile && !compact && (
          <button className="btn primary new-ticket-btn" onClick={() => (mode === "chats" ? (wideChats ? closeTicket() : setNewSession(true)) : setNewTicket(true))}
            title={mode === "chats" ? "New chat" : "New ticket (N)"} aria-label={mode === "chats" ? "New chat" : "New ticket"}>
            <PlusIcon size={21} className="icon new-ticket-symbol" /><span className="new-ticket-label">{mode === "chats" ? "New chat" : "New ticket"}</span>
          </button>
        )}
        <HeaderMenu alert={tunnel?.state === "offline" || (compact && (scheduleErrors > 0 || mcpAttention > 0))} items={withSections({
          "Needs you": [
            ...(compact && scheduleErrors ? [{ label: `${scheduleErrors} schedule${scheduleErrors === 1 ? "" : "s"} could not start`, icon: <RefreshIcon />, onSelect: () => setSchedulesOpen(true) }] : []),
            ...(compact && mcpAttention ? [{ label: connectionsReason(mcp!.servers), icon: <PlugIcon />, onSelect: () => setConnections(true) }] : []),
            ...(pwa.waiting ? [{ label: "Reload app update", icon: <CheckIcon />, onSelect: pwa.update }] : []),
            ...(tunnel?.state === "offline" ? [{ label: phoneAccessLabel(tunnel), icon: <DeviceIcon />, onSelect: () => setAwayOpen(true) }] : []),
          ],
          Tools: [
            ...(compact && profile ? [
              { label: "Terminal & files", icon: <TerminalIcon />, onSelect: () => openDockOn("terminal") },
              { label: "Quick Claude chat", icon: <ChatIcon />, onSelect: () => openDockOn("claude") },
              { label: "Team", icon: <TeamIcon />, onSelect: () => openDockOn("team") },
              ...(!scheduleErrors ? [{ label: "Schedules", icon: <RefreshIcon />, onSelect: () => setSchedulesOpen(true) }] : []),
            ] : []),
            ...(compact && !mcpAttention ? [{ label: "Connections", icon: <PlugIcon />, onSelect: () => setConnections(true) }] : []),
            ...(profile ? [
              { label: "Search tickets & chats", icon: <SearchIcon />, onSelect: () => setFullSearch(true) },
              { label: "Snippets", icon: <AtIcon />, onSelect: () => setSnippetsOpen(true), title: "Reusable prompt text: type @name in a ticket to insert it" },
              { label: "Activity", icon: <HistoryIcon />, onSelect: () => setActivityOpen(true) },
            ] : []),
          ],
          Usage: [
            ...(narrow ? [{ label: "Usage & limits", icon: <ClockIcon />, onSelect: () => setUsageRequest((n) => n + 1) }] : []),
            { label: "Daily usage", icon: <DollarIcon />, onSelect: () => setDailyCostOpen(true) },
          ],
          Settings: [
            ...(profile ? [{ label: "Board settings", icon: <GearIcon />, onSelect: () => setProfileDialog("edit") }] : []),
            { label: "Default models", icon: <SlidersIcon />, onSelect: () => setDefaultModelsOpen(true) },
            { label: "Quick replies", icon: <ChatIcon />, onSelect: () => setQuickRepliesOpen(true), title: "The one-tap answers a chat offers when the agent asks you something" },
            {
              label: "Appearance", icon: <ContrastIcon />, keepOpen: true, title: "Tap to switch: System, Light, Dark",
              badge: <span className="menu-setting">{THEME_LABEL[theme]}</span>,
              onSelect: () => {
                const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
                setThemeChoice(next);
                setTheme(next);
              },
            },
            ...(cleanup !== null ? [{
              label: "Clean up when done", icon: <TrashIcon />, keepOpen: true,
              title: "When a ticket is done, its screenshots, recordings and traces go to the Trash. Once a day, old leftovers and merged folder copies go too.",
              badge: <span className="menu-setting">{cleanup ? "On" : "Off"}</span>,
              onSelect: () => api.updateSettings({ cleanup: !cleanup }).then((s) => setCleanup(!!s.cleanup), () => {}),
            }] : []),
            ...(tunnel?.state !== "offline" ? [{
              label: tunnel?.state === "online" ? phoneAccessLabel(tunnel) : "Mac sleep & phone access", icon: <DeviceIcon />,
              onSelect: () => setAwayOpen(true), title: "Keep the Mac awake and check the link your phone uses",
            }] : []),
            { label: "Notifications", icon: <BellIcon />, onSelect: () => setNotificationsOpen(true) },
            { label: "Mac & webhook alerts", icon: <BellIcon />, onSelect: () => setAlertsOpen(true), title: "macOS banner and ntfy / webhook when a ticket needs you" },
          ],
          Help: [
            ...(!phoneWidth ? [{ label: "Keyboard shortcuts", hint: "?", icon: <KeyboardIcon />, onSelect: () => setShortcuts(true) }] : []),
            { label: "Report a bug", icon: <BugIcon />, onSelect: () => setBugReport(true) },
            ...(!pwa.installed ? [{ label: "Install Muba AI", icon: <CopyIcon />, onSelect: pwa.install }] : []),
          ],
        })} footer={narrow && profile ? `${running}/${profile.maxParallel} running` : version && version.version !== "dev" ? `Muba AI v${version.version}` : null} />
      </header>


      {!pwa.online && <div className="banner warn" role="status"><span>You’re offline. Changes and messages need a connection to your Mac.</span></div>}
      {pwa.waiting && !pwa.dismissed && pwa.online && <div className="banner info pwa-update" role="status">
        <span>An app update is ready. Reload when you’re ready.</span>
        <button className="btn small" onClick={pwa.update}>Reload</button>
        <button className="icon-btn" aria-label="Dismiss app update" onClick={pwa.dismissUpdate}><CloseIcon size={12} /></button>
      </div>}

      {narrow && restart.pending && (
        <div className="banner warn" role="status">
          Restart pending. New runs wait until active runs finish{restart.waiting > 0 ? ` (${restart.waiting} still active)` : ""}.
        </div>
      )}

      {version?.updateAvailable && !dismissed.has(updateKey) && (
        <div className="banner info" role="status">
          <span>Muba AI v{version.latest} is available (you have v{version.version}). Run <code>ckanban update</code> in a terminal.</span>
          <button className="icon-btn" aria-label="Dismiss" title="Hide until next time" onClick={() => dismiss(updateKey)}><CloseIcon size={12} /></button>
        </div>
      )}
      {missing.length > 0 && !dismissed.has(pathKey) && (
        <div className={`banner ${missing.includes("claude") ? "warn" : "info"}`} role="status">
          <span>
            {missing.includes("claude") && <><b>claude</b> not found on PATH: tickets cannot run. </>}
            {missing.includes("git") && <><b>git</b> not found: tickets still run, directly in the board folder without per-ticket worktrees. </>}
            {missing.includes("gh") && (
              <>
                <b>gh</b> (GitHub CLI) is optional: tickets run without it; it is only needed to open and track pull requests.
                {" "}To add it: <code>brew install gh</code>, then <code>gh auth login</code> (<a href="https://cli.github.com" target="_blank" rel="noreferrer">cli.github.com</a>).
              </>
            )}
          </span>
          <button className="icon-btn" aria-label="Dismiss" title="Hide until next time" onClick={() => dismiss(pathKey)}><CloseIcon size={12} /></button>
        </div>
      )}
      {profile && profile.pathExists === false && !dismissed.has(folderKey) && (
        <div className="banner warn" role="status">
          <span>Board folder <code>{profile.path}</code> does not exist. Tickets will not be picked up.</span>
          <button className="icon-btn" aria-label="Dismiss" title="Hide until next time" onClick={() => dismiss(folderKey)}><CloseIcon size={12} /></button>
        </div>
      )}

      {profiles === null ? (
        <div className="empty"><span className="spinner" /> Loading boards…</div>
      ) : !profile ? (
        <div className="empty">
          <h2>No boards yet</h2>
          <p>A board runs tickets in one folder, usually a git repo.</p>
          <button className="btn primary" onClick={() => setProfileDialog("new")}>
            Create board
          </button>
        </div>
      ) : mode === "chats" ? (
        <ChatsView profile={profile} sessions={sessions} tickets={tickets} openId={openId} wide={wideChats} sessionHuddle={sessionHuddle}
          onOpen={(id) => openTicket(id)} onClose={closeTicket} onOpenTicket={(id) => openTicket(id)} />
      ) : (
        <>
          <div className={`board-bar${compact && !searchOpen && !query && activeFilters.length === 0 ? " is-collapsed" : ""}`}>
            <div className="search">
              <SearchIcon className="icon search-icon" />
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={compact ? "Search" : "Search tickets"}
                aria-label="Search tickets on this board" aria-keyshortcuts="/"
                onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); if (query) setQuery(""); else e.currentTarget.blur(); } }} />
              {query ? (
                <button className="search-clear" aria-label="Clear search" title="Clear (Esc)"
                  onMouseDown={(e) => e.preventDefault()} onClick={() => { setQuery(""); searchRef.current?.focus(); }}>
                  <CloseIcon size={12} />
                </button>
              ) : <kbd className="search-kbd" aria-hidden>/</kbd>}
              <KeyHint keys="/" />
            </div>
            <div className="filter-chips" role="group" aria-label="Filter tickets">
              {FILTERS.map((f) => {
                const n = boardTickets.filter(f.test).length;
                return (
                  <button key={f.id} className={`chip${filters.has(f.id) ? " on" : ""}`} aria-pressed={filters.has(f.id)} onClick={() => toggleFilter(f.id)}>
                    {f.label}{n > 0 && <span className="chip-count">{n}</span>}
                  </button>
                );
              })}
            </div>
          <WorkspaceControls key={profile.slug} slug={profile.slug} tickets={boardTickets} filter={metadataFilter} onFilter={setMetadataFilter} layout={layout} onLayout={setLayout} query={query} onQuery={setQuery} flags={[...filters]} onFlags={(values) => setFilters(new Set(values.filter((f): f is FilterId => FILTERS.some((x) => x.id === f))))}
            flagOptions={FILTERS.map((f) => ({ id: f.id, label: f.label, count: boardTickets.filter(f.test).length }))} />
            {filtering && (
              <span className="muted small" aria-live="polite">
                {shownTickets.length} of {boardTickets.length} ticket{boardTickets.length === 1 ? "" : "s"}
                {" · "}<button className="link-btn small" onClick={() => { setQuery(""); setFilters(new Set()); setMetadataFilter(EMPTY_FILTER); }}>Clear all</button>
              </span>
            )}
          </div>
          {sampleFor === profile.slug && (
            <SampleOffer slug={profile.slug} onDismiss={() => setSampleFor(null)}
              onStarted={(t) => {
                setSampleFor(null);
                setTickets((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]));
                openTicket(t.id);
              }} />
          )}
          {layout === "list" ? <TicketList tickets={shownTickets} onOpen={openTicket} /> : <Board key={profile.slug} tickets={shownTickets} filtered={filtering} huddles={huddles} onOpenHuddle={openHuddle} slug={slug ?? undefined} onOpen={(id) => openTicket(id)} onMove={move} onAdd={() => setNewTicket(true)} restartPending={restart.pending} />}
        </>
      )}
      {awayOpen && <AwayDialog tunnel={tunnel} onClose={() => setAwayOpen(false)} />}
      {alertsOpen && <AlertsDialog profile={profile?.slug ?? null} onClose={() => setAlertsOpen(false)} />}

      {dockOpen && profile && (
        <Suspense fallback={<section className="dock dock-loading" aria-label="Opening tools panel">
          <span role="status"><span className="spinner" /> Opening tools…</span>
          <button className="btn" onClick={() => setDockOpen(false)}>Cancel</button>
        </section>}>
          <Dock key={profile.slug} profile={profile} pty={health?.pty ?? true} onClose={() => setDockOpen(false)} command={dockCommand}
            onCommandSent={() => setDockCommand(null)} tabRequest={dockTab} onTabChange={setDockShown} onOpenTicket={(id) => openTicket(id)}
            huddles={huddles} onOpenHuddle={openHuddle} openTicket={open ? { id: open.id, title: open.title } : null} onStartHuddle={startHuddle} />
        </Suspense>
      )}

      {connections && (
        <ConnectionsDialog state={mcp} onClose={() => setConnections(false)}
          onRunInTerminal={profile && health?.pty !== false ? (cmd) => { setConnections(false); runInTerminal(cmd); } : undefined} />
      )}
      {dailyCostOpen && <DailyCostDialog onClose={() => setDailyCostOpen(false)} />}
      {defaultModelsOpen && <DefaultModelsDialog onClose={() => setDefaultModelsOpen(false)} />}
      {quickRepliesOpen && <QuickRepliesDialog onClose={() => setQuickRepliesOpen(false)} />}
      {notificationsOpen && <NotificationsDialog onClose={() => setNotificationsOpen(false)} />}
      {activityOpen && profile && (
        <Modal title="Activity" wide onClose={() => setActivityOpen(false)}>
          <WorkspaceActivity key={profile.slug} slug={profile.slug} tickets={tickets} onOpen={(id) => { setActivityOpen(false); openTicket(id); }} />
        </Modal>
      )}
      {newSession && profile && <NewSessionDialog profile={profile} profiles={profiles ?? [profile]} onClose={() => setNewSession(false)}
        onStarted={(id, board) => { setNewSession(false); if (board !== slug) setSlug(board); openTicket(id, board); }} />}
      {shortcuts && <ShortcutsDialog onClose={() => setShortcuts(false)} />}
      {bugReport && <BugReportDialog onClose={() => setBugReport(false)} />}
      {fullSearch && profile && <SearchDialog slug={profile.slug} onClose={() => setFullSearch(false)} onPick={(id) => { setFullSearch(false); openTicket(id); }} />}
      {boardSwitcher && profiles && (
        <BoardSwitcher profiles={profiles} current={slug} needYou={perBoard} onClose={() => setBoardSwitcher(false)}
          onPick={(s) => { setBoardSwitcher(false); switchBoard(s); }} />
      )}
      {commandBar && (
        <CommandBar profiles={profiles ?? []} current={profile?.slug ?? null} tickets={tickets} needYou={perBoard} actions={commandActions}
          onClose={() => setCommandBar(false)} onSwitchBoard={switchBoard}
          onOpenTicket={(board, id) => {
            if (board !== slug) switchBoard(board);
            openTicket(id, board);
          }} />
      )}
      {schedulesOpen && profile && (
        <SchedulesDialog profile={profile} schedules={schedules} tickets={tickets} onClose={() => setSchedulesOpen(false)}
          onOpenTicket={(id) => { setSchedulesOpen(false); openTicket(id); }} />
      )}
      {profile && compact && (
        <nav className="tabbar" aria-label="View">
          <button type="button" aria-current={mode === "board" ? "page" : undefined} onClick={() => switchMode("board")}>
            <ColumnsIcon size={22} /><span>Board</span>
          </button>
          <button type="button" aria-current={mode === "chats" ? "page" : undefined} onClick={() => switchMode("chats")}>
            <ChatIcon size={22} /><span>Chats</span>
            {unreadChats > 0 && <span className="mode-dot" aria-label={`${unreadChats} new`} />}
          </button>
        </nav>
      )}
      {profile && compact && !open && (
        <button type="button" className="fab" aria-label={mode === "chats" ? "New chat" : "New ticket"} title={mode === "chats" ? "New chat" : "New ticket"}
          onClick={() => (mode === "chats" ? (wideChats ? closeTicket() : setNewSession(true)) : setNewTicket(true))}>
          <PlusIcon size={26} />
        </button>
      )}
      {open && profile && open.standalone && !wideChats && <SessionView key={open.id} profile={profile} ticket={open} tickets={tickets} onClose={closeTicket} onOpenTicket={openTicket} {...sessionHuddle} />}
      {snippetsOpen && profile && <SnippetsDialog profile={profile} onClose={() => setSnippetsOpen(false)} />}
      {open && profile && !open.standalone && <TicketDrawer key={open.id} profile={profile} ticket={open} tickets={tickets} onOpenTicket={openTicket} onClose={closeTicket}
        nav={{ prev: prevId, next: nextId, go: stepTicket }} slideIn={!stepped.current}
        tabRequest={huddleTab?.id === open.id ? { tab: "huddle", n: huddleTab.n, huddleId: huddleTab.huddleId } : null}
        huddleSeed={huddleSeed?.id === open.id ? { seed: huddleSeed.seed, n: huddleSeed.n } : null}
        onOpenTeam={(r) => { closeTicket(); openDockOn("team", r); }} />}
      {profileDialog && (
        <ProfileDialog
          profile={profileDialog === "edit" ? profile : null}
          onClose={() => setProfileDialog(null)}
          onOpenTeam={() => { setProfileDialog(null); openDockOn("team"); }}
          onSaved={(p) => {
            // The first board gets the sample ticket offer.
            if (profileDialog === "new" && profiles?.length === 0) setSampleFor(p.slug);
            setProfileDialog(null);
            loadProfiles().then(() => setSlug(p.slug));
          }}
          onDeleted={() => {
            if (sampleFor === profile?.slug) setSampleFor(null);
            setProfileDialog(null);
            setSlug(null);
            loadProfiles();
          }}
        />
      )}
      {newTicket && profile && (
        <NewTicketDialog
          slug={profile.slug}
          folder={profile.path}
          onClose={() => setNewTicket(false)}
          onCreate={async (input) => {
            const t = await api.createTicket(profile.slug, input);
            setTickets((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]));
            setNewTicket(false);
            // Planning starts the interview immediately: open the ticket so the questions are in view.
            if (t.status === "planning") openTicket(t.id);
          }}
        />
      )}
      <Toaster />
      {pwa.help && <InstallDialog onClose={pwa.closeHelp} />}
    </div>
  );
}
