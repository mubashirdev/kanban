import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { Profile, Ticket } from "./types";
import type { Store } from "./store";

const LIMIT = 2 * 1024 * 1024;
/** Read-only inspection: no external diff drivers, text conversions, hooks, or test execution. */
export async function reviewCommand(command: string[], cwd: string) {
  try {
    const process = Bun.spawn(command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...globalThis.process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    let truncated = false;
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader(),
        decoder = new TextDecoder();
      let text = "",
        bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > LIMIT) {
          truncated = true;
          process.kill();
          break;
        }
        text += decoder.decode(value, { stream: true });
      }
      return text;
    };
    const timer = setTimeout(() => process.kill(), 10000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        process.exited,
        read(process.stdout),
        read(process.stderr),
      ]);
      return { code, stdout, stderr, truncated };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return {
      code: -1,
      stdout: "",
      stderr: (e as Error).message,
      truncated: false,
    };
  }
}

export async function ticketReview(
  profile: Profile,
  ticket: Ticket,
  store: Store,
  file?: string,
  inspect = reviewCommand
) {
  const cwd = ticket.workdir ?? ticket.worktree ?? profile.path;
  const available =
    existsSync(cwd) &&
    (
      await inspect(["git", "rev-parse", "--is-inside-work-tree"], cwd)
    ).stdout.trim() === "true";
  let base = "HEAD",
    files: { path: string; status: string }[] = [],
    diff = "",
    truncated = false,
    warning: string | null = null;
  if (available) {
    // A worktree is compared with its merge base. Shared folders show uncommitted changes only.
    if (
      ticket.worktree &&
      profile.baseBranch &&
      !profile.baseBranch.startsWith("-")
    ) {
      const merge = await inspect(
        ["git", "merge-base", "HEAD", profile.baseBranch],
        cwd
      );
      if (merge.code === 0 && /^[a-f0-9]+$/.test(merge.stdout.trim()))
        base = merge.stdout.trim();
      else warning = "Base branch unavailable; showing changes against HEAD.";
    }
    // Disable rename detection below so each changed path has a simple status/path pair.
    const names = await inspect(
      [
        "git",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-status",
        "-z",
        base,
        "--",
      ],
      cwd
    );
    const fields = names.stdout.split("\0").filter(Boolean);
    for (let i = 0; i < fields.length; i += 2)
      if (fields[i + 1]) files.push({ status: fields[i], path: fields[i + 1] });
    const untracked = await inspect(
      ["git", "ls-files", "--others", "--exclude-standard", "-z"],
      cwd
    );
    for (const path of untracked.stdout.split("\0").filter(Boolean))
      files.push({ path, status: "?" });
    if (file) {
      const entry = files.find((item) => item.path === file);
      if (!entry) throw new Error("Choose a changed file");
      if (entry.status === "?") {
        if (lstatSync(join(cwd, file)).isSymbolicLink())
          diff =
            "New symbolic link. Inspect its target locally before staging.";
        else {
          const result = await inspect(
            [
              "git",
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--no-index",
              "--unified=3",
              "--",
              "/dev/null",
              file,
            ],
            cwd
          );
          diff = result.stdout;
          truncated = result.truncated;
          if (result.code > 1) warning = "Could not read this new file.";
        }
      } else {
        const result = await inspect(
          [
            "git",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--unified=3",
            base,
            "--",
            file,
          ],
          cwd
        );
        diff = result.stdout;
        truncated = result.truncated;
        if (result.code !== 0) warning = "Could not read this diff.";
      }
    }
    if (names.code !== 0)
      warning = "Git inspection failed. Refresh or open Terminal & files.";
  } else warning = "No Git checkout is available for this ticket.";
  if (available && !ticket.worktree && !ticket.workdir)
    warning =
      warning ??
      "Shared repository: showing current uncommitted changes. Other tickets may also have changed these files.";
  let checks: { name: string; state: string; url: string | null }[] = [],
    checkError: string | null = null;
  if (ticket.prUrl && !file) {
    const response = await inspect(
      ["gh", "pr", "view", ticket.prUrl, "--json", "statusCheckRollup"],
      cwd
    );
    if (response.code !== 0)
      checkError =
        "GitHub checks unavailable. Check gh sign-in and repository access.";
    else
      try {
        const value = JSON.parse(response.stdout);
        checks = (value.statusCheckRollup ?? []).map((check: any) => ({
          name: String(check.name ?? check.context ?? "Check"),
          state: String(
            check.conclusion || check.state || check.status || "UNKNOWN"
          ),
          url:
            typeof (check.detailsUrl ?? check.targetUrl) === "string" &&
            /^https:\/\//.test(check.detailsUrl ?? check.targetUrl)
              ? check.detailsUrl ?? check.targetUrl
              : null,
        }));
      } catch {
        checkError = "GitHub returned an unreadable check result.";
      }
  }
  const activity = store.readActivity(profile.slug, ticket.id);
  const lastIndex = activity.findLastIndex(
    (entry) => entry.event?.type === "result"
  );
  const last = lastIndex >= 0 ? activity[lastIndex].event : null;
  const prior = activity
    .slice(0, lastIndex)
    .findLastIndex((entry) => entry.event?.type === "result");
  const tools = new Map<string, string>(),
    recordedChecks: { command: string; state: string; output: string }[] = [];
  for (const entry of activity.slice(prior + 1, lastIndex + 1)) {
    const content = entry.event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block.type === "tool_use" &&
        block.name === "Bash" &&
        typeof block.input?.command === "string" &&
        /\b(test|tsc|lint|typecheck|build)\b/.test(block.input.command)
      )
        tools.set(block.id, block.input.command);
      if (block.type === "tool_result" && tools.has(block.tool_use_id))
        recordedChecks.push({
          command: tools.get(block.tool_use_id)!.slice(0, 1000),
          state: block.is_error ? "failed" : "completed",
          output:
            typeof block.content === "string" ? block.content.slice(-2000) : "",
        });
    }
  }
  const metric = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  return {
    files,
    diff,
    truncated,
    warning,
    checks,
    checkError,
    hasPr: !!ticket.prUrl,
    recordedChecks: recordedChecks.slice(-20),
    verification: last
      ? {
          summary:
            typeof last.result === "string"
              ? last.result
                  .replace(/^.*CKANBAN_RESULT:.*$/gm, "")
                  .trim()
                  .slice(-6000)
              : "",
          durationMs: metric(last.duration_ms),
          costUsd: metric(last.total_cost_usd),
        }
      : null,
  };
}
