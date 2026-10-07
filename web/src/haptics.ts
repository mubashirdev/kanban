/** A short buzz on phones that support it (Android; iOS Safari has no vibration API, so this does nothing there). */
export function buzz(pattern: number | number[] = 12) {
  try {
    navigator.vibrate?.(pattern);
  } catch {}
}
