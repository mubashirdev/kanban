// Installed iPhone app: mark <html> before first paint so pwa-shell.css can keep headers out of the status bar blur.
// Safari's home-screen app may only report navigator.standalone, not the display-mode media query.
(() => {
  const mode = matchMedia("(display-mode: standalone)");
  const update = () => document.documentElement.toggleAttribute("data-standalone", mode.matches || navigator.standalone === true);
  update();
  mode.addEventListener("change", update);
})();

// iPhone keyboard: Safari keeps the page full height and slides it up under the status bar, so the field's own
// buttons (Send, Save) sit under the keyboard. Size the app to the space above the keyboard instead and follow
// where Safari moved the visible area (web/src/addons/addons.css reads data-keyboard, --keyboard-h and --keyboard-top).
(() => {
  const vv = globalThis.visualViewport;
  if (!vv || !matchMedia("(pointer: coarse)").matches) return;
  const root = document.documentElement;
  const fit = () => {
    const open = vv.height < root.clientHeight - 120;
    root.toggleAttribute("data-keyboard", open);
    root.style.setProperty("--keyboard-h", `${Math.round(vv.height)}px`);
    root.style.setProperty("--keyboard-top", `${open ? Math.round(vv.offsetTop) : 0}px`);
    if (open && scrollY) scrollTo(0, 0);
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  fit();
})();
