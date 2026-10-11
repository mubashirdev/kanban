// Run before first paint, including Safari installations that only report navigator.standalone.
(() => {
  const mode = matchMedia("(display-mode: standalone)");
  const update = () => document.documentElement.toggleAttribute("data-standalone", mode.matches || navigator.standalone === true);
  update();
  mode.addEventListener("change", update);
})();

// Light or dark before first paint: the saved choice (Menu > Appearance), else the device's setting. See web/src/theme.ts.
(() => {
  const saved = localStorage.getItem("esa.theme");
  const dark = saved === "dark" || (saved !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
