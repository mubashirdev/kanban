import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { shellSocketUrl, type PtyKind } from "./api";
import { KeyboardIcon } from "./icons";
import { useMediaQuery } from "./useMediaQuery";

function themeFromCss(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v("--surface"),
    foreground: v("--text"),
    cursor: v("--accent"),
    cursorAccent: v("--surface"),
    selectionBackground: v("--accent-soft"),
    selectionForeground: v("--text"),
  };
}

/** The quick Claude chat is always dark (the page's dark-mode colours): Claude Code's colours assume a dark terminal. */
const DARK_THEME: ITheme = {
  background: "#1b1e22",
  foreground: "#ecebe6",
  cursor: "#e0805e",
  cursorAccent: "#1b1e22",
  selectionBackground: "#3d2a22",
  selectionForeground: "#ecebe6",
};

const themeFor = (kind: PtyKind) => (kind === "claude" ? DARK_THEME : themeFromCss());

type State = "connecting" | "open" | "exited" | "closed" | "error";
const TOUCH_KEYS = [["Esc", "\x1b"], ["Tab", "\t"], ["⇧Tab", "\x1b[Z"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["Ctrl+C", "\x03"]] as const;

/**
 * xterm.js wired to the profile's shell (or quick Claude chat) over a WebSocket.
 * Binary frames are output; JSON text frames are control.
 */
export function TerminalView({ slug, kind = "shell", active, restartSignal, command, onCommandSent }: {
  slug: string;
  kind?: PtyKind;
  active: boolean;
  restartSignal: number;
  command: { text: string; n: number } | null;
  /** Called once the command was typed into the shell, so it isn't replayed on remount. */
  onCommandSent?: () => void;
}) {
  const touch = useMediaQuery("(pointer: coarse)");
  const touchRef = useRef(touch);
  touchRef.current = touch;
  const [started, setStarted] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const [state, setState] = useState<State>("connecting");
  const [attempt, setAttempt] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Auto-reconnect with backoff (1s, 2s, 4s… up to 30s) after the socket drops.
  const retries = useRef(0);
  const [retryIn, setRetryIn] = useState<number | null>(null);
  // Command waiting for the shell to be connected (sent once, then cleared).
  const pendingCommand = useRef<{ text: string; n: number } | null>(null);
  const sentCommand = useRef<number | null>(null);
  const pendingRestart = useRef<{ resume?: boolean } | null>(null);

  const send = (msg: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  };

  // One xterm instance for the component's lifetime.
  useEffect(() => {
    const t = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "Menlo, monospace",
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: themeFor(kind),
      disableStdin: true,
      screenReaderMode: true,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    try {
      f.fit();
    } catch {}

    const onData = t.onData((data) => {
      // An ended quick chat waits for the "Start again" button instead of any key.
      if (stateRef.current === "exited") {
        if (kind === "shell") send({ type: "restart" });
      } else send({ type: "input", data });
    });
    const onResize = t.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
    let frame = 0;
    let disposed = false;
    const scheduleFit = () => {
      if (disposed) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || !host.current?.getClientRects().length) return;
        try {
          f.fit();
        } catch {}
      });
    };
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(host.current!);
    document.fonts.ready.then(scheduleFit);
    const input = t.textarea;
    if (input) input.setAttribute("aria-label", kind === "claude" ? "Claude input" : "Terminal input");
    const onFocus = () => setKeyboard(true);
    const onBlur = () => setKeyboard(false);
    input?.addEventListener("focus", onFocus);
    input?.addEventListener("blur", onBlur);
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => (t.options.theme = themeFor(kind));
    dark.addEventListener("change", onScheme);
    return () => {
      onData.dispose();
      onResize.dispose();
      ro.disconnect();
      disposed = true;
      cancelAnimationFrame(frame);
      input?.removeEventListener("focus", onFocus);
      input?.removeEventListener("blur", onBlur);
      dark.removeEventListener("change", onScheme);
      t.dispose();
    };
  }, []);

  // (Re)connect. The server replays recent output, so start from a clean screen.
  useEffect(() => {
    if (!started) return;
    const t = term.current!;
    t.reset();
    setState("connecting");
    setError(null);
    const sock = new WebSocket(shellSocketUrl(slug, t.cols, t.rows, kind));
    sock.binaryType = "arraybuffer";
    ws.current = sock;
    sock.onopen = () => {
      if (ws.current !== sock) return;
      retries.current = 0;
      setRetryIn(null);
      setState("open");
      if (pendingRestart.current) {
        sock.send(JSON.stringify({ type: "restart", ...pendingRestart.current }));
        pendingRestart.current = null;
      }
    };
    sock.onmessage = (e) => {
      if (ws.current !== sock) return;
      if (typeof e.data !== "string") {
        t.write(new Uint8Array(e.data as ArrayBuffer));
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "reset") {
        t.reset();
        setState("open");
      } else if (msg.type === "exit") {
        if (kind === "shell") t.write(`\r\n\x1b[2m[shell exited${msg.code != null ? ` with code ${msg.code}` : ""}, press any key to restart]\x1b[0m\r\n`);
        setState("exited");
      } else if (msg.type === "error") {
        setError(String(msg.message ?? "Could not start the session"));
        setState("error");
      }
    };
    sock.onclose = () => {
      if (ws.current === sock) setState((s) => (s === "exited" ? s : "closed"));
    };
    return () => {
      ws.current = null;
      sock.onopen = sock.onmessage = sock.onclose = null;
      sock.close();
    };
  }, [slug, kind, attempt, started]);

  useEffect(() => {
    if (term.current) term.current.options.disableStdin = state !== "open" && !(state === "exited" && kind === "shell");
  }, [state, kind]);

  useEffect(() => {
    if (state !== "closed") return;
    const delay = Math.min(30_000, 1000 * 2 ** retries.current);
    setRetryIn(Math.round(delay / 1000));
    const countdown = setInterval(() => setRetryIn((n) => n === null ? null : Math.max(0, n - 1)), 1000);
    const t = setTimeout(() => {
      retries.current += 1;
      setAttempt((n) => n + 1);
    }, delay);
    const reconnect = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        retries.current = 0;
        setAttempt((n) => n + 1);
      }
    };
    window.addEventListener("online", reconnect);
    document.addEventListener("visibilitychange", reconnect);
    return () => {
      clearTimeout(t);
      clearInterval(countdown);
      window.removeEventListener("online", reconnect);
      document.removeEventListener("visibilitychange", reconnect);
    };
  }, [state]);

  // Run a requested command once the shell is live. Ctrl+U clears anything half-typed first.
  useEffect(() => {
    if (command && command.n !== sentCommand.current) pendingCommand.current = command;
    const c = pendingCommand.current;
    if (!c || state !== "open") return;
    // Give the replay of recent output a moment so the command shows after the prompt.
    const t = setTimeout(() => {
      send({ type: "input", data: `\x15${c.text}\r` });
      sentCommand.current = c.n;
      pendingCommand.current = null;
      onCommandSent?.();
      if (!touchRef.current) term.current?.focus();
    }, 250);
    return () => clearTimeout(t);
  }, [command?.n, state]);

  useEffect(() => {
    if (!restartSignal) return;
    pendingRestart.current = {};
    if (ws.current?.readyState === WebSocket.OPEN) {
      pendingRestart.current = null;
      send({ type: "restart" });
    } else if (started) setAttempt((n) => n + 1);
    if (!touchRef.current) term.current?.focus();
  }, [restartSignal]);

  // Hidden panes have no size; refit and focus when the tab is shown again.
  useEffect(() => {
    if (!active) { term.current?.blur(); return; }
    const frame = requestAnimationFrame(() => {
      try {
        fit.current?.fit();
      } catch {}
      setStarted(true);
      // Touch users choose when to bring up the keyboard; tab navigation keeps its focus.
      if (!touchRef.current && !document.activeElement?.closest("[role=tablist]")) term.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  const startAgain = () => {
    if (ws.current?.readyState === WebSocket.OPEN) send({ type: "restart", resume: true });
    else { pendingRestart.current = { resume: true }; setAttempt((n) => n + 1); }
    term.current?.focus();
  };
  const reconnect = () => { retries.current = 0; setAttempt((n) => n + 1); };
  const inputEnabled = state === "open" || (state === "exited" && kind === "shell");
  const status = state === "connecting" ? "Connecting…" : state === "open" ? "Connected"
    : state === "exited" ? "Session ended" : state === "error" ? "Could not start session"
    : `Disconnected${retryIn !== null ? ` · retry in ${retryIn}s` : ""}`;

  return (
    <div className={kind === "claude" ? "terminal-view dark" : "terminal-view"}>
      <div className="terminal-screen"><div ref={host} className="terminal-host" /></div>
      {error && <div className="terminal-banner" role="alert">{error}</div>}
      {state === "exited" && kind === "claude" && (
        <div className="terminal-banner" role="status">
          Claude session ended.{" "}
          <button className="link-btn" onClick={startAgain}>Start again</button>
        </div>
      )}
      <div className="terminal-statusbar">
        <span className={`terminal-state ${state}`} role="status"><i aria-hidden />{status}</span>
        {(state === "closed" || state === "error") && <button className="link-btn" onClick={reconnect}>Reconnect now</button>}
      </div>
      {touch && <div className="terminal-touchbar" role="group" aria-label="Terminal keyboard controls">
        <button className="terminal-keyboard" disabled={!inputEnabled} aria-label={keyboard ? "Hide keyboard" : "Show keyboard"} aria-pressed={keyboard}
          onPointerDown={(e) => e.preventDefault()} onClick={() => { if (keyboard) term.current?.blur(); else term.current?.focus(); }}><KeyboardIcon size={18} /></button>
        <div className="terminal-keys">
          {TOUCH_KEYS.map(([label, data]) => <button key={label} disabled={!inputEnabled}
            aria-label={label === "↑" ? "Arrow up" : label === "↓" ? "Arrow down" : label === "⇧Tab" ? "Shift+Tab" : label === "Ctrl+C" ? "Interrupt (Ctrl+C)" : label}
            onPointerDown={(e) => e.preventDefault()} onClick={() => term.current?.input(data, true)}>{label}</button>)}
        </div>
        <button disabled={!inputEnabled} aria-label="Enter" onPointerDown={(e) => e.preventDefault()} onClick={() => term.current?.input("\r", true)}>↵</button>
      </div>}
    </div>
  );
}
