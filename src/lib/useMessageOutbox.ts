import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { acknowledgeOutbox, appendOutbox, loadOutbox, newClientMsgId, OUTBOX_CHANGED,
  outboxStorageKey, type PendingMessage } from "./outbox";
import type { Id } from "../convex/_generated/dataModel";

type Send = (args: { conversationId: Id<"conversations">; token: string; body: string;
  clientMessageId: string; replyToId?: Id<"messages"> }) => Promise<unknown>;
type Queue = { items: PendingMessage[]; mounted: boolean; busy: boolean;
  retry?: ReturnType<typeof setTimeout>; backoff: number };

/** Each mount/conversation owns its work; acknowledged IDs are safe to retry. */
export function useMessageOutbox(conversationId: Id<"conversations">, token: string, send: Send) {
  const [, render] = useState(0);
  const queue = useMemo<Queue>(() => ({ items: loadOutbox(conversationId), mounted: false,
    busy: false, backoff: 2_000 }), [conversationId, token]);
  const sender = useRef(send);
  sender.current = send;
  const refresh = useCallback(() => {
    queue.items = loadOutbox(conversationId);
    if (queue.mounted) render(n => n + 1);
  }, [conversationId, queue]);
  const acknowledge = useCallback((ids: ReadonlySet<string>) => {
    acknowledgeOutbox(conversationId, ids);
    refresh();
  }, [conversationId, refresh]);

  const flush = useCallback(async () => {
    if (queue.busy || !queue.mounted) return;
    const schedule = () => {
      if (!queue.mounted || queue.retry !== undefined) return;
      queue.retry = setTimeout(() => { queue.retry = undefined; void flush(); }, queue.backoff);
      queue.backoff = Math.min(queue.backoff * 2, 30_000);
    };
    refresh();
    if (!queue.items.length) return;
    if (!navigator.onLine) { schedule(); return; }
    queue.busy = true;
    clearTimeout(queue.retry); queue.retry = undefined;
    // Capture the sender for THIS queue. A conversation switch cannot replace
    // an in-flight request's identity or drain its records into another chat.
    const sendForQueue = sender.current;
    try {
      while (queue.mounted) {
        refresh();
        const item = queue.items[0];
        if (!item) break;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            sendForQueue({ conversationId, token, body: item.body, clientMessageId: item.clientMsgId,
              replyToId: item.replyToId as Id<"messages"> | undefined }),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("send_timeout")), 15_000); }),
          ]);
          if (!acknowledgeOutbox(conversationId, new Set([item.clientMsgId]))) { schedule(); return; }
          queue.backoff = 2_000;
          refresh();
        } catch { schedule(); return; }
        finally { clearTimeout(timeout); }
      }
    } finally { queue.busy = false; }
  }, [conversationId, token, queue, refresh]);

  useEffect(() => {
    queue.mounted = true;
    const online = () => { queue.backoff = 2_000; void flush(); };
    const change = () => { refresh(); void flush(); };
    const storage = (event: StorageEvent) => { if (outboxStorageKey(conversationId, event.key)) change(); };
    const local = (event: Event) => { if ((event as CustomEvent).detail === conversationId) change(); };
    window.addEventListener("online", online);
    window.addEventListener("storage", storage);
    window.addEventListener(OUTBOX_CHANGED, local);
    void flush();
    return () => {
      queue.mounted = false;
      clearTimeout(queue.retry); queue.retry = undefined;
      window.removeEventListener("online", online);
      window.removeEventListener("storage", storage);
      window.removeEventListener(OUTBOX_CHANGED, local);
    };
  }, [conversationId, flush, queue, refresh]);

  const enqueue = useCallback((body: string, replyToId?: Id<"messages">): boolean => {
    if (!queue.mounted) return false;
    const item: PendingMessage = { body, replyToId, clientMsgId: newClientMsgId(), queuedAt: Date.now() };
    return appendOutbox(conversationId, item);
  }, [conversationId, queue]);
  const clear = useCallback(() => {
    acknowledge(new Set(queue.items.map(item => item.clientMsgId)));
    clearTimeout(queue.retry); queue.retry = undefined;
  }, [acknowledge, queue]);
  return { pending: queue.items, enqueue, acknowledge, clear, flush };
}
