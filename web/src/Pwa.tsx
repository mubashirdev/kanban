import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
const isInstalled = () => matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
let registration: Promise<ServiceWorkerRegistration> | null = null;

export function usePwa() {
  const [installed, setInstalled] = useState(isInstalled);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [help, setHelp] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const reloading = useRef(false);

  useEffect(() => {
    const beforeInstall = (event: Event) => { event.preventDefault(); setPrompt(event as InstallPrompt); };
    const installed = () => { setInstalled(true); setPrompt(null); setHelp(false); };
    const connection = () => setOnline(navigator.onLine);
    const mode = matchMedia("(display-mode: standalone)");
    const modeChanged = () => setInstalled(isInstalled());
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", installed);
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    mode.addEventListener("change", modeChanged);
    return () => {
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", installed);
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
      mode.removeEventListener("change", modeChanged);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD || !window.isSecureContext || !("serviceWorker" in navigator)) return;
    let cancelled = false, cleanup = () => {};
    registration ??= navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch((error) => { registration = null; throw error; });
    registration.then((reg) => {
      if (cancelled) return;
      let worker: ServiceWorker | null = null;
      // Take a new version without asking when nobody is looking (app in the background) or right after
      // opening, before any work started. Drafts survive the reload, so nothing typed is lost.
      const opened = Date.now();
      const apply = () => {
        if (!reg.waiting || !navigator.onLine || reloading.current) return;
        reloading.current = true;
        reg.waiting.postMessage({ type: "ACTIVATE_UPDATE" });
      };
      const ready = () => {
        if (!reg.waiting || !navigator.serviceWorker.controller) return;
        if (document.visibilityState === "hidden" || Date.now() - opened < 10_000) return apply();
        setWaiting(reg.waiting); setDismissed(false);
      };
      const hidden = () => { if (document.visibilityState === "hidden") apply(); };
      const watch = () => {
        worker?.removeEventListener("statechange", ready);
        worker = reg.installing;
        worker?.addEventListener("statechange", ready);
        ready();
      };
      const activated = () => { setWaiting(null); if (reloading.current) location.reload(); };
      const check = () => { if (navigator.onLine && document.visibilityState === "visible") reg.update().catch(() => {}); };
      reg.addEventListener("updatefound", watch);
      navigator.serviceWorker.addEventListener("controllerchange", activated);
      document.addEventListener("visibilitychange", check);
      document.addEventListener("visibilitychange", hidden);
      window.addEventListener("online", check);
      const interval = setInterval(check, 30 * 60_000);
      watch();
      cleanup = () => {
        clearInterval(interval); worker?.removeEventListener("statechange", ready);
        reg.removeEventListener("updatefound", watch);
        navigator.serviceWorker.removeEventListener("controllerchange", activated);
        document.removeEventListener("visibilitychange", check);
        document.removeEventListener("visibilitychange", hidden);
        window.removeEventListener("online", check);
      };
    }).catch(() => { /* The website still works if installation is unavailable. */ });
    return () => { cancelled = true; cleanup(); };
  }, []);

  return {
    installed, online, waiting, help, dismissed,
    closeHelp: () => setHelp(false), dismissUpdate: () => setDismissed(true),
    install: async () => {
      if (!prompt) { setHelp(true); return; }
      try { await prompt.prompt(); await prompt.userChoice; }
      catch { setHelp(true); }
      finally { setPrompt(null); }
    },
    update: () => {
      if (!waiting || !online) return;
      reloading.current = true;
      waiting.postMessage({ type: "ACTIVATE_UPDATE" });
    },
  };
}

export function InstallDialog({ onClose }: { onClose: () => void }) {
  return <Modal title="Install Muba AI" onClose={onClose}>
    <div className="pwa-install">
      <div className="pwa-preview"><img src="/icons/esa-192.png?v=7" width="64" height="64" alt="" /><div><b>Your workspace, one tap away</b><p>Open Muba AI from your home screen in its own app window.</p></div></div>
      {!window.isSecureContext && <p className="pwa-secure">Open Muba AI through an HTTPS address to install it on your phone.</p>}
      <div className="pwa-instructions">
        <p><b>iPhone or iPad</b><span>In Safari, open Share, choose Add to Home Screen, then Add.</span></p>
        <p><b>Android</b><span>In Chrome, open the browser menu, choose Install app or Add to Home screen, and confirm.</span></p>
        <p><b>Desktop</b><span>Use your browser’s install icon. In Safari on Mac, choose File → Add to Dock.</span></p>
      </div>
      <p className="muted small">Use your existing Kanban login. Your Mac needs to be awake and online for boards, Claude, and terminals.</p>
      <div className="actions"><button className="btn primary" onClick={onClose}>Got it</button></div>
    </div>
  </Modal>;
}
