# Esa Kanban modernization

Goal: control Claude and Codex fully from a phone. Keep the cream/coral branding, the PWA identity and sign-in, saved drafts, existing data and active-run behaviour.

- [x] Matching AI branding
- [x] Board/list views; phones get a one-row toolbar (search + Filters sheet) and no bottom bar, Activity sits in the menu
- [x] Development templates, priorities, labels and saved views
- [x] Review tab: diffs, CI checks, preview links and request changes
- [x] Opt-in push notifications and app icon badge
- [x] Per-ticket Claude/Codex execution with separate sessions
- [x] Sessions lane first on the board: ticket-free Claude/Codex chats in the repo folder that open as a full-screen chat, read-only or edit, resume earlier CLI sessions, move to board
- [x] One `/` menu for both agents: recent, common commands first, skills; Codex skills insert `$name`; `/clear` for both
- [x] 44px touch targets across board, ticket and session views
- [x] Tests, type checks, phone and desktop browser checks

Rules that still hold:
- Every provider keeps read-only Refine behaviour; active runs keep their provider and settings.
- Notifications stay opt-in and carry no ticket titles. iOS needs a visible notification for every push, so the service worker always shows one.
- Preview builds use a separate checkout and daemon (own `CKANBAN_HOME` and port), never the live `web/dist`.
- Codex reads its default model from `~/.codex/config.toml`; if that model isn't available for the account, choose one in the session's settings.
