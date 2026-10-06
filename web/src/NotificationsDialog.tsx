import { useEffect, useState } from "react";
import { api } from "./api";
import { Modal } from "./Modal";
export function NotificationsDialog({ onClose }: { onClose: () => void }) {
  const supported =
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  const [subscription, setSubscription] = useState<PushSubscription | null>(
      null
    ),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [topics, setTopics] = useState(() => {
    try {
      return {
        ...{ attention: true, completed: true, failed: true },
        ...JSON.parse(localStorage.getItem("esa.push.topics") ?? "{}"),
      };
    } catch {
      return { attention: true, completed: true, failed: true };
    }
  });
  const remember = () => {
    try {
      localStorage.setItem("esa.push.topics", JSON.stringify(topics));
    } catch {}
  };
  useEffect(() => {
    let active = true;
    if (!supported) {
      setLoading(false);
      return;
    }
    navigator.serviceWorker
      .getRegistration("/")
      .then((reg) => reg?.pushManager.getSubscription())
      .then((s) => {
        if (active) {
          setSubscription(s ?? null);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (active) {
          setLoading(false);
          setError(e.message);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const enable = () =>
    act(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      if (!registration?.active)
        throw new Error(
          "The app is still installing its background worker. Reload Esa Kanban and try again."
        );
      const permission = await Notification.requestPermission();
      if (permission !== "granted")
        throw new Error(
          "Notifications were not allowed. You can change this in your device settings."
        );
      const reg = await navigator.serviceWorker.ready,
        { publicKey } = await api.notificationKey();
      const normalized = publicKey.replaceAll("-", "+").replaceAll("_", "/");
      const bytes = Uint8Array.from(
        atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4)),
        (c) => c.charCodeAt(0)
      );
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes,
      });
      try {
        await api.subscribePush({ ...sub.toJSON(), topics });
      } catch (e) {
        await sub.unsubscribe();
        throw e;
      }
      remember();
      setSubscription(sub);
      setMessage("Notifications enabled for this device.");
    });
  return (
    <Modal title="Notifications" onClose={onClose}>
      <div className="form">
        <p>
          Get notified when work needs your input, finishes, or fails—even when
          the app is closed. Ticket titles and chat contents stay out of
          notifications.
        </p>
        {!supported ? (
          <div className="banner info">
            On iPhone, open Esa Kanban from your Home Screen using its HTTPS
            address. Notifications also require browser support.
          </div>
        ) : (
          <>
            <fieldset disabled={busy} className="notification-options">
              <legend>Notify me about</legend>
              {(["attention", "completed", "failed"] as const).map((topic) => (
                <label key={topic}>
                  <input
                    type="checkbox"
                    checked={topics[topic]}
                    onChange={(e) =>
                      setTopics({ ...topics, [topic]: e.target.checked })
                    }
                  />
                  {topic === "attention"
                    ? "Questions and blocked work"
                    : topic === "completed"
                    ? "Work ready for review"
                    : "Failed runs"}
                </label>
              ))}
            </fieldset>
            {loading ? (
              <p role="status">Checking this device…</p>
            ) : subscription ? (
              <div className="form-actions">
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await api.subscribePush({
                        ...subscription.toJSON(),
                        topics,
                      });
                      remember();
                      setMessage("Preferences saved.");
                    })
                  }
                >
                  Save preferences
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await api.testPush(subscription.endpoint);
                      setMessage("Test notification sent.");
                    })
                  }
                >
                  Send test
                </button>
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await api.unsubscribePush(subscription.endpoint);
                      await subscription.unsubscribe();
                      setSubscription(null);
                      setMessage("Notifications disabled on this device.");
                    })
                  }
                >
                  Disable
                </button>
              </div>
            ) : (
              <button
                className="btn primary"
                disabled={busy || !Object.values(topics).some(Boolean)}
                onClick={enable}
              >
                {busy ? "Connecting…" : "Enable notifications"}
              </button>
            )}
          </>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {message && <p role="status">{message}</p>}
        <p className="muted small">
          Your Mac must be awake and online to send updates.
        </p>
      </div>
    </Modal>
  );
}
