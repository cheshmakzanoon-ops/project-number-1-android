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
}