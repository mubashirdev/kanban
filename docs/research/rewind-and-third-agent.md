# Rewind / checkpoints, and a third agent

Design research, October 2026. No source code was changed. Every external claim has a URL; anything I could not verify is marked **UNVERIFIED**.

Facts about this repo come from reading the code in this worktree. Note: `Board.fork` does not exist in this copy (`grep -rniE fork src web/src` finds nothing outside unrelated words), and `docs/research/multi-llm-agent-apps.md` is not in this copy either. Only `claude-code-mods.md` exists. So "fork" below means a new design, not an existing method.

## What the code does today (verified by reading)

- Claude runs: `runner.ts` `buildArgs` starts `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --include-partial-messages --permission-mode <bypassPermissions|plan>` plus `--session-id <id>` or `--resume <id>`. Prompts go in on stdin. It does NOT set `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, so Claude's own file checkpoints are not being recorded for board runs.
- Codex runs: `codex-runner.ts` / `codexArgs` runs `codex exec [resume <id>] --json --skip-git-repo-check -c approval_policy="never" -c sandbox_mode="read-only|workspace-write" ... -`. One prompt per process. The thread id comes from the `thread.started` event and is saved as `ticket.codexSessionId`. The Codex runner maps Codex items to Claude-shaped events (`Bash`, `Edit` tool_use) so the UI has one event shape.
- Transcripts: Claude's UI reads `~/.claude/projects/*/<sessionId>.jsonl` via `parseSession` (entries keyed by the real `uuid` of each line). Codex's UI reads `~/.codex/sessions/**/rollout-*<threadId>.jsonl` via `rolloutEvents`; the uuids there are synthetic (`rollout-<line number>`), not Codex ids.
- Where work happens: a ticket has its own git worktree (`git.ts` `addWorktree`, dir `<repo parent>/.ckanban-worktrees/<slug>/<id>`), except standalone sessions, which work directly in the repo folder unless `isolated`. `removeWorktree` already refuses when `git status --porcelain` is not empty, so the codebase already treats dirty trees as precious.
- The agent is hard-coded in 44 `=== "codex"` style branches across 17 server files and 19 web files (`grep -rn "codex" src web/src -il`). Relevant for Part B.
- `/clear` already exists: it swaps `ticket.sessionId` (Claude) or nulls `codexSessionId`, and the old conversation stays in the agent's own history. Rewind can reuse that "switch the ticket to another session id" move.

---

# Part A. Rewind / checkpoints

## A1. What the agents offer (verified)

**Claude Code interactive `/rewind`** ([checkpointing docs](https://code.claude.com/docs/en/checkpointing)):
- A checkpoint is created for "every prompt you send that starts a turn". Last 100 checkpoints per session are kept. Snapshots are deleted by a retention sweep about 30 days after last save (`cleanupPeriodDays`).
- Actions: restore code and conversation, restore conversation only, restore code only, summarize.
- Limits, quoted: "Checkpointing does not track files modified by Bash commands" (`rm`, `mv`, `cp` cannot be undone); subagent edits are mostly not restored; external edits and edits from other sessions are "normally not captured"; a message queued mid-turn gets no checkpoint of its own ("rewind to the prompt that started the turn"); symlinked and hard-linked paths are skipped; "Not a replacement for version control".

**Claude Code headless** ([Agent SDK file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing), [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript)):
- Enable with env `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` (the SDK sets it from `enableFileCheckpointing`). User message uuids are the restore points and appear in the stream only with `--replay-user-messages` (which the board already passes).
- Restore from the CLI: `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true claude -p --resume <session-id> --rewind-files <checkpoint-uuid>`. The doc says the flag "doesn't appear in `claude --help` output, but the CLI accepts it"; on success it prints `Files rewound to state at message <uuid>` and sends no prompt.
- Only Write, Edit and NotebookEdit are tracked. Bash changes are not. "Same session" only, and directory create/move/delete is not undone.
- SDK `rewindFiles(id, { dryRun: true })` returns `{ canRewind, filesChanged[], insertions, deletions }`, which is exactly what a confirm sheet needs. I found no documented CLI flag for the dry run (**UNVERIFIED** whether `--rewind-files` has one).
- Conversation truncation: SDK option `resumeSessionAt` = "Resume session at a specific message UUID", with `resumeDropsTurn` (needs SDK v0.3.223+; "Only the Agent SDK and print-mode resumes read the pair"). The CLI flags `--resume-session-at` and `--resume-drops-turn` are not in the CLI reference page. Local check on claude 2.1.292: `claude -p --resume <nonexistent> --resume-session-at abc "hi"` and `... --rewind-files abc` both answered `No conversation found with session ID` instead of "unknown option", so the parser accepts both flags. I did not run them against a real session (the owner's live data), so exact semantics are **UNVERIFIED**: whether the uuid must be an assistant or user line, and whether the original jsonl is truncated in place or only the loaded context is cut. Combine with `--fork-session` ("create a new session ID instead of reusing the original", [CLI reference](https://code.claude.com/docs/en/cli-reference)) to keep the original safe; that combination is also **UNVERIFIED** for print mode.
- Local storage seen: `~/.claude/file-history/<sessionId>/<hash>@vN` (read-only `ls`, 16 sessions).

**Codex** ([CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)):
- `codex exec resume <SESSION_ID>`, `codex resume`, `codex fork` ("creates a new chat from previous sessions"), `--ephemeral`. The docs I fetched list no undo, rewind or rollback command.
- The open-source repo has a "ghost commit" snapshot mechanism for undo: `git commit-tree` writes an unreferenced commit, restore uses `git restore --source <ghost>`; untracked/ignored files are left alone and oversized untracked artifacts are skipped ([commit "git tooling for undo (#3914)"](https://forge.lthn.ai/core/core-agent-ide/commit/e0fbc112c772f87c9386cb2de992fbf8cdcb07d7), a mirror of openai/codex; search summary only). I did not verify that `codex exec` creates or exposes these, nor any way to truncate a thread to turn N. Treat Codex conversation rewind as **not available headless**.
- `codex` is not installed on this machine's PATH (`which codex` failed; the board falls back to the ChatGPT app bundle), so I ran no local Codex commands.

**Gemini CLI** has checkpointing with a shadow git repo at `~/.gemini/history/<project_hash>` ([doc](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md)), which independently confirms the git-snapshot idea is the common solution.

## A2. Options

| Option | Files | Conversation | Covers Bash edits | Codex | Verdict |
|---|---|---|---|---|---|
| 1. Claude native only (`--rewind-files`, `--resume-session-at`) | Edit/Write only | Yes (to verify) | **No** | No | Misses `sed`, formatters, `npm install`, `git`, generated files. Agents change files through Bash all the time. Not enough alone. |
| 2. Board-owned git snapshots per turn | All tracked and non-ignored files | Needs agent help | **Yes** | **Yes** (files) | Recommended base. Same code for both agents. |
| 3. Ask the agent to undo | n/a | n/a | n/a | n/a | Unreliable, costs tokens. Rejected. |
| 4. Fork the ticket from message N (new worktree from snapshot, new session) | Yes | Claude only | Yes | Partly | Good fallback for Codex (see A6); more moving parts. |

**Recommendation: Option 2 for files, plus Claude's `--resume-session-at --fork-session` for the conversation on Claude tickets. Codex gets files-only restore in phase 1 and honest wording in the UI.** Do not depend on Claude's `--rewind-files`: it needs checkpointing enabled at original-run time and misses Bash.

## A3. How the git snapshot works

Taken by the board server (not the agent), so the Codex sandbox does not matter.

```
snapshot(dir):                         # dir = worktree, or the repo folder for non-isolated tickets
  idx = <git rev-parse --git-path index> copied to a temp file   # keeps it fast, never touches the real index
  GIT_INDEX_FILE=tmp git add -A        # respects .gitignore, includes untracked files
  tree = git write-tree
  commit = git commit-tree tree -p HEAD -m "ckanban snapshot <ticket> <turn>"
  git update-ref refs/ckanban/<ticketId>/<turn>-before commit
```

- Never touches the user's real index, HEAD, branches or working files. It only adds objects and a ref. `git stash create` is not enough because it ignores untracked files; the temp-index approach (same idea Codex uses) includes them.
- Worktrees share the main repo's object store and ref namespace, so refs are named per ticket id and deleted with the ticket (`Board` delete path already removes the worktree).
- Cost: `git add -A` is proportional to changed files since the index was last refreshed. Normal repos take well under a second. Huge repos (monorepos, big untracked build output not in .gitignore) can take seconds. Mitigation: run with a time budget (for example 10 s); on timeout skip the snapshot, mark that turn "not rewindable", and show a notice. Skip untracked files larger than a threshold (Codex does a similar thing, see source above).
- Ignored files (`node_modules`, `dist`, `.env`) are not snapshotted and not restored. This is the safe default (never delete or overwrite them) but means a rewind will not undo an `npm install`. The sheet must say so.
- Submodules and LFS: submodule contents are not captured (only the gitlink). Say "submodule changes are not restored". LFS pointers are captured as pointers.
- Disk: each snapshot stores only changed blobs (content-addressed), so cost is small. `git gc` will not collect them while refs exist. Keep the last 50 turns per ticket and delete older refs.
- Repo with no commits (the code already handles this case, `resolveBaseBranch` returns null): `commit-tree` without a parent still works; fine.

## A4. Data model (what is stored per message)

New file per ticket `checkpoints.jsonl` next to `activity.jsonl` in the store folder (`store.ts` `ticketDir`), one line per turn, append-only like `commands.jsonl`:

```ts
interface Checkpoint {
  turn: number;               // 1.. per ticket, in order
  at: string;                 // ISO time the turn started
  agent: "claude" | "codex";
  sessionId: string;          // Claude sessionId or Codex thread id at that time
  userUuid: string | null;    // Claude: uuid of the replayed user message; Codex: null (see below)
  userText: string;           // first 200 chars, to match the chat bubble when uuids are missing
  before: string | null;      // commit sha of the snapshot taken before the turn; null if skipped
  after: string | null;       // commit sha after the turn ended; null while running or skipped
  dir: string;                // the dir that was snapshotted
}
```

- Written in `Board.executeOnce` just before the agent is started (`before`) and when `run.handle.done` resolves (`after`). Follow-up messages that were steered into a running turn have no row, matching Claude's own limit ("not checkpointed").
- Claude `userUuid` comes from the replayed user event (`ev.type === "user" && ev.isReplay`, `ev.uuid`), already visible in `runner.ts`'s stream. UNVERIFIED: that replay events carry `uuid` in this CLI version; the docs say they do. Check in a spike.
- Codex: rollout uuids are synthetic (`rollout-<line>`), so match by order: the Nth user message in the parsed session is `turn N`. Match on `userText` as a sanity check and hide the rewind button if they disagree.
- Chat shows a small "Rewind" action on each user bubble whose uuid (or order) has a checkpoint with `before !== null`.

## A5. Restore flow on the phone

1. User long-presses or taps the "..." on their own message, picks **Rewind to here**.
2. App calls `GET /api/.../checkpoints/<turn>/preview`. Server (agent must be idle; same `ConflictError` rule as `chat`) computes:
   - `agentChanges`: `git diff --name-status <turn.before> <latestAfter>` = what the agent did from this point on.
   - `conflicts`: files where the working tree now differs from `latestAfter` (someone, you or another tool, edited after the agent finished). Found by snapshotting the current tree into a temporary tree object and diffing it against `latestAfter`.
3. Bottom sheet (existing sheet style) shows: "Go back to: <message text>", then three lists with counts: **Will be reverted** (files, +/- lines), **Will be deleted** (files the agent created), **You changed these after the agent** (unchecked by default, with a switch to include). Footer lines: "Ignored files (node_modules, .env) are not touched." and, for Codex, "Conversation stays; only files go back." Buttons: **Restore files**, **Restore files and conversation** (Claude only), Cancel.
4. On confirm: `POST .../restore { turn, files: [...], conversation: boolean }`.
   - Server first takes `refs/ckanban/<ticket>/pre-restore-<time>` (a snapshot of the tree as it is right now, including uncommitted and untracked changes).
   - Then for each selected path: if it exists at `turn.before`, write that content (`git checkout-index` from a temp index loaded with that tree); if it does not exist at `before` but exists now, delete it. Only paths in the confirmed list are touched.
   - If `conversation`: Claude only. Next message starts with `--resume <session> --resume-session-at <uuid> --fork-session`, and the ticket's `sessionId` switches to the new id once the CLI reports it (same pattern the board already uses for `/clear` rotating `session_id`). The old session file is left intact. The chat then shows only the truncated history because `parseSession` reads the ticket's current session file.
5. Result toast: "Restored 7 files. Undo" where Undo = restore from the `pre-restore` ref (same endpoint).

## A6. Failure and safety cases

Rules: never destroy uncommitted user work.

- **Always snapshot first.** The `pre-restore` ref makes every restore reversible, including files the user edited by hand in the meantime. This is the core safety guarantee, and it costs one extra snapshot.
- **Only touch the confirmed file list.** No `git reset --hard`, no `git clean`, no `git checkout .`. The user's real index and HEAD are never moved.
- **Dirty tree not made by the agent** (non-isolated standalone session in the repo folder, with the user's own uncommitted edits): those edits appear under "You changed these after the agent" only if they touch files in the agent's diff; other files are never touched, because the restore set is derived from the agent's own diff (`before` to latest `after`), not from the whole tree.
- **Concurrent edits while idle** (user in an editor): conflicts list above; default unchecked.
- **Agent running**: preview and restore return 409 ("Stop the agent first"); same as `chat` does for `/clear`.
- **Snapshot was skipped** (timeout, no git, not a repo): the row has `before: null`; no Rewind button, with tooltip "Not available for this message".
- **Branch moved** (the agent committed, rebased or switched branch during a turn): file content restore still works (it is tree-based), but HEAD stays where it is. The sheet shows "The agent made N commits since this point; they stay in git history. Only files change." Never move HEAD automatically; offer "Show commits" instead. This is the case where the PR/branch state could diverge from the files, so keep it a plain warning.
- **Pushed or PR already opened**: warn that remote is unchanged.
- **Deleted worktree or missing refs** (ticket cleanup, manual `git gc --prune=now` after refs removed): `before` commit not found, so button hidden and endpoint returns 410.
- **Non-files side effects**: DB changes, installed packages, network calls, pushed commits cannot be undone. The sheet says "Only files in the folder are restored."
- **Symlinks and hard links**: restore writes through paths; use `git checkout-index` semantics and skip symlinks whose target is outside the dir (Claude itself skips them: docs above).
- **Permissions/exec bit** are carried by the tree mode, restored with the file.
- **Codex conversation**: no verified way to truncate a thread headless. Options when the owner wants it: (a) restore files only, then the next message tells Codex what was reverted via the normal prompt ("Files were rolled back to the state before <message>. Ignore later edits."); (b) start a new Codex thread seeded with the transcript up to turn N (new session, loses Codex's own context caching). Recommend (a) first.

## A7. Feasibility summary

| Capability | Claude | Codex |
|---|---|---|
| Restore files, including Bash edits (board snapshots) | Yes | Yes |
| Restore conversation to message N | Probably (`--resume-session-at --fork-session`, to be spiked) | Not verified; use prompt note or new thread |
| Native file checkpoints | Edit/Write only, needs env set at run time | Not documented for `exec` |

## A8. Phased plan

- **Phase 0 (S, 0.5 day): spike.** On a throwaway session in a temp repo, verify: replay events carry `uuid`; `--resume-session-at <uuid> --fork-session` in `-p` stream-json mode (which uuid kind it accepts, whether the fork's history is truncated, whether the original is intact); how long `snapshot()` takes on this repo and the biggest repo the owner uses. Cheap insurance before any UI.
- **Phase 1 (M, 2-3 days): file snapshots + restore for both agents.** New `src/server/checkpoints.ts` (snapshot, preview, restore, prune), rows in `checkpoints.jsonl` via `store.ts`, calls in `board.ts` `executeOnce`, two endpoints in `http.ts`, sheet in `web/src/Chat.tsx`.
- **Phase 2 (M, 2 days): Claude conversation rewind.** Extra arg handling in `buildArgs` (`--resume-session-at`, `--fork-session`), switch `ticket.sessionId`, UI "Restore files and conversation".
- **Phase 3 (S-M): polish.** Undo toast from the `pre-restore` ref, pruning old refs, Codex wording, notice when snapshots are skipped, "Show commits since".
- **Phase 4 (L, optional): Codex conversation truncation** only if Codex documents or ships a supported way; otherwise skip.

## A9. Tests needed

- `checkpoints.test.ts` using temp git repos (pattern as `test/git.test.ts`): snapshot includes untracked, excludes ignored, leaves the real index and HEAD untouched (compare `git status --porcelain` and `git rev-parse HEAD` before and after).
- Restore: modified file reverted; agent-created file deleted; deleted file restored; exec bit kept; a file the user edited after the agent is listed as conflict and untouched unless selected; `pre-restore` ref exists and Undo returns the exact prior tree.
- Dirty tree: user's unrelated uncommitted file stays byte-identical after restore.
- Worktree case (refs shared with the main repo) and a repo with no commits.
- Timeout path: slow snapshot produces `before: null` and no crash.
- HTTP: 409 while running, 410 when ref missing, bad turn returns 404.
- Board: row written before start and `after` filled at end; steered mid-run messages produce no row.
- Claude args: `buildArgs` unit test for the new flags (pattern in `test/command-options.test.ts`).
- Manual phone check with Playwright against a dev board on another port (not 7777): run, edit via Bash, rewind, verify file bytes.

---

# Part B. A third agent

## B1. Candidates (verified from docs unless marked)

| | OpenCode | Gemini CLI |
|---|---|---|
| Headless run | `opencode run "<prompt>"`, `--format json` gives "raw JSON events" ([CLI docs](https://opencode.ai/docs/cli/)) | `-p/--prompt`, `--output-format text\|json\|stream-json` ([cli-reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md)) |
| Event format documented? | **No schema found** for `--format json` (**UNVERIFIED**); HTTP/SSE API is OpenAPI-documented ([server docs](https://opencode.ai/docs/server/)) | Yes, stream-json types: `init`, `message`, `tool_use`, `tool_result`, `error`, `result` ([headless doc](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md)) |
| Session id + resume | `--session/-s <id>`, `--continue/-c`, `--fork`; `opencode session list --format json` | `--resume latest\|<index>\|<uuid>`; `init` event carries the session id ([session mgmt](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md)) |
| Where sessions live | `~/.local/share/opencode/project/<slug>/storage/` (format not documented, [troubleshooting](https://opencode.ai/docs/troubleshooting/)); `opencode export [sessionID]` gives JSON | `~/.gemini/tmp/<project_hash>/chats/` |
| Read-only / permissions | Permission config `allow/ask/deny` per tool (`read`, `edit`, `bash`, ...), env `OPENCODE_PERMISSION` inline JSON; `--auto` auto-approves non-denied ([permissions](https://opencode.ai/docs/permissions/)). A read-only config = deny `edit` and `bash` | `--approval-mode default\|auto_edit\|yolo\|plan`; `plan` is the read-only candidate (**UNVERIFIED** it blocks shell writes headless); `--sandbox` boolean |
| MCP | `mcp` key in `opencode.json`, `type: "local"` with `command` array ([MCP docs](https://opencode.ai/docs/mcp-servers/)). Fits `ckanban mcp` | `mcpServers` in settings.json (**UNVERIFIED**, I did not fetch the MCP page) |
| Model choice | `--model provider/model`, `--variant` for effort | `--model/-m` |
| Rewind in its own API | Server has `POST /session/:id/revert`, unrevert, `POST /session/:id/fork`, `GET /session/:id/diff` | Interactive `/restore` from checkpoints, disabled by default |
| Exit codes | not checked | 0, 1, 42 (input error), 53 (turn limit) |
| Installed here | No (`which opencode gemini` both empty), nothing was run | No |

## B2. Recommendation

**Pick OpenCode as the third agent, but integrate it through `opencode serve` (HTTP + SSE), not by parsing `opencode run --format json`.**

Why: the HTTP API is the documented, typed surface (OpenAPI at `/doc`, SSE at `/event`); `--format json` has no documented schema, which is the biggest risk named in the task. OpenCode is also truly multi-LLM (`provider/model`), which is the point of the app, whereas Gemini CLI is single-vendor. It also has revert/fork endpoints that could later back Part A for that agent.

Honest runner-up: **Gemini CLI is the cheaper integration** (documented stream-json, one process per turn like Codex today, same shape as `codex-runner.ts`) but it locks to one vendor, and its headless read-only mode is unverified. If the owner wants the smallest effort and a quick third logo, choose Gemini; if the owner wants real multi-LLM, choose OpenCode. I recommend OpenCode, with a half-day spike first because I could not run either tool.

## B3. Integration plan (OpenCode via serve)

Step 0 (spike, S): install OpenCode on a scratch machine/user (not done here), start `opencode serve --port <p>`, with `OPENCODE_SERVER_PASSWORD` set. Record real events from `/event` for one prompt with a file edit, a bash call and an error. Check: does permission `ask` block headless, how a stop is signaled (`POST /session/:id/abort`), whether MCP servers connect, what token/cost data arrives.

1. `src/server/types.ts`: `agent?: "claude" | "codex" | "opencode"`; add `opencodeSessionId`, `opencodeModel` (model string `provider/model`). Prefer one generic `agentSessionId` later, but keep the existing Codex fields untouched in this change.
2. `src/server/agents.ts`: extend `AgentId`/`AGENT_IDS`; status for OpenCode (`which opencode`); register `ckanban` MCP by editing `opencode.json` `mcp.ckanban = { type: "local", command: [...serverArgv], enabled: true }` (JSON, simpler than the TOML editing done for Codex). Config file location: **UNVERIFIED** (check `~/.config/opencode/opencode.json` in spike).
3. New `src/server/opencode-runner.ts`: same `RunHandle` contract as `runner.ts` (`done`, `stop`, `send`, `stopped`). Start (or reuse) one `opencode serve` child per board, `POST /session` or reuse id, `POST /session/:id/message`, subscribe to `/event`, translate parts into the Claude-shaped events the UI already understands (text, `tool_use` Bash/Edit, `tool_result`, final `result`), exactly as `codex-runner.ts` does. `stop()` calls abort then kills the group like `killGroup`. `send()` can return true (HTTP allows mid-run messages; **UNVERIFIED** semantics) or false like Codex.
4. `src/server/board.ts` `executeOnce`: the `codex` boolean becomes a three-way switch picking the launcher and args (today: `const codex = t.agent === "codex"` and `launch = codex ? startCodexRun : startRun`). The 44 `"codex"` branches (see top) each need a decision: queue behaviour (`active` steering is disabled for Codex), session reset in `clearConversation`, `sessionStarted`, notices. This is the real cost; budget for it.
5. `src/server/opencode-session.ts` (parallel to `codex-session.ts`): the UI transcript. Either map stored events from `activity.jsonl` (what Codex does when no rollout is found) or call `GET /session/:id/message` and map to `SessionEntry`. Prefer the API; do not parse the undocumented storage folder.
6. Permissions mapping: `access: "read"` or refine mode = `OPENCODE_PERMISSION='{"edit":"deny","bash":"deny"}'` style deny (exact schema from permissions docs; verify in spike) plus no `--auto`; write mode = `--auto`/allow. Plan-mode and `bypassPermissions` equivalents must be tested, not assumed.
7. `http.ts`, `ticket-metadata.ts`, `ticket-cli.ts`, `usage*.ts`, `notifications.ts`, `attention.ts`, `main.ts`: accept the new value; usage/cost needs the event fields (UNVERIFIED).
8. Web: `AgentMark.tsx` and `icons.tsx` (new mark), `NewTicketDialog.tsx`, `TicketMetadata.tsx`, `AgentSettings.tsx`, `DefaultModelsDialog.tsx`, `ConnectionsDialog.tsx`, `Card.tsx`, `SlashCommands.tsx` (OpenCode slash commands differ; start with none), `Sessions.tsx` (session list from `opencode session list --format json`), `api.ts`, `styles.css`.
9. Tests: copy the `codex-runner` tests with a fake `opencode` HTTP server; a recorded-fixture test per event type; `agents.test.ts` for the config editing; a read-only guarantee test (see risks).

## B4. Risks

- **Undocumented event format** (`--format json` has no schema; SSE event names beyond `server.connected` were not in the docs I could read). Mitigation: record real fixtures in the spike, pin a tested OpenCode version, show "update/downgrade OpenCode" error like `readableError` does for Codex model mismatches.
- **Read-only guarantee.** Today Codex read-only is enforced by an OS sandbox (`sandbox_mode="read-only"`). OpenCode's is application-level permission rules; a `bash` allow would be an escape. Keep `bash: deny` in read mode and add a test that a write attempt is refused. Until verified, label OpenCode tickets read-only as "best effort" in the UI or disable read mode for them.
- **A long-running server** is a new thing for the board to supervise (port, auth password, crashes, orphan processes after a board restart). `runner.ts` already groups and kills child process trees; reuse that.
- **Auth/billing**: OpenCode uses provider API keys or subscriptions held in `~/.local/share/opencode/auth.json`; the board must never log them.
- **Hard-coded two-agent assumptions** (44 branches) can silently treat the new agent as Claude. Mitigate by changing `agent` checks to a lookup table (only after the second concrete caller exists, which is now true) and typechecking exhaustively.
- **MCP tool names** differ per agent; prompts that mention `mcp__ckanban__*` need per-agent wording (**UNVERIFIED** how OpenCode names them).
- **Rewind** (Part A) will not work for OpenCode in phase 1 beyond file snapshots; its native `revert` could be added later.

## B5. Phased plan

- **B-0 (S, 0.5-1 day): spike** described in step 0. Output: recorded events, working MCP, read-only test, decision go/no-go.
- **B-1 (M, 3-4 days): refactor seam.** Replace `agent === "codex"` branches with an agent lookup in `board.ts` and the web; no behaviour change; existing tests stay green. This is the prerequisite for any third agent and is also needed if the owner picks Gemini.
- **B-2 (L, 5-7 days): OpenCode runner, session mapper, permissions, MCP registration, settings UI, mark, new-ticket picker.**
- **B-3 (M, 2-3 days): sessions list, usage/cost, slash commands, notifications, polish, docs in `docs/install-ai.md`.**
- Gemini alternative: B-1 plus about 4 days (stream-json is documented, one process per turn).

---

# Decisions the owner must make

1. **Rewind scope**: files only everywhere (safe, fast, both agents) or also conversation rewind for Claude (needs the Phase 0 spike to pass)?
2. **Snapshot cost**: OK to add one `git add -A` into a temp index before and after every turn? Limit for huge repos (skip after 10 s)? Keep last 50 turns?
3. **Ignored files**: confirm they stay untouched (no restore of `node_modules` or `.env`).
4. **Non-isolated sessions** (working in the real repo folder): allow rewind there at all, given the user's own edits live in the same tree? Default recommendation: yes, with the conflicts list unchecked by default.
5. **Codex conversation**: accept files-only plus a "files were rolled back" note, or invest in a seeded new thread?
6. **Third agent**: OpenCode (real multi-LLM, serve API, undocumented JSON events) or Gemini CLI (documented stream-json, one vendor)? Or wait for a spike first?
7. **Read-only for the third agent**: ship with application-level permissions (best effort) or disable read mode for it until proven?
8. **Refactor first**: approve the B-1 seam refactor (removes 44 branches) before adding any agent. It touches many files and conflicts with parallel work, so it should be scheduled when other agents are not editing `board.ts`.
9. **Where to try it**: confirm that spikes run on a dev board on another port and a scratch repo, never the live 7777 board.

## Not verified (summary)

`--resume-session-at` and `--rewind-files` semantics (flags accepted by the parser only); `--fork-session` with truncation in print mode; replay events carrying `uuid` in stream-json mode; any Codex headless undo/truncate; OpenCode `--format json` schema, SSE event names, config path, read-only strength, MCP tool naming; Gemini `plan` mode and MCP config; all behaviour of tools not installed here (`codex`, `opencode`, `gemini`). The Codex ghost-commit detail came from a web search summary of a repository mirror, not from OpenAI docs.
