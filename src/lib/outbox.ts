/** Durable per-message records: one tab must never replace another tab's queue. */
export interface PendingMessage {
  body: string;
  clientMsgId: string;
  queuedAt: number;
  replyToId?: string;
}
export const MAX_PENDING = 50;
export const OUTBOX_CHANGED = "garma-outbox-changed";
const prefix = (conversationId: string) => `garma.outbox.v2.${encodeURIComponent(conversationId)}.`;
const legacyKey = (conversationId: string) => `garma.outbox.${conversationId}`;
const itemKey = (conversationId: string, id: string) => prefix(conversationId) + encodeURIComponent(id);

function valid(value: unknown): value is PendingMessage {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<PendingMessage>;
  return typeof p.body === "string" && p.body.trim().length > 0 && p.body.length <= 4000 &&
    typeof p.clientMsgId === "string" && p.clientMsgId.length > 0 && p.clientMsgId.length <= 128 &&
    typeof p.queuedAt === "number" && Number.isFinite(p.queuedAt) && p.queuedAt >= 0 &&
    (p.replyToId === undefined || (typeof p.replyToId === "string" && p.replyToId.length > 0 && p.replyToId.length <= 128));
}
function legacy(conversationId: string): PendingMessage[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(legacyKey(conversationId)) ?? "[]");
    return Array.isArray(value) ? value.filter(valid) : [];
  } catch { return []; }
}
export function loadOutbox(conversationId: string): PendingMessage[] {
  const items = new Map(legacy(conversationId).map(item => [item.clientMsgId, item]));
  try {
    const start = prefix(conversationId);
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(start)) continue;
      try {
        const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
        const id = decodeURIComponent(key.slice(start.length));
        // A legacy acknowledgement wins over the old array, even if another
        // tab is still migrating it. New records are removed individually.
        if (value === null) items.delete(id);
        else if (valid(value) && value.clientMsgId === id) items.set(id, value);
      } catch { /* ignore this malformed record, not the rest of the queue */ }
    }
  } catch { /* inaccessible storage: caller retains the composer draft */ }
  return [...items.values()].sort((a, b) => a.queuedAt - b.queuedAt);
}
function changed(conversationId: string) {
  window.dispatchEvent(new CustomEvent(OUTBOX_CHANGED, { detail: conversationId }));
}
export function appendOutbox(conversationId: string, item: PendingMessage): boolean {
  if (!valid(item) || loadOutbox(conversationId).length >= MAX_PENDING) return false;
  try {
    localStorage.setItem(itemKey(conversationId, item.clientMsgId), JSON.stringify(item));
    changed(conversationId);
    return true;
  } catch { return false; }
}
/** Only retire the IDs observed by this caller; unrelated/new messages survive. */
export function acknowledgeOutbox(conversationId: string, ids: ReadonlySet<string>): boolean {
  try {
    const old = legacy(conversationId);
    for (const id of ids) {
      if (old.some(item => item.clientMsgId === id)) {
        // Bounded to pre-upgrade records. Never rewrite a shared legacy array:
        // that would bring back the cross-tab lost-update bug during upgrade.
        localStorage.setItem(itemKey(conversationId, id), "null");
      } else localStorage.removeItem(itemKey(conversationId, id));
    }
    // Once every legacy message is retired, discard the obsolete plaintext
    // array too. Only legacy-ID markers are touched, never new queued work.
    if (old.length && old.every(item => localStorage.getItem(itemKey(conversationId, item.clientMsgId)) === "null")) {
      localStorage.removeItem(legacyKey(conversationId));
      for (const item of old) {
        const key = itemKey(conversationId, item.clientMsgId);
        if (localStorage.getItem(key) === "null") localStorage.removeItem(key);
      }
    }
    if (ids.size) changed(conversationId);
    return true;
  } catch { return false; }
}
export function outboxStorageKey(conversationId: string, key: string | null): boolean {
  return key === null || key === legacyKey(conversationId) || key.startsWith(prefix(conversationId));
}
export function newClientMsgId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

// Unsent composer drafts remain separate from acknowledged messages.
const draftKey = (conversationId: string) => `garma.draft.${conversationId}`;
export function loadDraft(conversationId: string): string {
  try { return localStorage.getItem(draftKey(conversationId)) ?? ""; }
  catch { return ""; }
}
export function saveDraft(conversationId: string, text: string): void {
  try {
    if (!text) localStorage.removeItem(draftKey(conversationId));
    else localStorage.setItem(draftKey(conversationId), text);
  } catch { /* best effort; the in-memory composer is not cleared */ }
}
