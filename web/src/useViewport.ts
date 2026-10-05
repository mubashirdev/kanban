import { useEffect } from "react";

/** Safari's keyboard shrinks the visual viewport without changing CSS viewport units. */
export function useViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      // Preserve browser zoom: only follow the keyboard while the page is at its normal scale.
      const normalScale = !viewport || Math.abs(viewport.scale - 1) < 0.01;
      document.documentElement.style.setProperty("--viewport-height", `${normalScale && viewport ? viewport.height : window.innerHeight}px`);
      document.documentElement.style.setProperty("--viewport-top", `${normalScale && viewport ? viewport.offsetTop : 0}px`);
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.documentElement.style.removeProperty("--viewport-height");
      document.documentElement.style.removeProperty("--viewport-top");
    };
  }, []);
}
