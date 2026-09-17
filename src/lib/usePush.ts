import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { withTimeout } from "./callLifecycle";

function applicationKey(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const key = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) key[i] = raw.charCodeAt(i);
  if (key.length !== 65 || key[0] !== 4) throw new Error("invalid_push_key");
  return key;
}
function supported(): boolean {
  return typeof Notification !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}
const deadline = <T,>(promise: Promise<T>) => withTimeout(promise, 12_000, "push_timeout");
type Owner = { alive: boolean; generation: number; permissionPending: boolean };
type Flight = { owner: Owner; generation: number; promise: Promise<void> };

export function usePush(token: string | null) {
  const getVapid = useAction(api.push.vapidPublicKey);
  const save = useMutation(api.pushSubs.saveSubscription);
  const remove = useMutation(api.pushSubs.removeSubscription);
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | "unsupported">(
    () => supported() ? Notification.permission : "unsupported");
  const [subscribing, setSubscribing] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = useMemo<Owner>(() => ({ alive: true, generation: 0, permissionPending: false }), [token]);
  const inFlight = useRef<Flight | null>(null);
  useLayoutEffect(() => {
    owner.alive = true;
    setRegistered(false); setSubscribing(false); setError(null);
    return () => { owner.alive = false; owner.generation++; };
  }, [owner]);

  const subscribeNow = useCallback((): Promise<void> => {
    if (!token || !owner.alive || !supported() || Notification.permission !== "granted") return Promise.resolve();
    const generation = owner.generation;
    const previous = inFlight.current;
    if (previous) {
      if (previous.owner === owner && previous.generation === generation) return previous.promise;
      // Serialize browser subscription mutations across identity changes. The
      // obsolete operation stops at its next awaited boundary (each is bounded).
      return previous.promise.then(() => owner.alive ? subscribeNow() : undefined);
    }
    const current = () => owner.alive && owner.generation === generation && Notification.permission === "granted";
    const flight: Flight = { owner, generation, promise: Promise.resolve() };
    inFlight.current = flight;
    const run = async () => {
      setSubscribing(true); setError(null);
      try {
        const vapid = await deadline(getVapid());
        if (!current()) return;
        if (!vapid) throw new Error("push_not_configured");
        const key = applicationKey(vapid);
        const reg = await deadline(navigator.serviceWorker.ready);
        if (!current()) return;
        let sub = await deadline(reg.pushManager.getSubscription());
        if (!current()) return;
        const old = sub?.options.applicationServerKey;
        if (sub && old && Array.from(new Uint8Array(old)).join() !== Array.from(key).join()) {
          const endpoint = sub.endpoint;
          if (!await deadline(sub.unsubscribe())) throw new Error("push_key_rotation_failed");
          if (!current()) return;
          // Removal is authorized by the backend and cannot delete another
          // identity's endpoint. Delivery will also prune expired endpoints.
          await deadline(remove({ token, endpoint })).catch(() => {});
          if (!current()) return;
          sub = null;
        }
        sub ??= await deadline(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
        if (!current()) return;
        const saveSubscription = (subscription: PushSubscription) => {
          const j = subscription.toJSON();
          if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) throw new Error("invalid_subscription");
          return deadline(save({ token, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }));
        };
        try { await saveSubscription(sub); }
        catch (failure) {
          if (!current()) return;
          if (!/subscription_not_owned/.test(String(failure))) throw failure;
          // A browser may retain an endpoint after account data is cleared.
          // Never transfer the old account's registration. Unsubscribe this
          // browser endpoint, obtain a fresh one, then register it normally.
          if (!await deadline(sub.unsubscribe())) throw new Error("push_owner_rotation_failed");
          if (!current()) return;
          sub = await deadline(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
          if (!current()) return;
          await saveSubscription(sub);
        }
        if (current()) setRegistered(true);
      } catch {
        if (current()) {
          setRegistered(false);
          setError("زنگ تماس در پس‌زمینه فعال نشد. اتصال را بررسی کن و دوباره تلاش کن؛ فعلاً اپ را باز نگه دار.");
        }
      } finally {
        if (inFlight.current === flight) inFlight.current = null;
        if (owner.alive && owner.generation === generation) setSubscribing(false);
      }
    };
    flight.promise = run();
    return flight.promise;
  }, [token, owner, getVapid, save, remove]);

  useEffect(() => {
    const refresh = () => {
      if (!owner.alive || !supported()) return;
      setNotifPerm(Notification.permission);
      if (Notification.permission === "granted") void subscribeNow();
      else { owner.generation++; setRegistered(false); setSubscribing(false); }
    };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    const message = (event: MessageEvent) => { if (event.data?.type === "push-subscription-changed") refresh(); };
    refresh();
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", visible);
    navigator.serviceWorker?.addEventListener("message", message);
    return () => {
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", visible);
      navigator.serviceWorker?.removeEventListener("message", message);
    };
  }, [subscribeNow, owner]);

  const enable = useCallback(async () => {
    if (!token || !owner.alive || !supported() || owner.permissionPending) return;
    owner.permissionPending = true;
    const generation = owner.generation;
    setError(null); setSubscribing(true);
    try {
      // Invoke inside the click handler, before awaiting anything: the browser
      // owns consent, and the app must retain the user's activation.
      const perm = Notification.permission === "default"
        ? await withTimeout(Notification.requestPermission(), 60_000, "notification_permission_timeout")
        : Notification.permission;
      if (!owner.alive || owner.generation !== generation) return;
      setNotifPerm(perm);
      if (perm === "granted") await subscribeNow();
    } catch {
      if (owner.alive && owner.generation === generation) setError("مرورگر اجازهٔ اعلان نداد؛ تنظیمات اعلان این سایت را بررسی کن.");
    } finally {
      owner.permissionPending = false;
      if (owner.alive && owner.generation === generation && inFlight.current?.owner !== owner) setSubscribing(false);
    }
  }, [subscribeNow, token, owner]);
  return { notifPerm, enable, subscribing, registered, error };
}
