/* eslint-disable */
/**
 * Generated data model types.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  DocumentByName,
  TableNamesInDataModel,
  SystemTableNames,
  AnyDataModel,
} from "convex/server";
import type { GenericId } from "convex/values";

/**
 * A type describing your Convex data model.
 *
 * This type includes information about what tables you have, the type of
 * documents stored in those tables, and the indexes defined on them.
 *
 * This type is used to parameterize methods like `queryGeneric` and
 * `mutationGeneric` to make them type-safe.
 */

export type DataModel = {
  callParticipants: {
    document: {
      callId: Id<"calls">;
      joinedAt: number;
      leftAt?: number;
      userId: Id<"users">;
      _id: Id<"callParticipants">;
      _creationTime: number;
    };
    fieldPaths:
      "_creationTime" | "_id" | "callId" | "joinedAt" | "leftAt" | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_call: ["callId", "_creationTime"];
      by_call_user: ["callId", "userId", "_creationTime"];
      by_user: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  calls: {
    document: {
      conversationId: Id<"conversations">;
      endedAt?: number;
      initiatorId: Id<"users">;
      kind: "audio" | "video";
      startedAt: number;
      status: "ringing" | "active" | "ended" | "declined" | "missed";
      _id: Id<"calls">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "conversationId"
      | "endedAt"
      | "initiatorId"
      | "kind"
      | "startedAt"
      | "status";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_conversation_active: ["conversationId", "status", "_creationTime"];
      by_initiator: ["initiatorId", "_creationTime"];
      by_status: ["status", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  callSignals: {
    document: {
      callId: Id<"calls">;
      createdAt: number;
      deliveredAt?: number;
      fromUserId: Id<"users">;
      payload?: string;
      toUserId: Id<"users">;
      type:
        | "offer"
        | "answer"
        | "ice"
        | "ring"
        | "hangup"
        | "screen"
        | "camera"
        | "mic";
      _id: Id<"callSignals">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "callId"
      | "createdAt"
      | "deliveredAt"
      | "fromUserId"
      | "payload"
      | "toUserId"
      | "type";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_call_delivered: ["callId", "deliveredAt", "_creationTime"];
      by_call_to: ["callId", "toUserId", "_creationTime"];
      by_to_user: ["toUserId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  conversationMembers: {
    document: {
      conversationId: Id<"conversations">;
      joinedAt: number;
      lastReadAt: number;
      userId: Id<"users">;
      _id: Id<"conversationMembers">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "conversationId"
      | "joinedAt"
      | "lastReadAt"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_conversation: ["conversationId", "_creationTime"];
      by_user: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  conversations: {
    document: {
      createdAt: number;
      createdBy: Id<"users">;
      kind: "dm" | "group";
      lastMessageAt: number;
      name?: string;
      _id: Id<"conversations">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "createdAt"
      | "createdBy"
      | "kind"
      | "lastMessageAt"
      | "name";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_last_message: ["lastMessageAt", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  messages: {
    document: {
      body: string;
      conversationId: Id<"conversations">;
      createdAt: number;
      deletedAt?: number;
      editedAt?: number;
      senderId: Id<"users">;
      _id: Id<"messages">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "body"
      | "conversationId"
      | "createdAt"
      | "deletedAt"
      | "editedAt"
      | "senderId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_conversation: ["conversationId", "_creationTime"];
      by_conversation_created: ["conversationId", "createdAt", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  reactions: {
    document: {
      emoji: string;
      messageId: Id<"messages">;
      userId: Id<"users">;
      _id: Id<"reactions">;
      _creationTime: number;
    };
    fieldPaths: "_creationTime" | "_id" | "emoji" | "messageId" | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_message: ["messageId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  sessions: {
    document: {
      createdAt: number;
      tokenHash: string;
      userId: Id<"users">;
      _id: Id<"sessions">;
      _creationTime: number;
    };
    fieldPaths: "_creationTime" | "_id" | "createdAt" | "tokenHash" | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_token_hash: ["tokenHash", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  typing: {
    document: {
      conversationId: Id<"conversations">;
      updatedAt: number;
      userId: Id<"users">;
      _id: Id<"typing">;
      _creationTime: number;
    };
    fieldPaths:
      "_creationTime" | "_id" | "conversationId" | "updatedAt" | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_conversation: ["conversationId", "_creationTime"];
      by_conversation_user: ["conversationId", "userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  users: {
    document: {
      createdAt: number;
      displayName: string;
      lastSeenAt: number;
      themeColor: string;
      username: string;
      _id: Id<"users">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "createdAt"
      | "displayName"
      | "lastSeenAt"
      | "themeColor"
      | "username";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_display_name: ["displayName", "_creationTime"];
      by_username: ["username", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
};

/**
 * The names of all of your Convex tables.
 */
export type TableNames = TableNamesInDataModel<DataModel>;

/**
 * The type of a document stored in Convex.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
export type Doc<TableName extends TableNames> = DocumentByName<
  DataModel,
  TableName
>;

/**
 * An identifier for a document in Convex.
 *
 * Convex documents are uniquely identified by their `Id`, which is accessible
 * on the `_id` field. To learn more, see [Document IDs](https://docs.convex.dev/using/document-ids).
 *
 * Documents can be loaded using `db.get(tableName, id)` in query and mutation functions.
 *
 * IDs are just strings at runtime, but this type can be used to distinguish them from other
 * strings when type checking.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
export type Id<TableName extends TableNames | SystemTableNames> =
  GenericId<TableName>;
