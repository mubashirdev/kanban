import { useEffect } from "react";
import { autoGrow } from "./autoGrow";
import { keyboardOpen } from "./keyboard";

const isEditing = (el: Element | null) =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable) ||
  (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range", "color", "file"].includes(el.type));

/** Safari's keyboard shrinks the visual viewport without changing CSS viewport units. */
export function useViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    let previousHeight = 0;
    // Tallest visible height while not typing, per screen width (rotating changes it).
    let fullHeight = 0, fullWidth = 0;
    const revealAnswer = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // WebKit applies scroll anchoring after the first layout of the smaller
        // viewport. Wait for that layout before placing the focused answer.
        frame = requestAnimationFrame(() => {
          // Scroll only the conversation, never the page. Safari can otherwise pan
          // the whole workspace to reach an answer after its keyboard animates in.
          const input = document.activeElement;
          if (!(input instanceof HTMLTextAreaElement) || !input.matches(".qother")) return;
          const log = input.closest<HTMLElement>(".chat-log");
          if (!log) return;
          const box = input.getBoundingClientRect(), visible = log.getBoundingClientRect();
          if (box.bottom > visible.bottom - 8) log.scrollTop += box.bottom - visible.bottom + 8;
          else if (box.top < visible.top + 8) log.scrollTop -= visible.top - box.top + 8;
        });
      });
    };
    const update = () => {
      // Preserve browser zoom: only follow the keyboard while the page is at its normal scale.
      const normalScale = !viewport || Math.abs(viewport.scale - 1) < 0.01;
      const height = normalScale && viewport ? viewport.height : window.innerHeight;
      document.documentElement.style.setProperty("--viewport-height", `${height}px`);
      document.documentElement.style.setProperty("--viewport-top", `${normalScale && viewport ? viewport.offsetTop : 0}px`);
      const editing = isEditing(document.activeElement);
      if (window.innerWidth !== fullWidth) [fullHeight, fullWidth] = [0, window.innerWidth];
      if (!editing) fullHeight = Math.max(fullHeight, height);
      document.documentElement.toggleAttribute("data-keyboard-open", !!viewport && normalScale &&
        keyboardOpen({ innerHeight: window.innerHeight, viewportHeight: viewport.height, fullHeight, editing }));
      if (normalScale && height !== previousHeight) document.querySelectorAll<HTMLTextAreaElement>(".composer textarea, .qother").forEach((el) => autoGrow(el, el.matches(".qother") ? 6 : 8));
      previousHeight = height;
      revealAnswer();
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", revealAnswer);
    // The keyboard can finish opening before focus settles; check again once focus moves.
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    document.addEventListener("input", revealAnswer);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", revealAnswer);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      document.removeEventListener("input", revealAnswer);
      cancelAnimationFrame(frame);
      document.documentElement.style.removeProperty("--viewport-height");
      document.documentElement.style.removeProperty("--viewport-top");
      document.documentElement.removeAttribute("data-keyboard-open");
    };
  }, []);
}
