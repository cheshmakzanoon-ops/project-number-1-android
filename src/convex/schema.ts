import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    username: v.string(), // unique opaque handle (auto-generated)
    displayName: v.string(), // the only thing people enter
    themeColor: v.string(), // avatar / accent color
    createdAt: v.number(),
    lastSeenAt: v.number(), // presence via heartbeat
  })
    .index("by_username", ["username"])
    .index("by_display_name", ["displayName"]),

  // A user is authenticated by a long-lived device token (generated on first
  // launch, stored on the device). Only the token hash lives here.
  sessions: defineTable({
    userId: v.id("users"),
    tokenHash: v.string(),
    createdAt: v.number(),
  }).index("by_token_hash", ["tokenHash"]),

  conversations: defineTable({
    kind: v.union(v.literal("dm"), v.literal("group")),
    name: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    lastMessageAt: v.number(),
  }).index("by_last_message", ["lastMessageAt"]),

  conversationMembers: defineTable({
    conversationId: v.id("conversations"),
    userId: v.id("users"),
    joinedAt: v.number(),
    lastReadAt: v.number(),
    // Set while THIS member muted the conversation: suppresses push ringing
    // for calls in it (the in-app ring still works when the app is open).
    mutedAt: v.optional(v.number()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_user", ["userId"]),
  // unique per (conversationId, userId)

  messages: defineTable({
    conversationId: v.id("conversations"),
    senderId: v.id("users"),
    body: v.string(),
    createdAt: v.number(),
    editedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
    // Opaque id the client generates once per logical message and reuses when
    // retrying after a flaky-connection failure, so a retry can never create
    // a duplicate even if the first attempt actually landed server-side.
    clientMessageId: v.optional(v.string()),
    // Media support: text (default) | image | voice. `body` holds the caption
    // for an image and is empty for voice; the bytes live in Convex storage
    // and only their id + resolved URL are ever exposed to clients.
    kind: v.optional(v.union(v.literal("text"), v.literal("image"), v.literal("voice"))),
    storageId: v.optional(v.id("_storage")),
    mimeType: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    // WhatsApp/Telegram-style reply: this message quotes another message in
    // the same conversation.
    replyToId: v.optional(v.id("messages")),
  })
    .index("by_conversation_created", ["conversationId", "createdAt"])
    .index("by_conversation", ["conversationId"])
    .index("by_sender_client", ["senderId", "clientMessageId"]),

  reactions: defineTable({
    messageId: v.id("messages"),
    userId: v.id("users"),
    emoji: v.string(),
  }).index("by_message", ["messageId"]),

  // Web Push subscriptions, one per device that granted notifications.
  pushSubscriptions: defineTable({
    userId: v.id("users"),
    endpoint: v.string(), // unique push endpoint URL
    p256dh: v.string(),
    auth: v.string(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_endpoint", ["endpoint"]),

  // Ephemeral "user X is typing in conversation Y" presence rows.
  typing: defineTable({
    conversationId: v.id("conversations"),
    userId: v.id("users"),
    updatedAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_conversation_user", ["conversationId", "userId"]),

  calls: defineTable({
    conversationId: v.id("conversations"),
    initiatorId: v.id("users"),
    kind: v.union(v.literal("audio"), v.literal("video")),
    status: v.union(
      v.literal("ringing"),
      v.literal("active"),
      v.literal("ended"),
      v.literal("declined"),
      v.literal("missed"),
    ),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
  })
    .index("by_conversation_active", ["conversationId", "status"])
    .index("by_status", ["status"])
    .index("by_initiator", ["initiatorId"]),

  callParticipants: defineTable({
    callId: v.id("calls"),
    userId: v.id("users"),
    joinedAt: v.number(),
    // When this member actually answered/joined the media room. Undefined
    // while they are still being rung. Every member of a conversation gets a
    // row when a call starts (so they can see the ring / join later), and a
    // row only counts as "in the call" once acceptedAt is set.
    acceptedAt: v.optional(v.number()),
    leftAt: v.optional(v.number()),
  })
    .index("by_call", ["callId"])
    .index("by_call_user", ["callId", "userId"])
    .index("by_user", ["userId"]),

  // WebRTC signaling channel between the two peer devices.
  callSignals: defineTable({
    callId: v.id("calls"),
    fromUserId: v.id("users"),
    toUserId: v.id("users"),
    type: v.union(
      v.literal("offer"),
      v.literal("answer"),
      v.literal("ice"),
      v.literal("ring"),
      v.literal("hangup"),
      v.literal("screen"),
      v.literal("camera"),
      v.literal("mic"),
    ),
    payload: v.optional(v.string()),
    createdAt: v.number(),
    deliveredAt: v.optional(v.number()),
  })
    .index("by_call_to", ["callId", "toUserId"])
    .index("by_call_delivered", ["callId", "deliveredAt"])
    .index("by_to_user", ["toUserId"]),
});