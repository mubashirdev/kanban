import type { Ticket } from "./api";
export const PRIORITIES: NonNullable<Ticket["priority"]>[] = [
  "none",
  "low",
  "normal",
  "high",
  "urgent",
];
export const TEMPLATES: {
  kind: NonNullable<Ticket["kind"]>;
  name: string;
  hint: string;
  body: string;
}[] = [
  { kind: "task", name: "Task", hint: "A focused development task", body: "" },
  {
    kind: "bug",
    name: "Bug",
    hint: "Reproduce, fix, and verify",
    body: "## Problem\n\n## Steps to reproduce\n1. \n\n## Expected behaviour\n\n## Actual behaviour\n\n## Investigation plan\n- Reproduce the issue\n- Identify the cause\n- Propose the fix and verification\n\n## Acceptance criteria\n- [ ] Regression resolved\n\n## Verification\n- Reproduce before and after the fix\n- Add appropriate regression coverage\n",
  },
  {
    kind: "feature",
    name: "Feature",
    hint: "Define the outcome and scope",
    body: "## Goal\n\n## User flow\n\n## Scope\n\n## Acceptance criteria\n- [ ] \n\n## Verification\n- Check the complete user flow\n- Verify phone and desktop layouts for UI changes\n",
  },
  {
    kind: "refactor",
    name: "Refactor",
    hint: "Improve internals, preserve behaviour",
    body: "## Current problem\n\n## Proposed improvement\n\n## Behaviour to preserve\n\n## Acceptance criteria\n- [ ] Existing workflows preserved\n\n## Verification\n- Run existing checks\n- Compare behaviour before and after\n",
  },
  {
    kind: "research",
    name: "Research",
    hint: "Investigate and report findings",
    body: "## Question\n\n## Context\n\n## Deliverables\n- Findings with supporting evidence\n- Options, tradeoffs, and recommendation\n\n## Constraints\n- Investigate without changing product code\n",
  },
];
export function metadataMatches(
  ticket: Ticket,
  filter: { priority: string; label: string; kind: string }
) {
  return (
    (!filter.priority || (ticket.priority ?? "normal") === filter.priority) &&
    (!filter.kind || (ticket.kind ?? "task") === filter.kind) &&
    (!filter.label || ticket.labels?.includes(filter.label))
  );
}
