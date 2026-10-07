const NAME_CHAR = /[a-z0-9-]/;
/** What may sit right before a triggering character: start, whitespace or an opening bracket/quote (not "leo@mail"). */
const BEFORE_AT = /[\s([{"'`]/;

/** The `@query` (or `$query` in the chat) the caret is in, if any: `start` is the index of the trigger. */
export function snippetQuery(value: string, caret: number, trigger = "@"): { start: number; query: string } | null {
  let i = caret;
  while (i > 0 && caret - i < 40 && NAME_CHAR.test(value[i - 1])) i--;
  if (i === 0 || value[i - 1] !== trigger) return null;
  const at = i - 1;
  if (at > 0 && !BEFORE_AT.test(value[at - 1])) return null;
  return { start: at, query: value.slice(i, caret) };
}

/** Snippets whose name starts with the query first, then those that merely contain it. */
export function matchSnippets<T extends { name: string }>(list: T[], query: string): T[] {
  const prefix = list.filter((s) => s.name.startsWith(query));
  return [...prefix, ...list.filter((s) => !s.name.startsWith(query) && s.name.includes(query))];
}

/** Replace value[start, end) (the `@query`) with the snippet text; caret goes right after it. */
export function replaceQuery(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  return { value: value.slice(0, start) + text + value.slice(end), caret: start + text.length };
}

export function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}
