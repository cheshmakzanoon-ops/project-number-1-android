import { useCallback, useEffect, useRef, useState } from "react";
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

function supported(): boolean {
  return typeof Notification !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

async function deadline<T>(promise: Promise<T>, ms = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("push_timeout")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export function usePush(token: string | null) {
  const getVapid = useAction(api.push.vapidPublicKey);
  const save = useMutation(api.pushSubs.saveSubscription);
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | "unsupported">(
    () => supported() ? Notification.permission : "unsupported");
  const [subscribing, setSubscribing] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const subscribeNow = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    if (!token || !supported() || Notification.permission !== "granted") return Promise.resolve();
    const run = async () => {
      setSubscribing(true);
      setError(null);
      try {
        const vapid = await deadline(getVapid());
        if (!vapid) throw new Error("push_not_configured");
        const key = urlBase64ToUint8Array(vapid);
        const reg = await deadline(navigator.serviceWorker.ready);
        let sub = await deadline(reg.pushManager.getSubscription());
        const old = sub?.options.applicationServerKey;
        if (sub && old && Array.from(new Uint8Array(old)).join() !== Array.from(key).join()) {
          if (!await deadline(sub.unsubscribe())) throw new Error("push_key_rotation_failed");
          sub = null;
        }
        sub ??= await deadline(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
        const j = sub.toJSON();
        if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) throw new Error("invalid_subscription");
        await deadline(save({ token, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }));
        setRegistered(true);
      } catch {
        setRegistered(false);
        setError("زنگ تماس در پس‌زمینه فعال نشد. اتصال را بررسی کن و دوباره تلاش کن؛ فعلاً اپ را باز نگه دار.");
      } finally { setSubscribing(false); inFlight.current = null; }
    };
    inFlight.current = run();
    return inFlight.current;
  }, [token, getVapid, save]);

  useEffect(() => {
    const refresh = () => {
      if (!supported()) return;
      setNotifPerm(Notification.permission);
      if (Notification.permission === "granted") void subscribeNow();
      else setRegistered(false);
    };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    const message = (event: MessageEvent) => {
      if (event.data?.type === "push-subscription-changed") refresh();
    };
    refresh();
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", visible);
    navigator.serviceWorker?.addEventListener("message", message);
    return () => {
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", visible);
      navigator.serviceWorker?.removeEventListener("message", message);
    };
  }, [subscribeNow]);

  const enable = useCallback(async () => {
    if (!supported()) return;
    try {
      const perm = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      setNotifPerm(perm);
      if (perm === "granted") await subscribeNow();
    } catch { setError("مرورگر اجازهٔ اعلان نداد؛ تنظیمات اعلان این سایت را بررسی کن."); }
  }, [subscribeNow]);
  return { notifPerm, enable, subscribing, registered, error };
}
