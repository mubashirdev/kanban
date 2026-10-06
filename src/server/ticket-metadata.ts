export const PRIORITIES = ["none", "low", "normal", "high", "urgent"] as const;
export const TICKET_KINDS = [
  "task",
  "bug",
  "feature",
  "refactor",
  "research",
] as const;
export type TicketMetadata = {
  agent?: "claude" | "codex";
  priority?: typeof PRIORITIES[number];
  kind?: typeof TICKET_KINDS[number];
  labels?: string[];
};

/** Shared by creation and edits; reject malformed input rather than silently losing it. */
export function ticketMetadata(input: Record<string, unknown>): TicketMetadata {
  const patch: TicketMetadata = {};
  if (input.agent !== undefined) {
    if (input.agent !== "claude" && input.agent !== "codex")
      throw new Error("Choose an available coding agent");
    patch.agent = input.agent;
  }
  if (input.priority !== undefined) {
    if (!PRIORITIES.includes(input.priority as any))
      throw new Error("Choose a valid priority");
    patch.priority = input.priority as TicketMetadata["priority"];
  }
  if (input.kind !== undefined) {
    if (!TICKET_KINDS.includes(input.kind as any))
      throw new Error("Choose a valid ticket type");
    patch.kind = input.kind as TicketMetadata["kind"];
  }
  if (input.labels !== undefined) {
    if (
      !Array.isArray(input.labels) ||
      input.labels.length > 10 ||
      input.labels.some(
        (label) =>
          typeof label !== "string" ||
          !label.trim() ||
          label.trim().length > 32 ||
          /[\x00-\x1f]/.test(label)
      )
    ) {
      throw new Error("Use up to 10 labels, each between 1 and 32 characters");
    }
    patch.labels = [
      ...new Set(input.labels.map((label: string) => label.trim())),
    ];
  }
  return patch;
}
