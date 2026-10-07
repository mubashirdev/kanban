import { expect, test } from "bun:test";
import { keyboardOpen } from "../web/src/keyboard";

test("the keyboard is seen whether Safari shrinks only the visible area or the whole page", () => {
  // Older Safari: the page keeps its height, only the visible area shrinks.
  expect(keyboardOpen({ innerHeight: 844, viewportHeight: 500, fullHeight: 844, editing: true })).toBe(true);
  // interactive-widget=resizes-content: both shrink, so only the height before typing tells.
  expect(keyboardOpen({ innerHeight: 500, viewportHeight: 500, fullHeight: 844, editing: true })).toBe(true);
  // Same heights but nothing focused: a smaller window, not a keyboard.
  expect(keyboardOpen({ innerHeight: 500, viewportHeight: 500, fullHeight: 844, editing: false })).toBe(false);
  // Typing with a hardware keyboard: nothing shrinks.
  expect(keyboardOpen({ innerHeight: 844, viewportHeight: 844, fullHeight: 844, editing: true })).toBe(false);
  // The QuickType bar alone (small change) is not the keyboard.
  expect(keyboardOpen({ innerHeight: 800, viewportHeight: 800, fullHeight: 844, editing: true })).toBe(false);
});
