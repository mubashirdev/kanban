import { useEffect, useState } from "react";

/** Phones, and touch screens up to 900px wide (iPad portrait) get the phone layout. Same query as the CSS phone rules. */
export const PHONE = "(max-width: 767px), (pointer: coarse) and (max-width: 900px)";

/** Keep layout decisions in step with CSS, including rotation and window resizing. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
