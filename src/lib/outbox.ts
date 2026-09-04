/**
 * Tiny persisted outbox for chat messages that failed to send.
 *
 * When a send fails on a flaky connection the text is parked in localStorage
 * (keyed per conversation) with the SAME clientMessageId that the failed
 * attempt used, and the chat auto-retries it with backoff. Because the id is
 * reused, the server-side dedupe in messages.send makes a retry harmless even
 * when the first attempt actually landed but its response was lost.
 */

export interface PendingMessage {
  body: string;
  clientMsgId: string;
  queuedAt: number;
}

const MAX_PENDING = 50;

function key(conversationId: string): string {
  return `garma.outbox.${conversationId}`;
}

export function loadOutbox(conversationId: string): PendingMessage[] {
  try {
    const raw = localStorage.getItem(key(conversationId));
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return (arr as PendingMessage[]).filter(
      (p) => p && typeof p.body === "string" && typeof p.clientMsgId === "string",
    );
  } catch {
    return [];
  }
}

export function saveOutbox(conversationId: string, messages: PendingMessage[]): void {
  try {
    if (messages.length === 0) {
      localStorage.removeItem(key(conversationId));
    } else {
      localStorage.setItem(key(conversationId), JSON.stringify(messages.slice(-MAX_PENDING)));
    }
  } catch {
    /* storage full / unavailable: the in-memory queue still retries this session */
  }
}

/** A per-message id, reused by every retry of the same logical message. */
export function newClientMsgId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "m-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---- Unfinished-draft persistence ----
// A send that is queued while offline (Convex never rejects it, so the outbox
// above never sees it) can still be lost if the page is closed before the
// queue flushes. Persisting the working draft closes that last gap: whatever
// the user typed is restored when they reopen the conversation.

function draftKey(conversationId: string): string {
  return `garma.draft.${conversationId}`;
}

export function loadDraft(conversationId: string): string {
  try {
    return localStorage.getItem(draftKey(conversationId)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(conversationId: string, text: string): void {
  try {
    if (!text) localStorage.removeItem(draftKey(conversationId));
    else localStorage.setItem(draftKey(conversationId), text);
  } catch {
    /* storage unavailable: draft is best-effort */
  }
}
