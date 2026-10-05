// Run before first paint, including Safari installations that only report navigator.standalone.
(() => {
  const mode = matchMedia("(display-mode: standalone)");
  const update = () => document.documentElement.toggleAttribute("data-standalone", mode.matches || navigator.standalone === true);
  update();
  mode.addEventListener("change", update);
})();
