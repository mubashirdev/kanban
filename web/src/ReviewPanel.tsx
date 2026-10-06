import { useEffect, useState } from "react";
import { api, safeHref, type Ticket } from "./api";
import { Markdown } from "./Transcript";
import { RefreshIcon, ExternalIcon, CheckIcon } from "./icons";
export function ReviewPanel({
  slug,
  ticket,
  onError,
  onOutputs,
}: {
  slug: string;
  ticket: Ticket;
  onError: (error: string) => void;
  onOutputs: () => void;
}) {
  const [data, setData] = useState<Awaited<
      ReturnType<typeof api.review>
    > | null>(null),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0),
    [file, setFile] = useState(""),
    [diff, setDiff] = useState(""),
    [loadingDiff, setLoadingDiff] = useState(false),
    [note, setNote] = useState(""),
    [sending, setSending] = useState(false),
    [accepting, setAccepting] = useState(false);
  useEffect(() => {
    let active = true;
    setError("");
    api
      .review(slug, ticket.id)
      .then((value) => {
        if (active) {
          setData(value);
          setFile((current) =>
            value.files.some((f) => f.path === current) ? current : value.files[0]?.path ?? ""
          );
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [slug, ticket.id, refresh, ticket.runCount]);
  useEffect(() => {
    let active = true;
    if (!file) {
      setDiff("");
      return;
    }
    setLoadingDiff(true);
    api
      .review(slug, ticket.id, file)
      .then((value) => {
        if (active) {
          setDiff(
            value.diff +
              (value.truncated
                ? "\n[Diff truncated. Open the full change locally.]"
                : "")
          );
        }
      })
      .catch((e) => {
        if (active) {
          setDiff("");
          setError(e.message);
        }
      })
      .finally(() => {
        if (active) setLoadingDiff(false);
      });
    return () => {
      active = false;
    };
  }, [slug, ticket.id, file, refresh]);
  const request = async () => {
    if (!note.trim() || sending) return;
    setSending(true);
    try {
      await api.chat(
        slug,
        ticket.id,
        "Review feedback — please address these changes and verify the result:\n\n" +
          note.trim()
      );
      setNote("");
    } catch (e: any) {
      onError(e.message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="review-panel">
      <div className="workspace-heading">
        <h2>{ticket.standalone ? "Changes in the repo" : "Review work"}</h2>
        <button
          className="btn small icon-label"
          onClick={() => {
            setData(null);
            setRefresh((v) => v + 1);
          }}
        >
          <RefreshIcon />
          Refresh
        </button>
      </div>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {!data && !error ? (
        <p role="status" className="muted">
          Loading changes and checks…
        </p>
      ) : data ? (
        <>
          <section className="review-section">
            <h3>
              Changes <span className="muted">{data.files.length}</span>
            </h3>
            {data.warning && <p className="muted">{data.warning}</p>}
            {!data.files.length ? (
              <p className="muted">No changes to compare.</p>
            ) : (
              <>
                <select
                  aria-label="Changed file"
                  value={file}
                  onChange={(e) => setFile(e.target.value)}
                >
                  <option value="">Choose a file to inspect</option>
                  {data.files.map((f) => (
                    <option key={f.path} value={f.path}>
                      {f.status} · {f.path}
                    </option>
                  ))}
                </select>
                {file && (
                  <div className="diff-view" aria-label="File diff">
                    {loadingDiff ? (
                      <p role="status">Loading diff…</p>
                    ) : (
                      <pre>
                        {diff.split("\n").map((line, i) => (
                          <span
                            className={
                              line.startsWith("+") && !line.startsWith("+++")
                                ? "diff-add"
                                : line.startsWith("-") &&
                                  !line.startsWith("---")
                                ? "diff-remove"
                                : ""
                            }
                            key={i}
                          >
                            {line + "\n"}
                          </span>
                        ))}
                      </pre>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
          {/* A session has no PR, run report or review step: only its changes matter. */}
          {!ticket.standalone && <>
          <section className="review-section">
            <h3>Checks</h3>
            {data.checkError ? (
              <p role="status" className="muted">
                {data.checkError}
              </p>
            ) : !data.checks.length ? (
              <p className="muted">
                {data.hasPr
                  ? "No CI checks reported for this PR."
                  : "Link a pull request to see its CI checks here."}
              </p>
            ) : (
              <ul className="review-checks">
                {data.checks.map((check, i) => (
                  <li key={check.name + i}>
                    <span
                      className={`badge ${
                        ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.state)
                          ? "ok"
                          : ["FAILURE", "ERROR", "CANCELLED"].includes(
                              check.state
                            )
                          ? "failed"
                          : "queued"
                      }`}
                    >
                      {check.state.toLowerCase().replaceAll("_", " ")}
                    </span>
                    {safeHref(check.url) ? (
                      <a
                        href={safeHref(check.url)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {check.name}
                        <ExternalIcon />
                      </a>
                    ) : (
                      <span>{check.name}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {data.recordedChecks.length > 0 && (
            <section className="review-section">
              <h3>Recorded verification</h3>
              <p className="muted small">
                Commands and tool results from the latest run. “Completed”
                reports execution; inspect the output to judge coverage.
              </p>
              {data.recordedChecks.map((check, i) => (
                <details className="recorded-check" key={i}>
                  <summary>
                    <span
                      className={`badge ${
                        check.state === "failed" ? "failed" : "ok"
                      }`}
                    >
                      {check.state}
                    </span>
                    <code>{check.command}</code>
                  </summary>
                  <pre>{check.output || "No output recorded."}</pre>
                </details>
              ))}
            </section>
          )}
          <section className="review-section">
            <h3>Run report</h3>
            {data.verification ? (
              <>
                <div className="review-metrics">
                  {data.verification.durationMs !== null && (
                    <span>
                      {Math.round(data.verification.durationMs / 1000)}s
                    </span>
                  )}
                  {data.verification.costUsd !== null && (
                    <span>${data.verification.costUsd.toFixed(3)}</span>
                  )}
                </div>
                {data.verification.summary ? (
                  <Markdown text={data.verification.summary} />
                ) : (
                  <p className="muted">No written report was returned.</p>
                )}
                <p className="muted small">
                  Agent-reported results. CI checks above are reported by
                  GitHub.
                </p>
              </>
            ) : (
              <p className="muted">No completed run yet.</p>
            )}
            <button className="btn small" onClick={onOutputs}>
              Open outputs & previews
            </button>
            {ticket.prUrl && (
              <a
                className="btn small icon-label"
                href={safeHref(ticket.prUrl)}
                target="_blank"
                rel="noreferrer"
              >
                Open pull request
                <ExternalIcon />
              </a>
            )}
          </section>
          <section className="review-section">
            <h3>Request changes</h3>
            <p className="muted small">
              Send actionable feedback to this ticket’s agent.
            </p>
            <textarea
              aria-label="Review feedback"
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What needs to change, and how should it be verified?"
            />
            <div className="review-actions">
              <button
                className="btn primary"
                disabled={
                  !note.trim() ||
                  sending ||
                  ticket.status === "backlog" ||
                  ticket.status === "planning"
                }
                onClick={request}
              >
                {sending ? "Sending…" : "Send feedback"}
              </button>
              {ticket.status === "review" && !ticket.running && (
                <button
                  className="btn icon-label"
                  disabled={accepting}
                  onClick={async () => {
                    setAccepting(true);
                    try {
                      await api.updateTicket(slug, ticket.id, {
                        status: "done",
                      });
                    } catch (e: any) {
                      onError(e.message);
                    } finally {
                      setAccepting(false);
                    }
                  }}
                >
                  <CheckIcon />
                  Mark done
                </button>
              )}
            </div>
          </section>
          </>}
        </>
      ) : null}
    </div>
  );
}
