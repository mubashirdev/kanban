/** Grow to a few lines, leaving room for the conversation in the keyboard viewport. */
export function autoGrow(el: HTMLTextAreaElement | null, lines = 8) {
  if (!el) return;
  el.style.height = "auto";
  const viewport = window.visualViewport;
  const normalScale = !viewport || Math.abs(viewport.scale - 1) < 0.01;
  const height = normalScale && viewport ? viewport.height : window.innerHeight;
  const keyboard = window.innerHeight - height > 120;
  const max = Math.max(44, Math.min(height * (keyboard ? 0.2 : 0.3), lines * 22 + 8));
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}
