/** Interpret only explicit leading alternatives. Nested/free-form syntax remains an input. */
export function commandArguments(command: { argumentHint: string }) {
  const hint = command.argumentHint.trim();
  const enumMatch = /^(?:\[([^\[\]<>]+)\]|<([^\[\]<>]+)>)(.*)$/.exec(hint) ?? (/^[\w.-]+(?:\s*\|\s*[\w.-]+)+$/.test(hint) ? [hint, hint, "", ""] : null);
  const literals = (enumMatch?.[1] ?? enumMatch?.[2] ?? "").split("|").map((v) => v.trim());
  const choices = literals.length > 1 && literals.every((v) => /^[\w.-]+$/.test(v)) ? literals : [];
  const remaining = choices.length ? enumMatch![3].trim() : hint;
  return { choices, remaining, required: /^</.test(remaining) && !/optional/i.test(remaining) };
}

/** Replace just a command already being composed; preserve ordinary unsent text. */
export function prepareCommand(draft: string, command: string) {
  const leading = /^([ \t]*)\/[\w:./@-]*(?:[ \t]|$)/.exec(draft);
  return leading ? command : `${command}${draft ? ` ${draft}` : " "}`;
}
