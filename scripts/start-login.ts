import { networkInterfaces } from "node:os";
import { isPrivateIPv4 } from "../src/server/lan";

// Preserve a foreground development server until it exits. At the next login,
// launchd starts this service directly; KeepAlive handles subsequent exits.
const port = Number(process.env.CKANBAN_PORT) || 7777;
let waiting = false;
while (true) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/profiles`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error("unavailable");
    if (!waiting) { console.log("Keeping the existing Kanban session running until it exits."); waiting = true; }
    await Bun.sleep(10_000);
  } catch { break; }
}

// DHCP addresses can change after reboot. Recompute the trusted Wi-Fi address
// each start, falling back to localhost when no private interface is available.
const interfaces = networkInterfaces();
const address = [interfaces.en0, ...Object.values(interfaces)].flat().find((n) => n && !n.internal && n.family === "IPv4" && isPrivateIPv4(n.address))?.address;
process.env.CKANBAN_PORT = String(port);
if (address) {
  process.env.CKANBAN_LAN_HOST = address;
  process.env.CKANBAN_LAN_TRUSTED = "1";
} else {
  delete process.env.CKANBAN_LAN_HOST;
  delete process.env.CKANBAN_LAN_TRUSTED;
}
const { startDaemon } = await import("../src/server/main");
await startDaemon();
