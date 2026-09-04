import { useCallback, useEffect, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";

/** Standard VAPID key decoder for the subscribe call. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/**
 * Registers this device for Web Push so incoming calls ring even when the
 * app/tab is fully closed: the OS shows a system notification and plays the
 * phone's own default notification sound (a web app cannot override that
 * sound — which is the desired behavior).
 */
export function usePush(token: string | null): {
  notifPerm: NotificationPermission | "unsupported";
  enable: () => Promise<void>;
  subscribing: boolean;
} {
  const getVapid = useAction(api.push.vapidPublicKey);
  const save = useMutation(api.pushSubs.saveSubscription);

  const [notifPerm, setNotifPerm] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const [subscribing, setSubscribing] = useState(false);

  const subscribeNow = useCallback(async () => {
    // Web Push needs the service worker + a real VAPID endpoint, which only
    // exist in the deployed app; skip in the dev preview to avoid a hang.
    if (!import.meta.env.PROD) return;
    if (!token || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    try {
      setSubscribing(true);
      const vapid = await getVapid();
      if (!vapid) return;
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapid),
        }));
      const j = sub.toJSON();
      if (j.endpoint && j.keys?.p256dh && j.keys?.auth) {
        await save({ token, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
      }
    } catch {
      /* subscription failures never block the app */
    } finally {
      setSubscribing(false);
    }
  }, [getVapid, save, token]);

  // If the user already granted notifications (e.g. re-opened the app after a
  // reinstall), (re-)register silently.
  useEffect(() => {
    if (notifPerm === "granted") void subscribeNow();
  }, [notifPerm, subscribeNow]);

  // Browsers occasionally rotate push subscriptions server-side
  // (pushsubscriptionchange) — if we don't re-subscribe, the old endpoint
  // dies and the device silently stops ringing even though permission is
  // still granted. Re-create the subscription whenever that happens.
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    const onSubChange = () => {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        void subscribeNow();
      }
    };
    navigator.serviceWorker.addEventListener("pushsubscriptionchange", onSubChange);
    return () => navigator.serviceWorker.removeEventListener("pushsubscriptionchange", onSubChange);
  }, [subscribeNow]);

  const enable = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    setNotifPerm(perm);
    if (perm === "granted") await subscribeNow();
  }, [subscribeNow]);

  return { notifPerm, enable, subscribing };
}
