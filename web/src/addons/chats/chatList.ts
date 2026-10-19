// No imports from ../../api: the server's tests import this file, and api.ts needs the browser's types.

/** What the Chats list reads from a ticket (the add-on's fields next to Leo's). */
interface ChatLike {
  standalone?: boolean;
  readAt?: string | null;
  running?: boolean;
  createdAt: string;
  session?: { lastMessage: { role: string; at?: string } | null } | null;
}

export const isChat = (t: object): boolean => !!(t as ChatLike).standalone;

/** When the chat last had a message (the list's order and time). */
export const lastAt = (t: ChatLike): string => t.session?.lastMessage?.at ?? t.createdAt;

/** The agent replied after the user last looked at the chat. */
export function isUnread(t: ChatLike): boolean {
  const last = t.session?.lastMessage;
  if (t.running || last?.role !== "assistant") return false;
  return !t.readAt || (last.at ?? "") > t.readAt;
}

/** Chats matching the search, newest message first. */
export function chatList<T extends ChatLike & { title: string; session?: { lastMessage: { role: string; at?: string; text?: string } | null } | null }>(tickets: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return tickets
    .filter((t) => isChat(t) && (!q || `${t.title}\n${t.session?.lastMessage?.text ?? ""}`.toLowerCase().includes(q)))
    .sort((a, b) => lastAt(b).localeCompare(lastAt(a)));
}
