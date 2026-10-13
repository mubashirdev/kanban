import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, type Store } from "./store";
import type { Ticket } from "./types";
import { newId, nowIso } from "./util";

/** A ticket the user saved to start from again (New ticket dialog). scope: "global" or a board (profile slug). */
export interface TicketTemplate {
  id: string;
  name: string;
  title: string;
  body: string;
  kind: NonNullable<Ticket["kind"]>;
  priority: NonNullable<Ticket["priority"]>;
  scope: string;
  createdAt: string;
  updatedAt: string;
}

export type TemplateInput = Pick<TicketTemplate, "name" | "title" | "body" | "kind" | "priority" | "scope">;

export class TemplateError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const KINDS = ["task", "bug", "feature", "refactor", "research"] as const;
const PRIORITIES = ["none", "low", "normal", "high", "urgent"] as const;
const MAX_NAME = 60;
const MAX_TITLE = 200;
const MAX_BODY = 20_000;

/** All templates live in one file, `<root>/templates.json`, stored like snippets. */
export class Templates {
  constructor(private store: Store) {}

  private get file() {
    return join(this.store.root, "templates.json");
  }

  private readAll(): TicketTemplate[] {
    if (!existsSync(this.file)) return [];
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  private writeAll(list: TicketTemplate[]) {
    atomicWrite(this.file, JSON.stringify(list, null, 2) + "\n");
  }

  /** Global templates plus the board's own, sorted by name. */
  list(profile?: string): TicketTemplate[] {
    return this.readAll()
      .filter((t) => !profile || t.scope === "global" || t.scope === profile)
      .sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
  }

  create(input: Partial<TemplateInput>): TicketTemplate {
    const list = this.readAll();
    const name = String(input.name ?? "").trim();
    const title = String(input.title ?? "").trim();
    const body = String(input.body ?? "");
    const scope = String(input.scope ?? "global");
    if (!name) throw new TemplateError(400, "name is required");
    if (name.length > MAX_NAME) throw new TemplateError(400, `name is too long (max ${MAX_NAME} characters)`);
    if (!title && !body.trim()) throw new TemplateError(400, "a title or description is required");
    if (title.length > MAX_TITLE) throw new TemplateError(400, `title is too long (max ${MAX_TITLE} characters)`);
    if (body.length > MAX_BODY) throw new TemplateError(400, `description is too long (max ${MAX_BODY} characters)`);
    if (!KINDS.includes(input.kind as any)) throw new TemplateError(400, `kind must be one of ${KINDS.join(", ")}`);
    if (!PRIORITIES.includes(input.priority as any)) throw new TemplateError(400, `priority must be one of ${PRIORITIES.join(", ")}`);
    if (scope !== "global" && !this.store.getProfile(scope)) throw new TemplateError(400, `board ${scope} not found`);
    if (list.some((t) => t.scope === scope && t.name.toLowerCase() === name.toLowerCase())) {
      throw new TemplateError(409, `A template named "${name}" already exists ${scope === "global" ? "on all boards" : "on this board"}`);
    }
    const at = nowIso();
    const t: TicketTemplate = { id: newId(), name, title, body, kind: input.kind!, priority: input.priority!, scope, createdAt: at, updatedAt: at };
    this.writeAll([...list, t]);
    return t;
  }

  remove(id: string): void {
    const list = this.readAll();
    if (!list.some((t) => t.id === id)) throw new TemplateError(404, "template not found");
    this.writeAll(list.filter((t) => t.id !== id));
  }

  /** A board was deleted: its own templates go with it. */
  dropScope(profile: string): void {
    const list = this.readAll();
    if (list.some((t) => t.scope === profile)) this.writeAll(list.filter((t) => t.scope !== profile));
  }
}
