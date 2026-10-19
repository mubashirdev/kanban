# Our changes on top of Leo's version

This repo is Leo's ckanban (`upstream` = github.com/leoawesome/kanban) plus a few add-ons of ours. Keep it that way so his updates merge with few conflicts.

## The add-on rule

- Our features live in their own files: `web/src/addons/` (UI), `src/server/addons/` (server), `web/addons/` (build-time code), `web/public/addons/` (static files).
- Leo's files only get a small hook: an import plus one line. Don't rename, reformat or move his code.
- Every hook is listed below with its reason. Add a row when you add a hook, remove it when you remove one.
- Look changes go in one extra stylesheet loaded after his (`web/src/addons/addons.css`, imported last in `web/src/main.tsx`). There is none yet.

## Branding

The app name and icons come from one file: `web/src/addons/brand.ts`. The icons are in `web/public/addons/icons/`. To change the name or icon, edit only those.

`web/addons/brand-plugin.ts` writes the brand into Leo's static files at build time (`bun run build:web`): the tab title and icons in `index.html`, the name and icons in `manifest.webmanifest`, the push notification title fallback and icon in `sw.js`. The source files stay Leo's. Under `vite dev` the manifest and `sw.js` still show his. Only the built `web/dist` is branded.

Leo's own strings that we leave alone: "ckanban" in prompts, the CLI, the MCP server name, git identity, `TicketMenu.tsx` ("Report a bug in ckanban", which files the bug on his repo) and `ConnectionsDialog.tsx` (names the `ckanban` MCP server).

## Hooks in Leo's files

| File | Hook | Why |
|---|---|---|
| `web/vite.config.ts` | imports `brandPlugin` and adds it to `plugins` | brands `index.html`, the manifest and `sw.js` in the build |
| `web/src/App.tsx` | imports `BRAND` and `BrandLogo`; `document.title` uses `BRAND.name`; the header renders `<BrandLogo />` and `{BRAND.name}` instead of `<Logo />` and "ckanban" | tab title and header logo |
| `src/server/notify.ts` | imports `BRAND`; the test notification uses `BRAND.name` | the "Test notification" a user sends from settings |
| `CLAUDE.md` | a pointer to this file; our wording in the two workflow sections; merges from upstream land as merge commits | so every run follows the add-on rule and our landing flow |

`Logo` stays in `App.tsx`'s icon import on purpose: changing Leo's long import line would conflict with most of his updates.

## Updating from Leo

```sh
git fetch upstream && git merge upstream/main
```

Then check that every hook in the table above is still there (grep for `BRAND` and `brandPlugin`). After `bun run build:web`, `web/dist/index.html` and `web/dist/manifest.webmanifest` should say "Muba AI". If Leo changed the strings the plugin replaces, fix the plugin, not his files. Then run the usual checks and land as in `CLAUDE.md`, as a merge commit (don't rebase or squash a merge from upstream).

## Our features not in Leo's version yet

These were in our version before the switch (tag `pre-leo-switch`) and come back as separate add-on tickets: Codex and Cursor as ticket/chat agents (Leo's Codex support only registers the board's MCP server with Codex) with our Codex permission flow, our push alerts/notifications, review panel, our search dialog (Leo has his own ⌘K command bar), git bar, Sessions "On this Mac", daily cost, slash commands, dictation, public URL phone access with sign-in page and passkeys (Leo's Tailscale phone access is used instead).

Unfinished work from the main checkout at the time of the switch is on branch `wip/pre-leo-switch`.
