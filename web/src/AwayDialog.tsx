import { useEffect, useState } from "react";
import { api, copy, type Away } from "./api";
import { LID_COMMAND, LID_UNDO, phoneAccessLabel, type TunnelStatus } from "./awayText";
import { Modal } from "./Modal";

/** Using the board from the phone: is the public link up, does the Mac stay awake, and what closing the lid does. */
export function AwayDialog({ tunnel, onClose }: { tunnel: TunnelStatus | null; onClose: () => void }) {
  const [away, setAway] = useState<Away | null>(null);
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.away().then(setAway, (e) => setError((e as Error).message));
  }, []);

  async function setKeepAwake(keepAwake: boolean) {
    try {
      await api.updateSettings({ keepAwake });
      setAway(await api.away());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const status = tunnel ?? away?.tunnel ?? null;
  const command = (text: string) => (
    <div className="mcp-manual">
      <code>{text}</code>
      <button className="btn small" onClick={async () => { await copy(text); setCopied(text); }}>{copied === text ? "Copied!" : "Copy"}</button>
    </div>
  );

  return (
    <Modal title="Use from your phone" onClose={onClose}>
      <div className="form">
        {status && (
          <p>
            <b>{phoneAccessLabel(status)}</b>
            {status.url && <><br /><span className="muted small">{status.url}</span></>}
            {status.state === "offline" && <><br /><span className="muted small">Your phone can't reach this Mac. Check that the Mac is online and the tunnel app (ngrok) is running.</span></>}
          </p>
        )}
        {away && (
          <label className="board-switch">
            <input type="checkbox" checked={away.keepAwake} onChange={(e) => void setKeepAwake(e.target.checked)} />
            <span>
              Keep the Mac awake while the board is open
              <span className="muted small">
                When off, the Mac stays awake only while tickets, chats or huddles are working.
                {away.holding ? " Keeping it awake now." : ""}
              </span>
            </span>
          </label>
        )}
        <div className="form-section"><span>When you close the lid</span></div>
        <p className="muted small">
          Closing the lid puts the Mac to sleep and the board stops until you open it. When it's plugged in, a connected
          screen keeps it awake. To keep it awake with the lid closed (on battery too, which uses up the battery), run this
          once in Terminal. It asks for your Mac password:
        </p>
        {command(LID_COMMAND)}
        <p className="muted small">To undo it:</p>
        {command(LID_UNDO)}
        <p className="muted small">
          With the lid closed, keep the Mac on a hard surface, not in a bag. If it gets too hot, it goes to sleep anyway.
        </p>
        {error && <div className="form-error">{error}</div>}
      </div>
    </Modal>
  );
}
