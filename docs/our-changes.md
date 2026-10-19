# Our changes on top of Leo's version

This repo is Leo's ckanban (`upstream` = github.com/leoawesome/kanban) plus a few add-ons of ours. Keep it that way so his updates merge with few conflicts.

## The add-on rule

- Our features live in their own files: `web/src/addons/` (UI), `src/server/addons/` (server), `web/addons/` (build-time code), `web/public/addons/` (static files).
- Leo's files only get a small hook: an import plus one line. Don't rename, reformat or move his code.
- Every hook is listed below with its reason. Add a row when you add a hook, remove it when you remove one.
- Look changes go in one extra stylesheet loaded after his (`web/src/addons/addons.css`, imported last in `web/src/main.tsx`).

## Branding

The app name and icons come from one file: `web/src/addons/brand.ts`. The icons are in `web/public/addons/icons/`. To change the name or icon, edit only those.

`web/addons/brand-plugin.ts` writes the brand into Leo's static files at build time (`bun run build:web`): the tab title and icons in `index.html`, the name and icons in `manifest.webmanifest`, the push notification title fallback and icon in `sw.js`. The source files stay Leo's. Under `vite dev` the manifest and `sw.js` still show his. Only the built `web/dist` is branded.

Leo's own strings that we leave alone: "ckanban" in prompts, the CLI, the MCP server name, git identity, `TicketMenu.tsx` ("Report a bug in ckanban", which files the bug on his repo) and `ConnectionsDialog.tsx` (names the `ckanban` MCP server).

## Phone link with sign-in page

https://kanban-muba.ngrok.app is our phone link (Leo's own phone access goes over Tailscale). It runs outside the daemon, as two macOS services:

- `io.ckanban.public-proxy` (`~/Library/LaunchAgents/io.ckanban.public-proxy.plist`) runs `src/server/addons/public-proxy.ts` from the main checkout on 127.0.0.1:7779. It shows the Muba AI sign-in page (password or passkey, `public-auth.ts` and `public-passkeys.ts` next to it) and passes signed-in requests to the board on 7777. Settings: `~/.config/kanban-access/credentials.json`; passkeys: `passkeys.json` beside it.
- `io.ckanban.ngrok` runs ngrok with `~/.config/kanban-access/ngrok.json`, whose tunnels point at 127.0.0.1:7779.

Port 7779, not 7778: Leo's phone access listener (`src/server/remote.ts`) takes the board port + 1. The proxy needs no hook in Leo's files. After a change to it: `launchctl kickstart -k gui/$(id -u)/io.ckanban.public-proxy`.

## Hooks in Leo's files

| File | Hook | Why |
|---|---|---|
| `web/vite.config.ts` | imports `brandPlugin` and adds it to `plugins` | brands `index.html`, the manifest and `sw.js` in the build |
| `web/src/App.tsx` | imports `BRAND` and `BrandLogo`; `document.title` uses `BRAND.name`; the header renders `<BrandLogo />` and `{BRAND.name}` instead of `<Logo />` and "ckanban" | tab title and header logo |
| `src/server/notify.ts` | imports `BRAND`; the test notification uses `BRAND.name` | the "Test notification" a user sends from settings |
| `package.json` | the `@simplewebauthn/server` dependency | passkey (Face ID) sign-in on the phone login page |
| `src/server/board.ts` | imports `startAgentRun` and `agentOf`; `startRun({` becomes `startAgentRun(agentOf(t), {` | Codex: the one switch where a ticket run or chat reply starts |
| `src/server/huddle.ts` | imports `startAgentRun` and `teammateAgent`; `startRun({` becomes `startAgentRun(teammateAgent(p), {` | Codex: a huddle teammate whose model is `codex` runs on Codex |
| `src/server/main.ts` | `new SessionCache()` becomes `new CodexSessionCache(store)`; `attachCodex(store, bus)`; the Board gets `sessionExists: (id) => sessions.exists(id, claudeSessionExists)` | Codex: a Codex ticket's conversation is read from Codex's own transcript, and its next run knows it can continue |
| `src/server/http.ts` | imports `codexRoutes` and `agentOnCreate`; `codexRoutes(...)` right after the JSON content-type check; `agentOnCreate(...)` right after a ticket is created | Codex: `/api/addons/codex/*` (pick the agent, answer a permission ask, Codex models) and `agent` in the New ticket request |
| `web/src/main.tsx` | imports `./addons/addons.css` after `styles.css` | our add-ons' styles |
| `web/src/NewTicketDialog.tsx` | `const agent = useAgentPicker()`; `{agent.field}` above "How should Claude work?"; `...agent.payload` in the create input | Codex: "Who works on it" (Claude or Codex) in the New ticket form |
| `web/src/TicketMenu.tsx` | `<AgentRow ticket={ticket} working={working} />` after the spending cap row | Codex: switch who works on a ticket |
| `web/src/Card.tsx` | `<CodexCardMark ticket={ticket} />` before the meta row; the preview's "Claude" becomes `agentName(ticket)` | Codex: the Codex mark on cards, and "Codex:" on its last reply |
| `web/src/Chat.tsx` | `<CodexAskCard ticket={ticket} onError={onError} />` before the jump button; the reply label "Claude" becomes `agentName(ticket)` | Codex: the permission card, and "Codex" on its replies |
| `web/src/HuddleRoster.tsx` | `<RosterAgentSwitch ... />` above the model menu in each teammate row | Codex: a Claude or Codex switch per teammate (sets the model to `codex`) |
| `src/server/http.ts` | imports `modelRoutes`; `modelRoutes(...)` right after `codexRoutes(...)` | Models: `/api/addons/models/*` (Claude's model list, a ticket's model and effort, board defaults) |
| `web/src/Chat.tsx` | `const modelPill = useModelPill(...)` after `useSlashCommands`; `if (modelPill.slash(t)) return setDraft("")` in `send`; `{modelPill.pill(running \|\| stopping)}` first in the composer actions | Models: the model and effort pill in the message box, and `/model` and `/effort` |
| `web/src/ProfileDialog.tsx` | `<DefaultModelsButton slug={profile.slug} onClaudeModel={setModel} />` first in the `{profile && ...}` block | Models: "Default models and effort for Claude and Codex…" in board settings |
| `CLAUDE.md` | a pointer to this file; our wording in the two workflow sections; merges from upstream land as merge commits | so every run follows the add-on rule and our landing flow |

`Logo` stays in `App.tsx`'s icon import on purpose: changing Leo's long import line would conflict with most of his updates.

## Codex

Codex is a second agent next to Claude (`src/server/addons/codex/`, `web/src/addons/codex/`). A ticket has `agent: codex` and its Codex thread in `codexSessionId` (the same fields our old version saved, so old Codex tickets continue). Codex runs through `codex app-server`, one process per reply, and sends the same events as Claude, so Leo's transcript, card and activity code shows it unchanged. Commands and edits outside its sandbox show the permission card (`codexAsk` on the ticket) on a ticket's own work and chats; Planning chats, read-only runs and huddle teammates never ask. Codex can write only the work folder and the ticket's outputs folder, never any part of `.git` (a planted hook or config would run outside its sandbox), so its commits ask first. Board tools that run commands for it (jobs, schedules) or start Claude helpers (`start_huddle`) are turned off for Codex. A huddle teammate runs on Codex when its model is `codex`. `GET /api/addons/codex/models` lists the user's Codex models. Set `CKANBAN_CODEX_BIN` to use another `codex`.

## Models and effort

The pill in the message box ("Opus 5.5 · High") picks the model and effort for a ticket's or chat's next turns, for Claude and Codex (`web/src/addons/models/`, `src/server/addons/models.ts`). Tap a part, or type `/model` or `/effort` (`/effort high`, `/effort auto`); for Claude, `/model sonnet` stays Leo's board command. The pill is off while a reply runs.

- A ticket keeps Leo's `model` (Claude) plus our `effort`, `codexModel` and `codexEffort` (the names our old version saved).
- Board defaults live in the board's `profile.json`: Leo's `model` is the Claude model, plus our `claudeEffort`, `codexModel` and `codexEffort`. Board settings, "Default models and effort for Claude and Codex…", edits all four.
- A run uses the ticket's own choice, else the board's, else the agent's own default. An effort the model doesn't support is left out, and the pill shows Auto.
- Claude runs get `--effort` in `startAgentRun` (`src/server/addons/agents.ts`); Leo's code already passes `--model`. Codex runs get `model` and `model_reasoning_effort` in `startCodexFor`. Huddle teammates keep their own settings.
- `GET /api/addons/models/claude` asks `claude -p` for its model list and the efforts each model supports (no model turn), kept 10 minutes.

## Updating from Leo

```sh
git fetch upstream && git merge upstream/main
```

Then check that every hook in the table above is still there (grep for `BRAND`, `brandPlugin`, `startAgentRun`, `CodexSessionCache`, `codexRoutes` and `addons/codex`). After `bun run build:web`, `web/dist/index.html` and `web/dist/manifest.webmanifest` should say "Muba AI". If Leo changed the strings the plugin replaces, fix the plugin, not his files. Then run the usual checks and land as in `CLAUDE.md`, as a merge commit (don't rebase or squash a merge from upstream).

## Our features not in Leo's version yet

These were in our version before the switch (tag `pre-leo-switch`) and come back as separate add-on tickets: Cursor as a ticket/chat agent (plugs into `startAgentRun` in `src/server/addons/agents.ts` like Codex), our push alerts/notifications, review panel, our search dialog (Leo has his own ⌘K command bar), git bar, Sessions "On this Mac", daily cost, slash commands, dictation, the trusted Wi-Fi address set on every start (`scripts/start-login.ts`; Leo's version has no Wi-Fi access). The phone link with sign-in page and passkeys is back (see above).

Unfinished work from the main checkout at the time of the switch is on branch `wip/pre-leo-switch`.
