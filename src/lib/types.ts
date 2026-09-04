import type { Id } from "../convex/_generated/dataModel";

export interface PublicUser {
  _id: Id<"users">;
  username: string;
  displayName: string;
  themeColor: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface DirectoryEntry extends PublicUser {
  online: boolean;
  isMe: boolean;
}

/** One other member of a conversation (me excluded) — used to open chats and
 * to describe who a call will ring. */
export interface ConvPeer {
  userId: Id<"users">;
  displayName: string;
  themeColor: string;
}

export interface ConvSummary {
  _id: Id<"conversations">;
  kind: "dm" | "group";
  name?: string;
  lastMessageAt: number;
  unread: number;
  lastMessage: string | null;
  lastMessageSender: string | null;
  lastMessageAt_: number | null;
  members: Array<{ user: PublicUser; online: boolean }>;
}

export type MessageKind = "text" | "image" | "voice";

export interface ChatMessage {
  _id: Id<"messages">;
  senderId: Id<"users">;
  body: string;
  createdAt: number;
  editedAt?: number;
  deletedAt?: number;
  isMine: boolean;
  /** For messages I sent: has the other participant read it yet (WhatsApp tick). */
  read: boolean;
  reactions: Record<string, number>;
  usersReacted: boolean;
  /** Stable client-generated id; lets queued sends match their acked row. */
  clientMessageId?: string;
  /** text (default) | image | voice — media bytes live in Convex storage. */
  kind?: MessageKind;
  /** Resolved storage URL for image/voice messages (null while loading/gone). */
  url?: string | null;
  durationMs?: number;
  /** The message this one quotes (reply), if any. */
  replyToId?: Id<"messages"> | null;
  /** Server-resolved quote excerpt: who said it + a snippet + sender color. */
  reply?: {
    senderName: string;
    senderColor: string;
    body: string;
    deleted: boolean;
    kind: MessageKind;
  } | null;
}

/** One hit of the in-chat message search. */
export interface SearchHit {
  _id: Id<"messages">;
  body: string;
  createdAt: number;
  kind: MessageKind;
  senderName: string;
  senderColor: string;
}

/** A message the user chose to reply to (client-side snapshot for the composer). */
export interface ReplyQuote {
  id: Id<"messages">;
  senderName: string;
  senderColor: string;
  body: string;
  deleted: boolean;
  kind: MessageKind;
  isMine: boolean;
}