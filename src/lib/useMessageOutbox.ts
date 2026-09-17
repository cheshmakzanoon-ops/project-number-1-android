import { useCallback, useEffect, useRef, useState } from "react";
import { loadOutbox, saveOutbox, MAX_PENDING, newClientMsgId, type PendingMessage } from "./outbox";
import type { Id } from "../convex/_generated/dataModel";

type Send = (args: { conversationId: Id<"conversations">; token: string; body: string;
  clientMessageId: string; replyToId?: Id<"messages"> }) => Promise<unknown>;

/** Persist BEFORE calling the network, reuse the ID, and retire only acknowledged IDs. */
export function useMessageOutbox(conversationId: Id<"conversations">, token: string, send: Send) {
  const [pending, setPending] = useState(() => loadOutbox(conversationId));
  const current = useRef(pending);
  const busy = useRef(false);
  const mounted = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const backoff = useRef(2_000);
  const flushRef = useRef<() => void>(() => {});

  const acknowledge = useCallback((ids: ReadonlySet<string>) => {
    current.current = current.current.filter((item) => !ids.has(item.clientMsgId));
    // A prior mount may acknowledge after a new mount queued another message.
    // Read the durable queue here so that late completion never erases new work.
    saveOutbox(conversationId, loadOutbox(conversationId).filter((item) => !ids.has(item.clientMsgId)));
    if (mounted.current) setPending(current.current);
  }, [conversationId]);

  const schedule = useCallback(() => {
    if (!mounted.current || retry.current !== undefined) return;
    retry.current = setTimeout(() => {
      retry.current = undefined;
      flushRef.current();
    }, backoff.current);
    backoff.current = Math.min(backoff.current * 2, 30_000);
  }, []);

  const flush = useCallback(async () => {
    if (busy.current || !mounted.current) return;
    if (!navigator.onLine) { schedule(); return; }
    busy.current = true;
    clearTimeout(retry.current);
    retry.current = undefined;
    try {
      while (mounted.current && current.current.length) {
        const item = current.current[0];
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            send({ conversationId, token, body: item.body, clientMessageId: item.clientMsgId,
              replyToId: item.replyToId as Id<"messages"> | undefined }),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("send_timeout")), 15_000); }),
          ]);
          acknowledge(new Set([item.clientMsgId]));
          backoff.current = 2_000;
        } catch { schedule(); return; }
        finally { clearTimeout(timeout); }
      }
    } finally { busy.current = false; }
  }, [acknowledge, conversationId, schedule, send, token]);
  flushRef.current = () => { void flush(); };

  useEffect(() => {
    mounted.current = true;
    flushRef.current();
    const online = () => { backoff.current = 2_000; flushRef.current(); };
    window.addEventListener("online", online);
    return () => { mounted.current = false; clearTimeout(retry.current); retry.current = undefined;
      window.removeEventListener("online", online); };
  }, []);

  const enqueue = useCallback((body: string, replyToId?: Id<"messages">): boolean => {
    if (current.current.length >= MAX_PENDING) return false;
    const item: PendingMessage = { body, replyToId, clientMsgId: newClientMsgId(), queuedAt: Date.now() };
    const next = [...current.current, item];
    if (!saveOutbox(conversationId, next)) return false;
    current.current = next;
    setPending(next);
    flushRef.current();
    return true;
  }, [conversationId]);

  const clear = useCallback(() => {
    // This discards queued retries, not a message already accepted by the server.
    if (!saveOutbox(conversationId, [])) return;
    current.current = [];
    setPending([]);
    clearTimeout(retry.current);
    retry.current = undefined;
  }, [conversationId]);
  return { pending, enqueue, acknowledge, clear, flush };
}
