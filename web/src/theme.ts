/** Light, dark or the device's setting (System), saved per device. pwa-shell.js applies it before first paint. */
export type ThemeChoice = "system" | "light" | "dark";

const KEY = "esa.theme";
const BAR_COLOR = { light: "#f5f4ef", dark: "#1a1918" };
const deviceDark = matchMedia("(prefers-color-scheme: dark)");

export function themeChoice(): ThemeChoice {
  const saved = localStorage.getItem(KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

export const isDark = () => document.documentElement.dataset.theme === "dark";

/** Sets <html data-theme> and the browser bar color, then tells listeners (the terminal) with a "themechange" event. */
function applyTheme() {
  const choice = themeChoice();
  const theme = choice === "dark" || (choice === "system" && deviceDark.matches) ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.removeAttribute("media");
    meta.setAttribute("content", BAR_COLOR[theme]);
  });
  window.dispatchEvent(new Event("themechange"));
}

export function setThemeChoice(choice: ThemeChoice) {
  if (choice === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, choice);
  applyTheme();
}

applyTheme();
deviceDark.addEventListener("change", applyTheme);
