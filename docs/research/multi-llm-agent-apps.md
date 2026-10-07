# Multi-model agent apps: what exists, what we have, what to build

Research date: 2026-10-07. "Apps" column comes from vendor docs read this session (URLs below each row group). Items marked unverified were not confirmed in a page. "We have it" cites code read in this worktree.

## Feature table

| Feature | Apps that have it | Do we have it? | Value on a phone | Effort | Risk |
|---|---|---|---|---|---|
| Model switching per message | LibreChat, Zed, Windsurf, Aider, Claude Code, Codex mobile ([librechat.ai/docs/features](https://www.librechat.ai/docs/features), [zed.dev/docs/ai/agent-panel](https://zed.dev/docs/ai/agent-panel), [docs.windsurf.com/plugins/cascade/models](https://docs.windsurf.com/plugins/cascade/models), [aider.chat/docs/usage/commands.html](https://aider.chat/docs/usage/commands.html), [9to5mac Codex mobile](https://9to5mac.com/2026/05/14/openai-brings-codex-control-to-chatgpt-for-iphone-and-android/)) | Yes, per chat, applies to the next reply: model/effort chips `web/src/Chat.tsx:168-179`, `QuickPick.tsx`, args built `src/server/board.ts:449` | High, already covered | - | - |
| Compare answers from several models | Open WebUI (2 models side by side), TypingMind, Cursor best-of-n, Windsurf Arena, Crystal ([docs.openwebui.com multi-model](https://docs.openwebui.com/features/chat-conversations/chat-features/multi-model-chats/), [docs.typingmind.com](https://docs.typingmind.com/manage-and-connect-ai-models/activate-multi-model-responses), [cursor.com/docs/configuration/worktrees](https://cursor.com/docs/configuration/worktrees), [docs.windsurf.com/windsurf/cascade/arena](https://docs.windsurf.com/windsurf/cascade/arena)) | Before this work: no. Now: fork a chat onto another model with the same question (side by side as two chats, not one split view) | High: second opinion without retyping | M (done, v1) | Low |
| Fork / branch a session | Claude Code (`--fork-session`, `/branch`), Codex CLI (`codex fork`, interactive), OpenCode (`--fork`, from a search summary), LibreChat, TypingMind ([code.claude.com/docs/en/sessions](https://code.claude.com/docs/en/sessions), [learn.chatgpt.com developer-commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [librechat.ai/docs/features/fork](https://www.librechat.ai/docs/features/fork)) | Before: no (grep for fork found nothing in `src/` or `web/src/`). Now: Claude chats, whole conversation (`src/server/board.ts:214`) | High | M (done for Claude, whole conversation only) | Low: one new optional ticket field `forkOf` |
| Edit and retry / regenerate | TypingMind, Zed, Claude Code rewind, LibreChat ([docs.typingmind.com chat-thread](https://docs.typingmind.com/chat-management/chat-thread), [code.claude.com/docs/en/checkpointing](https://code.claude.com/docs/en/checkpointing)) | No. The failed message is not stored, so a safe "Retry" button cannot know what to resend (`Chat.tsx:574-579` only shows the error). A message the agent never read is not in the session file either | Medium-high | M: store the last prompt on the ticket (data format change), then a button | Medium: wrong-message resend if built without storing it |
| Checkpoints / undo / rewind | Claude Code, Cline, Gemini CLI, OpenCode, Aider, Windsurf, Zed ([code.claude.com checkpointing](https://code.claude.com/docs/en/checkpointing), [docs.cline.bot/features/checkpoints](https://docs.cline.bot/features/checkpoints)) | No. Worktrees isolate tickets (`board.ts:578-594`) but there is no per-message restore | Medium | L | High: rewinding the session file and files must stay consistent |
| Permission / approval modes | Claude Code, Codex, Gemini CLI, OpenCode, Zed ([code.claude.com cli-reference](https://code.claude.com/docs/en/cli-reference), [opencode.ai/docs/permissions](https://opencode.ai/docs/permissions/)) | Partly: read vs edit per chat (`runner.ts:33` plan / bypassPermissions; `codex-runner.ts:17-19` read-only / workspace-write). No ask-each-time approvals | Medium: Codex mobile approves commands from the phone | L | High: needs a permission-prompt tool round trip |
| Background tasks | Claude Code `--bg`, Cursor cloud agents, Codex cloud, Warp ([code.claude.com cli-reference](https://code.claude.com/docs/en/cli-reference), [cursor.com/docs/background-agent](https://cursor.com/docs/background-agent)) | Yes: runs are detached daemon children, survive browser close and restart (`runner.ts:96-100`, `board.ts` recover) | High, covered | - | - |
| Worktree per task | Claude Code, Codex app, Cursor, Windsurf, Conductor, Crystal, Vibe Kanban, Warp ([conductor.build/docs](https://www.conductor.build/docs/), [github.com/stravu/crystal](https://github.com/stravu/crystal/tree/main)) | Yes, per ticket and optionally per chat (`board.ts:578-594`) | High, covered | - | - |
| PR / diff review | Codex app, Conductor, Vibe Kanban, Warp, Cursor ([openai.com/index/introducing-the-codex-app](https://openai.com/index/introducing-the-codex-app/)) | Yes: Changes tab `web/src/ReviewPanel.tsx`, git actions `src/server/git-actions.ts`. No inline comments on diff lines | Medium | M for line comments | Low |
| MCP management | Claude Code, Codex, Gemini CLI, Vibe Kanban, Zed | Yes (Claude Code's servers, login, add/remove): `web/src/ConnectionsDialog.tsx`, `src/server/mcp.ts` | Covered | - | - |
| Usage and cost | Claude Code (`total_cost_usd` in the result), OpenCode `step_finish`, Gemini CLI `stats` ([code.claude.com headless](https://code.claude.com/docs/en/headless)) | Yes: daily cost and plan usage `src/server/usage-daily.ts`, `web/src/UsagePill.tsx`; Codex has no cost (`usage-daily.ts:7`) | Covered | - | - |
| Search across chat history | Claude Code picker, LibreChat (Meilisearch), TypingMind, Gemini `/resume`, Zed ([code.claude.com sessions](https://code.claude.com/docs/en/sessions), [librechat.ai/docs/features](https://www.librechat.ai/docs/features)) | Before: titles and last message only, per list (`web/src/Sessions.tsx:75`, board search `App.tsx` title+body, ⌘K title only `Shortcuts.tsx`). Now: full text of titles, descriptions, comments and conversations (`src/server/search.ts`), reachable from the header menu on a phone | High: finding "where did I discuss X" | M (done) | Low: parses sessions already cached by the watcher |
| Saved prompts / slash commands | TypingMind library, LibreChat presets, Claude Code skills, OpenCode commands | Yes for commands and skills (`Chat.tsx:127`, `SlashCommands.tsx`, `codex-commands.ts`) and schedules (`scheduler.ts`). No saved-prompt library | Medium: typing on a phone is slow | S-M | Low |
| Notifications | Warp, Codex mobile, Claude hooks | Yes: web push (`src/server/notifications.ts:9`), inbox | Covered | - | - |
| Remote / mobile access | Claude Remote Control, Codex in ChatGPT mobile, Cursor iOS, OpenCode `serve` ([code.claude.com/docs/en/remote-control](https://code.claude.com/docs/en/remote-control), [opencode.ai/docs/server](https://opencode.ai/docs/server/)) | Yes: PWA over LAN pairing and protected public access (`lan.ts`, `public-proxy.ts`, `public-auth.ts`) | Core, covered | - | - |
| Third agent (multi-provider) | OpenCode (provider/model), Warp lists Claude, Codex, OpenCode, Gemini; Conductor runs Claude, Codex, Cursor, OpenCode ([docs.warp.dev cli-agents](https://docs.warp.dev/agents/cli-agents/overview/)) | Two agents only: `AgentId = "claude" \| "codex"` `src/server/agents.ts:13` | High for a "multi-LLM" app | L | Medium, see design note |

Note on Vibe Kanban: its README says it is sunsetting ([github.com/BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)), so it is a pattern reference only.

Not researched, no claims: Continue, LM Studio. Unverified: Cursor checkpoints and model-per-message, Cline plan/act, Zed history search (see the researcher's list in the report).

## Ranked recommendation

1. Fork a chat, optionally on another model with a first message (built). Gives compare-two-models and "try a different direction" in one tap, using the CLI's own `--fork-session`, which writes a new session and leaves the original untouched ([code.claude.com/docs/en/sessions](https://code.claude.com/docs/en/sessions)).
2. Full-text search over tickets and chats (built).
3. Store the last prompt on the ticket and add Retry / Edit-and-resend (M). Needs one new field; prevents resending the wrong text.
4. Third agent, see design note (L).
5. Ask-each-time approvals from the phone (L), as Codex mobile does.
6. Line comments on the diff (M).
7. Rewind (L, high risk).

## What was built

- `POST /api/profiles/:p/tickets/:id/fork { model?, text? }`. Server: `Board.fork` (`src/server/board.ts:214`), args `--resume <parent> --fork-session --session-id <new>` (`src/server/runner.ts`, `buildArgs`). Only idle Claude chats that run in the repo folder; Codex chats and worktree chats are refused with a message (Codex has `codex fork` only in the interactive CLI; no `codex exec fork` was found). UI: "Fork chat…" in the chat's ⋯ menu, `web/src/ForkDialog.tsx`.
- `GET /api/profiles/:p/search?q=`. `src/server/search.ts`, UI `web/src/SearchDialog.tsx`, opened from the ⋯ header menu ("Search tickets & chats").
- Data format: one optional field `forkOf` (session id) in the ticket front matter, cleared after the first successful run and on `/clear`. Older daemons ignore it.
- Verified the CLI behaviour with the real Claude CLI first: `claude -p ... --resume A --fork-session --session-id B` returned session B, B's log contains A's history, A is unchanged.

## Design note: third provider (Gemini CLI or OpenCode), not implemented

What the CLIs offer ([geminicli.com/docs/cli/headless.md](https://geminicli.com/docs/cli/headless.md), [opencode.ai/docs/cli](https://opencode.ai/docs/cli/)):

- Gemini CLI: `gemini -p` with `-o stream-json` (events `init`, `message`, `tool_use`, `tool_result`, `error`, `result`), `--model`, `--approval-mode default|auto_edit|yolo|plan` (plan is flagged experimental), `--resume <uuid>`, sessions under `~/.gemini/tmp/<hash>/chats/`. No fork found. Field names inside events are only from a third-party cheatsheet (unverified).
- OpenCode: `opencode run --format json --model provider/model --session <id>`; events `step_start`, `text`, `tool_use`, `step_finish` (third-party description, unverified); `serve` exposes an HTTP API with fork and SSE ([opencode.ai/docs/server](https://opencode.ai/docs/server/)); read-only means denying `edit` and `bash` in `opencode.json`; storage `~/.local/share/opencode/storage/`. It can talk to many providers, so one adapter gives many models.

What would change:

- `agents.ts`: `AgentId` and `AGENT_IDS` (line 13-14), binary resolution like `resolveCodexBin`, MCP registration like `setCodexServer` (OpenCode and Gemini each have their own config format), status list.
- New `<agent>-runner.ts` modelled on `codex-runner.ts`: spawn per message, map the JSON events to the Claude-shaped events the UI reads (`assistant` / `user` tool_use and tool_result, `result`), emit a thread event like `codex.thread` so `board.ts` can store the session id.
- `board.ts`: `executeOnce` branches on `t.agent === "codex"` in about ten places (`board.ts:413-430`, `begin`, `chat`, `clearConversation`); a third agent means turning these into a lookup, which is the first refactor with two real callers, so worth doing only when the third agent is accepted.
- Session parsing: `codex-session.ts` reads Codex rollouts; each new agent needs a log reader or must fall back to the board's own activity log (`CodexSessions.activityEvents`) which is simpler and survives format changes.
- Ticket fields: `codexSessionId`, `codexModel`, `codexEffort` are Codex-specific; a third agent needs its own or a generic pair.
- UI: agent pickers (`Sessions.tsx` `AGENTS`), model catalogs (`codex-catalog.ts`), `AgentMark`.
- Risks: event formats are not documented officially for either CLI (verify against a real run first); Gemini read-only mode is experimental, so "Read only" may not be enforced; OpenCode permissions are config-file based, so the board would write a config; per-agent cost and usage data differ; each CLI needs its own login on the Mac.
- Suggested first step: OpenCode through `opencode run --format json` for one read-only chat, behind a real run captured to a fixture.
