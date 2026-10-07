/* Kept free of React/DOM so it can be unit tested. */

/**
 * Whether the on-screen keyboard is up. Older Safari shrinks only the visual viewport (innerHeight stays);
 * with interactive-widget=resizes-content both shrink, so compare with the full height seen before typing.
 */
export function keyboardOpen(v: { innerHeight: number; viewportHeight: number; fullHeight: number; editing: boolean }): boolean {
  if (v.innerHeight - v.viewportHeight > 120) return true;
  return v.editing && v.fullHeight - v.viewportHeight > 120;
}
