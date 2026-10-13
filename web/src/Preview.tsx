import { useEffect, useState } from "react";
import { api, type Ticket } from "./api";

type Port = { port: number; command: string };

// On this Mac the app opens directly; elsewhere (the phone) it goes through the public bridge's preview address.
const onThisMac = ["localhost", "127.0.0.1"].includes(location.hostname);
const openHref = (port: number) => (onThisMac ? `http://localhost:${port}/` : `/__preview/open/${port}`);

/** The Preview tab: open the app this ticket runs, and take phone and desktop screenshots of it. */
export function Preview({ slug, ticket, onError, onOpenOutputs }: {
  slug: string; ticket: Ticket; onError: (msg: string) => void; onOpenOutputs: () => void;
}) {
  const [ports, setPorts] = useState<Port[] | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [shots, setShots] = useState<string[]>([]);
  const load = () => api.previewPorts(slug, ticket.id).then((r) => setPorts(r.ports)).catch((e) => { setPorts([]); onError(e.message); });
  useEffect(() => { load(); }, [slug, ticket.id]);

  const shoot = async (port: number) => {
    setBusy(port);
    try { setShots((await api.screenshot(slug, ticket.id, port)).files); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(null); }
  };
  const typedPort = Number(typed);
  const actions = (port: number) => (
    <>
      <a className="btn small primary" href={openHref(port)} target="_blank" rel="noreferrer">Open the app</a>
      <button className="btn small" disabled={busy !== null} onClick={() => shoot(port)}>{busy === port ? "Taking…" : "Take a screenshot"}</button>
    </>
  );

  return (
    <div className="preview">
      <div className="preview-head">
        <span className="muted small">Apps running from this ticket's folder</span>
        <span className="spacer" />
        <button className="btn small" onClick={load}>↻ Refresh</button>
      </div>
      {ports === null ? <p className="muted small">Looking for running apps…</p> : ports.length === 0 ? (
        <p className="muted small">No app is running from this ticket's folder. Ask Claude in the chat to start it, or type its port below.</p>
      ) : ports.map((p) => (
        <div key={p.port} className="preview-row">
          <span className="preview-port">{p.port}</span><span className="muted small preview-cmd">{p.command}</span>
          <span className="spacer" />
          {actions(p.port)}
        </div>
      ))}
      <div className="preview-row">
        <input className="preview-input" inputMode="numeric" placeholder="Other port, e.g. 5173" aria-label="Port"
          value={typed} onChange={(e) => setTyped(e.target.value.replace(/\D/g, ""))} />
        <span className="spacer" />
        {typedPort > 0 ? actions(typedPort) : null}
      </div>
      {!onThisMac && <p className="muted small">One app opens at a time from the phone; opening another one switches it.</p>}
      {shots.length > 0 && (
        <div className="preview-shots">
          {shots.map((name) => (
            <a key={name} href={api.outputUrl(slug, ticket.id, name)} target="_blank" rel="noreferrer" className={name.includes("-phone-") ? "phone" : "desktop"}>
              <img src={api.outputUrl(slug, ticket.id, name)} alt={name.includes("-phone-") ? "Phone screenshot" : "Desktop screenshot"} />
            </a>
          ))}
          <button className="btn small" onClick={onOpenOutputs}>See all in Outputs</button>
        </div>
      )}
    </div>
  );
}
