import { useEffect, useState, type ReactNode } from "react";
import type { Profile, Ticket } from "../../api";
import { BellIcon } from "../../icons";
import { MoreSheet } from "../../PhoneNav";
import { usePersistentState } from "../../usePersistentState";
import { ChatsView } from "./ChatsView";
import { chatList, isChat, isUnread } from "./chatList";

/**
 * Chats in Leo's App: on phones the bottom bar's first tab (where Now was), on wide screens a Board | Chats switch in
 * the top bar. Chats never show on the board, and a chat opens in Chats, not in the ticket drawer.
 */
export function useChats({ profile, tickets, open, phone, phoneTab, openTicket, closeTicket, showPhoneTab }: {
  profile: Profile | null; tickets: Ticket[]; open: Ticket | null; phone: boolean;
  /** The phone's bottom bar tab: "now" is the Chats tab. */
  phoneTab: string;
  openTicket: (id: string) => void; closeTicket: () => void; showPhoneTab: () => void;
}) {
  const [on, setOn] = usePersistentState<boolean>("muba.chats.on", () => false, (v) => !v, (v) => typeof v === "boolean");
  const [starting, setStarting] = useState(false);
  const showing = phone ? phoneTab === "now" : on;
  const chatOpen = !!open && isChat(open);
  // A chat opened from elsewhere (the inbox, a link), or the open ticket just moved to Chats: show it there.
  useEffect(() => {
    if (!chatOpen || showing) return;
    if (phone) showPhoneTab();
    else setOn(true);
  }, [open?.id, chatOpen]);
  const show = (chats: boolean) => {
    if (open && chats !== chatOpen) closeTicket();
    setOn(chats);
  };
  const unread = chatList(tickets, "").filter(isUnread).length;

  return {
    showing,
    /** How many chats have a reply the user hasn't read. */
    unread,
    /** A chat open in the URL never opens the ticket drawer. */
    hidesDrawer: chatOpen,
    newChat: () => {
      if (open) closeTicket();
      if (phone) setStarting(true);
    },
    switcher: (
      <div className="segmented chats-switch desktop-only" role="radiogroup" aria-label="Show">
        <button type="button" role="radio" aria-checked={!on} className={on ? "" : "on"} onClick={() => show(false)}>Board</button>
        <button type="button" role="radio" aria-checked={on} className={on ? "on" : ""} onClick={() => show(true)}>
          Chats{unread > 0 && <span className="chip-count">{unread}</span>}
        </button>
      </div>
    ),
    view: showing && profile ? (
      <ChatsView profile={profile} tickets={tickets} openId={chatOpen ? open!.id : null} wide={!phone} starting={starting} onStarting={setStarting}
        onOpen={openTicket} onClose={closeTicket} onOpenTicket={openTicket} />
    ) : null,
  };
}

/**
 * The phone top bar's bell: how many tickets need you, and a sheet with what Leo's Now screen showed (`children`,
 * given a close function) plus the notification setup.
 */
export function PhoneBell({ count, onNotifications, children }: { count: number; onNotifications: () => void; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <button className="btn ghost phone-only topbar-icon phone-bell" aria-label={count ? `${count} need you` : "Nothing needs you"} onClick={() => setOpen(true)}>
        <BellIcon size={18} />{count > 0 && <span className="pn-badge">{count}</span>}
      </button>
      {open && <MoreSheet label="Needs you" onClose={close} top={<div className="bell-now">{children(close)}</div>}
        items={[{ label: "Get told on this phone", icon: <BellIcon />, onSelect: onNotifications }]} />}
    </>
  );
}
