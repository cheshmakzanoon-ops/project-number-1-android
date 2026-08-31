/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";
import type { GenericId as Id } from "convex/values";

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: {
  auth: {
    authQuery: FunctionReference<
      "query",
      "public",
      { throwIfNone?: boolean; token?: string },
      any
    >;
  };
  calls: {
    ackSignals: FunctionReference<
      "mutation",
      "public",
      { callId: Id<"calls">; cutoff: number; token: string },
      any
    >;
    answer: FunctionReference<
      "mutation",
      "public",
      { callId: Id<"calls">; token: string },
      any
    >;
    details: FunctionReference<
      "query",
      "public",
      { callId: Id<"calls">; token?: string },
      any
    >;
    end: FunctionReference<
      "mutation",
      "public",
      {
        callId: Id<"calls">;
        status?: "ended" | "declined" | "missed";
        token: string;
      },
      any
    >;
    myCalls: FunctionReference<"query", "public", { token?: string }, any>;
    pendingSignals: FunctionReference<
      "query",
      "public",
      { callId: Id<"calls">; token?: string },
      any
    >;
    sendSignal: FunctionReference<
      "mutation",
      "public",
      {
        callId: Id<"calls">;
        payload?: string;
        toUserId: Id<"users">;
        token: string;
        type:
          | "offer"
          | "answer"
          | "ice"
          | "ring"
          | "hangup"
          | "screen"
          | "camera"
          | "mic";
      },
      any
    >;
    start: FunctionReference<
      "mutation",
      "public",
      {
        conversationId: Id<"conversations">;
        kind: "audio" | "video";
        token: string;
      },
      any
    >;
  };
  conversations: {
    conversation: FunctionReference<
      "query",
      "public",
      { conversationId: Id<"conversations">; token?: string },
      any
    >;
    markRead: FunctionReference<
      "mutation",
      "public",
      { conversationId: Id<"conversations">; token: string },
      any
    >;
    myConversations: FunctionReference<
      "query",
      "public",
      { token?: string },
      any
    >;
    startDM: FunctionReference<
      "mutation",
      "public",
      { otherId: Id<"users">; token: string },
      any
    >;
  };
  livekit: {
    getToken: FunctionReference<
      "action",
      "public",
      { callId: Id<"calls">; token: string },
      any
    >;
  };
  messages: {
    edit: FunctionReference<
      "mutation",
      "public",
      { body: string; messageId: Id<"messages">; token: string },
      any
    >;
    list: FunctionReference<
      "query",
      "public",
      { conversationId: Id<"conversations">; limit?: number; token?: string },
      any
    >;
    remove: FunctionReference<
      "mutation",
      "public",
      { messageId: Id<"messages">; token: string },
      any
    >;
    send: FunctionReference<
      "mutation",
      "public",
      { body: string; conversationId: Id<"conversations">; token: string },
      any
    >;
    toggleReaction: FunctionReference<
      "mutation",
      "public",
      { emoji: string; messageId: Id<"messages">; token: string },
      any
    >;
  };
  typing: {
    startTyping: FunctionReference<
      "mutation",
      "public",
      { conversationId: Id<"conversations">; token: string },
      any
    >;
    stopTyping: FunctionReference<
      "mutation",
      "public",
      { conversationId: Id<"conversations">; token: string },
      any
    >;
    whoIsTyping: FunctionReference<
      "query",
      "public",
      { conversationId: Id<"conversations">; token?: string },
      any
    >;
  };
  users: {
    directory: FunctionReference<"query", "public", { token?: string }, any>;
    heartbeat: FunctionReference<"mutation", "public", { token: string }, any>;
    me: FunctionReference<"query", "public", { token?: string }, any>;
    register: FunctionReference<
      "mutation",
      "public",
      { displayName: string; token: string; whoami?: string },
      any
    >;
  };
};

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: {};

export declare const components: {};
