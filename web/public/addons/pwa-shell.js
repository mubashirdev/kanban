// Installed iPhone app: mark <html> before first paint so pwa-shell.css can keep headers out of the status bar blur.
// Safari's home-screen app may only report navigator.standalone, not the display-mode media query.
(() => {
  const mode = matchMedia("(display-mode: standalone)");
  const update = () => document.documentElement.toggleAttribute("data-standalone", mode.matches || navigator.standalone === true);
  update();
  mode.addEventListener("change", update);
})();
