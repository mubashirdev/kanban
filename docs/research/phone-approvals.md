# Approving risky agent actions from the phone

Status: research, nothing built. Date: 2026-10-07. Versions checked: Claude Code 2.1.292, Codex CLI 0.160.0 (the copy bundled in ChatGPT.app; no `codex` on PATH).
Legend: [docs] = official page read today, [local] = ran `--help` or generated the schema on this Mac, [code] = repo file, [UNVERIFIED] = not confirmed.

## 1. What the board does today [code]

- Claude: `buildArgs` passes `--permission-mode bypassPermissions` for edit runs, `plan` for refine runs (src/server/runner.ts:33,44). Prompts go in on stdin as stream-json, so steering already works (runner.ts:49-70).
- Codex: `codexArgs` passes `approval_policy="never"` and `sandbox_mode` = `read-only` (refine) or `workspace-write` plus network on (src/server/codex-runner.ts:17-22). One `codex exec` process per prompt; later messages wait in the board queue (codex-runner.ts:50).
- Every run gets the board's MCP server `ckanban mcp` through `--mcp-config` and an env var `CKANBAN_TICKET=<slug>/<id>` (board.ts:427-431). That server is a stdio process that already long-polls the daemon for `ask_ticket` and caps the wait using `MCP_TOOL_TIMEOUT` (src/mcp-server.ts:94-100).
- Push payloads carry no ticket titles on purpose (notifications.ts:219). Chat already renders a `QuestionsForm` card (web/src/Chat.tsx:476) and `Modal sheet` is the bottom-sheet component (web/src/Modal.tsx, used by CardActions.tsx:17).
- Auth: requests from loopback are NOT authenticated; LAN requests need the cookie (src/server/lan.ts:113-120). This matters in section 5.

## 2. What the agents can really do

### Claude Code (all [docs] unless noted)
- `--permission-prompt-tool <mcp tool>`: "Specify an MCP tool to handle permission prompts in non-interactive mode"; Claude waits for that MCP server to connect first (30 s `MCP_TIMEOUT`). https://code.claude.com/docs/en/cli-reference
- `--permission-prompts host|none` (v2.1.259+): `host` sends prompts to the SDK host or the prompt tool; `none` auto-denies. Present in `claude --help` [local]. https://code.claude.com/docs/en/headless
- `--permission-mode`: `acceptEdits | auto | bypassPermissions | manual | dontAsk | plan` [local]; the docs also list `default` (alias of `manual`).
- Decision shape (SDK `canUseTool`, same semantics): allow = `{behavior:"allow", updatedInput?, updatedPermissions?}`, deny = `{behavior:"deny", message, interrupt?}`. "The callback can stay pending indefinitely." https://code.claude.com/docs/en/agent-sdk/user-input and /agent-sdk/typescript
- Evaluation order: hooks, deny rules, ask rules, mode, allow rules, then the prompt. `bypassPermissions` approves everything that reaches the mode step, so with today's flags nothing ever asks. Deny rules and hooks still apply in bypass mode. `acceptEdits` auto-approves edits and `mkdir/touch/rm/mv/cp/sed` only inside the working dir and added dirs; Bash and network still prompt. https://code.claude.com/docs/en/agent-sdk/permissions
- Hooks: `PermissionRequest` hooks "do fire in `-p` mode" and can answer `{hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"allow"|"deny",updatedInput?}}}`; command/http hooks default to 600 s timeout. `PreToolUse` can return `allow|deny|ask|defer`; `defer` stores the call, exits, and the call is restored with `--resume`. https://code.claude.com/docs/en/hooks
- A prompt tool cannot approve an MCP tool flagged `requiresUserInteraction` (allow becomes deny). SIGTERM while a prompt is pending leaves it unanswered; the process exits 143 (headless page).
- [UNVERIFIED] The exact JSON the MCP prompt tool receives and must return. Docs name the option and the result type, but the MCP wire format (`tool_name`, `input`, `tool_use_id` in; a JSON text result out) was not on any page I read. Spike needed before building (phase 0).
- [UNVERIFIED] Whether `stream-json` stdin/stdout carries SDK control requests we could answer directly (the SDK's `requestId` doc says "echo this in any external control response"). Not documented as a CLI contract; do not rely on it.

### Codex
- `codex exec` options [local]: `-s/--sandbox read-only|workspace-write|danger-full-access`, `--approve-for-me` ("automatic review"), `--dangerously-bypass-approvals-and-sandbox`. There is no per-command human approval flag on `exec`. Top-level `-a/--ask-for-approval` lists `on-request`, `never` (same help text).
- Config policies [docs]: `on-request`, `never`, retired `untrusted`, and `{granular={...}}` per category (`sandbox_approval`, `rules`, `mcp_elicitations`, `request_permissions`, `skill_approval`). Sandbox network is off by default. https://learn.chatgpt.com/docs/agent-approvals-security (old URL developers.openai.com/codex/agent-approvals-security redirects here)
- [UNVERIFIED] What `codex exec` does if `approval_policy="on-request"` and the model asks: no doc found. Assume it auto-declines or hangs; must be tested.
- `codex app-server` is the only documented human-approval channel: marked `[experimental]` in `--help` [local]; JSON-RPC over `stdio://` (default), `unix://`, `ws://IP:PORT` with `--ws-auth capability-token|signed-bearer-token`; client must send `initialize` then `initialized`. https://learn.chatgpt.com/docs/app-server
- I generated the schema with `codex app-server generate-json-schema` [local] and confirmed server-to-client requests `item/commandExecution/requestApproval` (params include `command`, `cwd`, `reason`, `threadId`, `turnId`, `itemId`, `approvalId`, `networkApprovalContext`), `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`. Command decisions: `accept`, `acceptForSession`, `acceptWithExecpolicyAmendment`, network-rule variant, `decline` (agent continues), `cancel` (turn interrupted). Client methods include `thread/resume` and `turn/start` (params include `approvalPolicy`, `sandboxPolicy`, `cwd`, `model`, `effort`). Because the schema is regenerated per CLI version, pin and regenerate it in CI.
- `codex mcp-server` is not listed in 0.160.0 `--help` [local]; I did not pursue it.

## 3. Candidate architectures

**A. Claude via `--permission-prompt-tool` + Codex via `codex app-server`** (recommended long term)
Claude: switch edit runs to `--permission-mode acceptEdits` (or `manual`), add `--permission-prompt-tool mcp__ckanban__approve`, plus an allow list for harmless read-only commands. The tool lives in the existing `ckanban mcp` server and long-polls the daemon like `ask_ticket`. Codex: replace `codex exec` with one `codex app-server` child per run, `thread/resume` with the stored `codexSessionId`, `turn/start` with `approvalPolicy:"on-request"`, answer `item/*/requestApproval` over the board approval queue. Pros: the same mechanisms the official apps use, real allow/deny/session choices. Cons: Codex runner rewrite on an experimental protocol; MCP prompt format needs a spike.

**B. Claude via `PermissionRequest` hook (command/http hook), Codex unchanged**
Pass `--settings '{"hooks":{"PermissionRequest":[...]}}'` (already done for `outputStyle`, runner.ts:46). The hook script calls the daemon and blocks up to its timeout. Pros: no MCP-format uncertainty (hook JSON is documented), documented to fire in `-p`. Cons: hooks from user/project settings also load, so a repo can add its own; same Codex gap. Good fallback if the spike in phase 0 fails.

**C. Wrapper only: keep bypass, add deny rules + `PreToolUse defer`**
Hard-deny a risky list (`--disallowedTools "Bash(rm *)" ...`) and defer the rest. Cheap, but deny lists are bypassable (docs: rules match "as written", `/bin/rm` falls through) and `defer` ends the run, so it is not an interactive approval. Not recommended.

**Recommendation:** A for Claude first, implemented as the MCP tool with B as the fallback; Codex later via app-server, or not at all if the owner accepts "Codex stays sandboxed, no prompts" (sandbox workspace-write already blocks edits outside the folder; network is the gap).

## 4. Data flow (agent asks, phone answers)

1. Claude wants `Bash: git push`. Mode and rules do not auto-approve, so Claude calls `mcp__ckanban__approve` with tool name, input, tool-use id.
2. `ckanban mcp` (env `CKANBAN_TICKET`) POSTs `/api/approvals` to the daemon: `{slug, ticketId, runNo, tool, input, toolUseId}`. Daemon creates `{id (random 128-bit), status:"pending", createdAt, expiresAt}` in memory and `approvals.json`, emits a bus event `approval.requested`; the ticket shows "Needs approval" (new attention kind in attention.ts).
3. The MCP tool long-polls `GET /api/approvals/:id` (same loop as `ask_ticket`). The run stays alive, the board holds it as running.
4. Push (notifications.ts): title "Muba AI", body "Claude needs your approval." plus a URL to the ticket. Nothing else.
5. Phone opens the ticket, Chat renders an approval card and opens a bottom sheet (section 8). Tap sends `POST /api/approvals/:id {decision}` with `allow-once | allow-session | deny (+ optional note)`.
6. Daemon validates (section 5), stores the decision, the poll returns it. The tool returns `{behavior:"allow", updatedInput: <original input>}` or `{behavior:"deny", message:"User denied: <note>"}`. For allow-session the daemon keeps an in-memory rule for this run, `tool + normalized command prefix`, and auto-answers matching later requests. Never write rules to settings files.
7. Claude continues. Activity log gets a line "Approved git push (phone, 14:02)".

Codex differs only at steps 1-3 and 6: the board's app-server client receives `item/commandExecution/requestApproval` and replies `{decision:"accept"|"acceptForSession"|"decline"}`; no MCP tool involved.

## 5. Timeouts and "phone never answers"

- Pending request expires after 10 minutes by default (matches `ask_ticket` and the hook default of 600 s). The MCP tool wait must stay below `MCP_TOOL_TIMEOUT` minus 15 s, reuse `askWaitMs`.
- On expiry: auto-deny with message "Nobody approved this in time; do not retry, report that you are blocked." The run does not hang and ends normally; ticket shows "Needs your approval (expired)" with a Retry button that resumes the session with a steer message.
- Daemon restart or run stop: pending approvals become `cancelled`; the child process is killed anyway (runner.ts stop sends SIGTERM to the group). On recovery the board already re-answers queued work; do not auto-resume an approval.
- Reminder push once at 5 minutes (same tag, replaces the first). No repeat spam.
- Default is always deny. Never auto-approve on timeout.

## 6. Security (this is a remote-code-execution gate)

- **The agent is on the same machine and is not trusted with this decision.** Loopback requests are unauthenticated today (lan.ts:113-120), so a Bash-capable agent could `curl -X POST 127.0.0.1:7777/api/approvals/<id>` and approve itself. The approve endpoint must reject loopback peers and require the phone credential (LAN cookie or passkey session from public-auth.ts), and the id alone must never be enough. Also reject requests from the run's own process by requiring the LAN/public session even when `trustedNetwork` applies (lan.ts:120). Test: agent-side curl gets 403.
- The agent can read the board data dir unless it is outside the sandbox: keep `approvals.json` unreadable-by-design (it only holds pending metadata, no secrets) and do not put the decision secret in the run env.
- Replay/spoofing: ids are random, single-use, bound to `{slug, ticketId, runNo, toolUseId, hash(input)}`. The decision applies only if the pending hash still matches what the phone displayed; `allow` is rejected after expiry or after a first decision (409).
- The agent chooses what the phone shows. Render the raw command in a monospace block, never as markdown or HTML, show cwd and "outside folder" flags, truncate long commands visibly (not silently), strip control characters, and show the agent's `description` field only as secondary text.
- Allow-session scope: exact tool plus command prefix up to the first shell metacharacter; never `Bash(*)`. Compound commands (`a && b`, pipes, `$(...)`) require once-only.
- Push payload: no command text, no paths, no ticket title (consistent with notifications.ts:219). Lock-screen visible, so only "needs your approval".
- Hooks and MCP in the repo can interfere: use `--strict-mcp-config` with the board's config for edit runs, and note that project settings hooks still load in `-p` (headless page). Deny rules and `PermissionRequest` hooks from managed settings win; document that.
- Public/passkey access: approvals reuse existing sign-in; no new token type. Consider requiring a recent passkey touch for "Allow for session".
- Audit: store who/when/decision/command in the ticket activity; keep 30 days.

## 7. Interaction with Read only / Can edit and worktrees

- "Read only" (refine/plan, Codex `read-only`) already blocks writes; approvals would only add noise. Keep it as is. If the agent asks anyway in plan mode, Claude routes edits to the prompt tool, so the tool must deny edits with "read-only session" without notifying the phone.
- "Can edit" today = bypass. Proposed third level, "Ask first" (decision 1), between the two; "Can edit" stays bypass for people who want it.
- Worktrees: cwd is the worktree, so `acceptEdits` auto-approves edits there, and only shell commands, network, and paths outside the worktree prompt. Git commits from a worktree write to the main repo's `.git`; Claude may prompt for `git commit` (Bash) which is expected. Codex's `writableRoots` already includes the git common dir (board.ts:415-418), so those do not escalate.
- Standalone sessions (`t.standalone`) use the same flow; `sessionPrompt(access)` should tell the agent it may be asked to wait for the user.

## 8. UI sketch (reuses `Modal sheet`)

```
Chat card (inline, like QuestionsForm)        Bottom sheet on tap / push
+--------------------------------+             +--------------------------------+
| Claude wants to run a command  |             | Approve command?          [x]  |
| git push origin feat/x   [View]|             | Claude · ticket t_2026..       |
| waiting 2:10 · expires 7:50    |             | ------------------------------ |
+--------------------------------+             | git push origin feat/x         |
                                               | in /Users/me/repo (worktree)   |
                                               | network: yes  outside folder:no|
                                               | Note to Claude (optional)  [ ] |
                                               | [ Allow once ]                 |
                                               | [ Allow for session ] (prefix) |
                                               | [ Deny ]                       |
                                               +--------------------------------+
```
Deny is the default focus; "Allow for session" is hidden for compound commands. Expired card shows greyed "Expired, Claude was told no".

## 9. Phased plan, effort, tests

| Phase | Scope | Effort | Tests |
|---|---|---|---|
| 0 Spike | Throwaway MCP tool; run `claude -p --permission-prompt-tool` against it to record the exact request and response JSON; test the `PermissionRequest` hook as fallback; test `codex exec -c approval_policy="on-request"` behavior | S | Recorded fixtures checked into test/ |
| 1 Claude only, once/deny | `approvals` store + REST, `approve` MCP tool, long-poll, new access level "Ask first", push, chat card + sheet, 10 min expiry | M | Unit: store state machine, expiry, hash binding, loopback rejected, push payload has no command. Integration: fake claude emitting a tool request. Manual on a real phone through LAN and public URL |
| 2 Allow for session | Per-run prefix rules, compound-command refusal, activity audit | S | Rule matching table tests (metacharacters, `/bin/rm`, quoting) |
| 3 Codex | `codex app-server` runner behind a flag, `thread/resume`, `turn/start` with `on-request`, map decisions, pin and regenerate schema in CI | L | Contract test against generated JSON schema; fake app-server over stdio; manual run on 0.160.0 |
| 4 Polish | Reminder push, "network only" granular policy, per-board defaults | S | Existing notification tests extended |

Phase 1 is the smallest useful thing. If the owner mainly uses Codex, phase 3 is the real cost and phase 1 delivers nothing for those tickets.

## 10. Decisions for the owner

1. Add an "Ask first" access level (recommended) or change what "Can edit" means for everyone?
2. Which actions ask: shell commands outside a safe read-only list, edits outside the folder, network; and is "inside the worktree" always silent?
3. Claude first only (phase 1-2), or also fund the Codex rewrite on an experimental protocol (phase 3, L)?
4. Timeout: 10 minutes then deny (recommended), or a longer window, or pause the run instead of denying?
5. Is "Allow for session" worth its risk, and should it require a fresh passkey touch?
6. Reject all loopback approvals (safest; the desktop board would need its own signed-in session) or allow desktop approvals via the existing local trust?
7. Can the board accept that repo-level or user hooks and MCP servers are disabled for these runs (`--strict-mcp-config`, `--setting-sources`), which changes behavior some users rely on?
