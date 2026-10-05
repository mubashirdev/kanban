import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { Board } from "./board";
import { Bus } from "./events";
import { createServer } from "./http";
import { McpManager } from "./mcp";
import { startPoller } from "./prpoller";
import { Scheduler } from "./scheduler";
import { SessionCache, startSessionWatcher } from "./session";
import { ShellManager } from "./shell";
import { TerminalWatcher } from "./terminals";
import { defaultRoot, Store } from "./store";
import { VERSION } from "./version";
import { WEB_ASSETS } from "./web-assets.gen";
import { isPrivateIPv4 } from "./lan";
import { ClaudeCommands } from "./commands";

export async function startDaemon(): Promise<void> {
  const store = new Store(defaultRoot());
  const config = store.config();
  const port = Number(process.env.CKANBAN_PORT) || config.port;
  const lanHost = process.env.CKANBAN_LAN_HOST;
  const lanInterface = Object.values(networkInterfaces()).flat().find((n) => n?.family === "IPv4" && !n.internal && n.address === lanHost);
  if (lanHost && !lanInterface) {
    throw new Error("CKANBAN_LAN_HOST must be an IPv4 address of this machine's network interface");
  }
  const trusted = process.env.CKANBAN_LAN_TRUSTED === "1";
  if (trusted && (!lanHost || !isPrivateIPv4(lanHost))) throw new Error("Trusted LAN preview requires a private CKANBAN_LAN_HOST address");
  const lan = lanHost ? {
    host: lanHost, token: randomBytes(32).toString("hex"), pairingCode: randomBytes(6).toString("hex"),
    trustedNetwork: trusted && lanInterface ? { address: lanInterface.address, netmask: lanInterface.netmask } : undefined,
  } : undefined;
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude" });
  const webDir = join(import.meta.dir, "..", "..", "web", "dist");
  const embedded = Object.keys(WEB_ASSETS).length > 0;
  if (!embedded && !existsSync(join(webDir, "index.html"))) console.warn("web UI not built yet: run `bun run build:web`");
  const sessions = new SessionCache();
  const terminals = new TerminalWatcher(store, bus, sessions);
  const shells = new ShellManager();
  const mcp = new McpManager(bus, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude", seenFile: join(store.root, "mcp-seen.json") });
  const scheduler = new Scheduler(board, store, bus);
  // launchd (KeepAlive) starts the daemon again once it exits.
  const restart = () => board.requestRestart(() => void shutdown());
  const commands = new ClaudeCommands(process.env.CKANBAN_CLAUDE_BIN ?? "claude");
  const server = createServer({ store, bus, board, port, webDir, lan, sessions, terminals, shells, mcp, scheduler, commands, assets: WEB_ASSETS, restart });
  console.log(`ckanban v${VERSION} listening on http://localhost:${server.port} (data: ${store.root})`);
  if (lan?.trustedNetwork) console.log(`Wi-Fi preview: http://${lan.host}:${server.port}/`);
  else if (lan) {
    console.log(`Private LAN access: http://${lan.host}:${server.port}/?access=${lan.token}`);
    console.log(`Phone pairing: http://${lan.host}:${server.port}/ — code ${lan.pairingCode.match(/.{4}/g)!.join("-")}`);
  }
  board.recover();
  const stopPoller = startPoller(board, store, config.prPollMinutes);
  // After recover(): a missed run's ticket must not be mistaken for an interrupted one.
  const stopScheduler = scheduler.start();
  const stopWatcher = startSessionWatcher(store, bus, sessions);
  const stopTerminals = terminals.start();
  const stopMcp = mcp.start();

  const shutdown = async () => {
    console.log("ckanban shutting down");
    stopPoller();
    stopScheduler();
    stopWatcher();
    stopTerminals();
    shells.killAll();
    stopMcp();
    await board.shutdown();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
