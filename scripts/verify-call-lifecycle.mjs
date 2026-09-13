/**
 * End-to-end verification of the call-lifecycle backend rules against a real
 * Convex deployment (uses only public functions over the HTTP API).
 *
 *   node scripts/verify-call-lifecycle.mjs
 *
 * It covers what no unit test can prove on its own:
 *
 * A) Group-call regression:
 *    A + B + C join call #1, A leaves, B + C stay in call #1.
 *    → A must be able to start call #2 (a departed member is not busy).
 *    → B, who is genuinely present, must still be refused (already_in_call),
 *      so nobody can be in two live calls at once.
 *
 * B) The Android screen-share handoff, end to end on the server:
 *    → only a live participant can request a code (foreign/non-participant is
 *      refused, an ended call is refused);
 *    → the code is opaque and single-use, and redeems into the AUXILIARY
 *      `<userId>:screen` identity — never the user's own participant identity;
 *    → the grant cannot publish camera/mic and cannot subscribe;
 *    → replay is refused;
 *    → the session verdict the companion polls goes false the moment the call
 *      ends, which is what guarantees a MediaProjection capture cannot outlive
 *      the call even if the stop message is lost.
 *
 * The scenario only ever ADDS rows (clearly named "Repair Check …") and ends
 * every call it starts, so no live call is left behind.
 */
const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://precise-ptarmigan-412.eu-west-1.convex.cloud";

let failures = 0;
const pass = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  ✗ ${msg}`);
};
const skip = (msg) => console.log(`  – ${msg}`);

async function call(kind, path, args) {
  const res = await fetch(`${CONVEX_URL}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = await res.json().catch(() => null);
  if (!body || body.status === "error") {
    const message = body?.errorMessage ?? `HTTP ${res.status}`;
    const err = new Error(message);
    err.serverError = true;
    throw err;
  }
  return body.value;
}

const token = (label) => `repair-check-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function register(label) {
  const t = token(label);
  const out = await call("mutation", "users:register", { token: t, displayName: `Repair Check ${label}` });
  return { token: t, userId: out.user._id };
}

const expectError = async (label, fn, needle) => {
  await expectRefusal(label, fn, [needle]);
};

const expectRefusal = async (label, fn, needles) => {
  try {
    await fn();
    fail(`${label}: expected a refusal, but the call succeeded`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hit = needles.find((n) => msg.includes(n));
    if (hit) pass(`${label} (${hit})`);
    else fail(`${label}: unexpected error ${msg}`);
  }
};

console.log(`verifying call lifecycle against ${CONVEX_URL}\n`);

const a = await register("A");
const b = await register("B");
const c = await register("C");
pass("registered three throwaway identities");

const conversationId = await call("mutation", "conversations:startGroup", {
  token: a.token,
  memberIds: [b.userId, c.userId],
});
pass("created a group conversation for A + B + C");

// ---- call #1: everyone joins, then A leaves -------------------------------
const call1 = await call("mutation", "calls:start", {
  conversationId,
  token: a.token,
  kind: "audio",
});
await call("mutation", "calls:answer", { callId: call1, token: a.token });
await call("mutation", "calls:answer", { callId: call1, token: b.token });
await call("mutation", "calls:answer", { callId: call1, token: c.token });
const details1 = await call("query", "calls:details", { callId: call1, token: b.token });
if (details1.call.status === "active") pass("call #1 is active with A, B and C");
else fail(`call #1 status is ${details1.call.status}, expected active`);

await call("mutation", "calls:end", { callId: call1, token: a.token, status: "ended" });
const afterLeave = await call("query", "calls:details", { callId: call1, token: b.token });
if (afterLeave.isMine === true && afterLeave.members.every((m) => m.userId !== a.userId)) {
  pass("A left call #1 while B and C are still in it");
} else {
  fail("call #1 did not survive A leaving");
}

// ---- the regression: a departed member must not be considered busy --------
let call2 = null;
try {
  call2 = await call("mutation", "calls:start", {
    conversationId,
    token: a.token,
    kind: "video",
  });
  pass(`A (who left call #1) could start call #2 (${call2})`);
  // B and C are genuinely present in call #1, so they stay blocked.
  await expectError(
    "B is still refused while genuinely present in call #1",
    () =>
      call("mutation", "calls:start", { conversationId, token: b.token, kind: "audio" }),
    "already_in_call",
  );
} catch (e) {
  fail(`A could not start call #2: ${e instanceof Error ? e.message : String(e)}`);
}

// ---- the Android companion handoff, on the live call #2 -------------------
if (call2) {
  let handoff = null;
  try {
    handoff = await call("action", "livekit:requestScreenShareHandoff", {
      token: a.token,
      callId: call2,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("livekit_not_configured")) {
      skip(`handoff round-trip skipped: ${msg}`);
    } else {
      fail(`requesting a handoff on a live call failed: ${msg}`);
    }
  }

  if (handoff) {
    if (typeof handoff.code === "string" && /^[A-Za-z0-9_-]{43}$/.test(handoff.code)) {
      pass("a live participant can request a short-lived opaque handoff code");
    } else {
      fail(`handoff code is not an opaque 43-char base64url value: ${JSON.stringify(handoff.code)}`);
    }
    if (handoff.expiresInMs <= 60_000) pass(`handoff TTL is bounded (${handoff.expiresInMs}ms)`);
    else fail(`handoff TTL is too long: ${handoff.expiresInMs}ms`);

    let redeemed = null;
    try {
      redeemed = await call("action", "livekit:redeemScreenShareHandoff", {
        code: handoff.code,
      });
    } catch (e) {
      fail(`redeeming a fresh code failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (redeemed) {
      if (redeemed.identity === `${a.userId}:screen`) {
        pass("redeemed identity is the auxiliary <userId>:screen participant");
      } else {
        fail(`redeemed identity is ${redeemed.identity}, expected ${a.userId}:screen`);
      }
      if (redeemed.identity !== a.userId) {
        pass("the companion can never reuse the browser's participant identity");
      } else {
        fail("the companion joined with the SAME identity as the browser participant");
      }
      if (redeemed.room === `call-${call2}`) pass("the grant targets this call's room only");
      else fail(`grant room is ${redeemed.room}, expected call-${call2}`);
      if (typeof redeemed.token === "string" && redeemed.token.split(".").length === 3) {
        pass("a LiveKit JWT was minted for the companion");
      } else {
        fail("no LiveKit JWT was returned for the companion");
      }
      // The signed grant must be screen-only: no camera, no mic, no subscribe.
      try {
        const [, payloadB64] = redeemed.token.split(".");
        const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
        const video = payload?.video ?? {};
        const sources = JSON.stringify(video.canPublishSources ?? []);
        if (sources.includes("screen_share") && !sources.includes("camera") && !sources.includes("microphone")) {
          pass("the companion grant is screen-only (no camera, no microphone)");
        } else {
          fail(`companion grant allows unexpected sources: ${sources}`);
        }
        if (video.canSubscribe !== true) pass("the companion cannot subscribe to anyone's media");
        else fail("companion grant allows subscribing");
      } catch (e) {
        fail(`could not inspect the companion grant: ${e instanceof Error ? e.message : String(e)}`);
      }

      await expectError(
        "a replayed handoff code is refused",
        () => call("action", "livekit:redeemScreenShareHandoff", { code: handoff.code }),
        "handoff_invalid",
      );

      if (redeemed.sessionId) {
        const live = await call("query", "screenShare:sessionState", {
          sessionId: redeemed.sessionId,
        });
        if (live?.live === true) pass("the companion's session polls as live during the call");
        else fail(`sessionState during a live call was ${JSON.stringify(live)}`);

        // Ending the call must flip the verdict WITHOUT any message from the
        // browser: this is the backstop that kills a MediaProjection capture.
        await call("mutation", "calls:end", { callId: call2, token: a.token, status: "ended" });
        call2 = null;
        const dead = await call("query", "screenShare:sessionState", {
          sessionId: redeemed.sessionId,
        });
        if (dead?.live === false) pass("ending the call makes the companion session end itself");
        else fail(`sessionState after hangup was ${JSON.stringify(dead)}`);
      }
    }
  }
}

if (call2) {
  await call("mutation", "calls:end", { callId: call2, token: a.token, status: "declined" });
}

// ---- handoff refusal cases -----------------------------------------------
await call("mutation", "calls:end", { callId: call1, token: b.token, status: "ended" });
await call("mutation", "calls:end", { callId: call1, token: c.token, status: "ended" });
pass("ended the test calls");

await expectError(
  "an unissued screen-share handoff code is refused",
  () => call("action", "livekit:redeemScreenShareHandoff", { code: "A".repeat(43) }),
  "handoff_invalid",
);
await expectError(
  "a malformed screen-share handoff code is refused",
  () => call("action", "livekit:redeemScreenShareHandoff", { code: "not-a-code" }),
  "handoff_invalid",
);
await expectError(
  "a handoff cannot be requested without a valid session",
  () =>
    call("action", "livekit:requestScreenShareHandoff", {
      token: "not-a-real-token",
      callId: call1,
    }),
  "unauthorized",
);
// After the call ends every participant row carries leftAt, so the refusal
// comes from the participation guard; `call_not_live` is the second-line
// guard. Either way it fails CLOSED — assert the refusal, not one wording.
await expectRefusal(
  "a handoff cannot be requested for a call that already ended",
  () =>
    call("action", "livekit:requestScreenShareHandoff", {
      token: a.token,
      callId: call1,
    }),
  ["unauthorized", "call_not_live"],
);
const stranger = await register("D");
await expectError(
  "a stranger cannot mint a handoff for someone else's call",
  () =>
    call("action", "livekit:requestScreenShareHandoff", {
      token: stranger.token,
      callId: call1,
    }),
  "unauthorized",
);

// ---- an unredeemed code cannot outlive its own call -----------------------
// A handoff is only usable while the call is genuinely live: once the call has
// ended, redeeming the (still unconsumed, still unexpired) code must fail
// closed, exactly like a replay. Expiry itself is enforced by the same verdict
// and is unit-tested (src/lib/screenShareProtocol.test.ts); the TTL the action
// hands out is asserted above.
const call3 = await call("mutation", "calls:start", {
  conversationId,
  token: a.token,
  kind: "audio",
});
let orphanCode = null;
try {
  const handoff3 = await call("action", "livekit:requestScreenShareHandoff", {
    token: a.token,
    callId: call3,
  });
  orphanCode = handoff3.code;
  pass("minted a handoff for call #3 and deliberately left it unredeemed");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("livekit_not_configured")) skip(`unredeemed-code check skipped: ${msg}`);
  else fail(`could not mint a handoff for call #3: ${msg}`);
}
await call("mutation", "calls:end", { callId: call3, token: a.token, status: "ended" });
if (orphanCode) {
  await expectError(
    "a handoff minted before the call ended is refused after it",
    () => call("action", "livekit:redeemScreenShareHandoff", { code: orphanCode }),
    "handoff_invalid",
  );
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
