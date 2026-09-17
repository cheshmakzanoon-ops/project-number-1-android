package com.garma.screenshare

/** Monotonic authorization lease. Network errors do not renew permission. */
internal class ScreenShareLease(now: Long, private val ttlMs: Long = 30_000L) {
    private var verifiedAt = now
    fun renew(now: Long) { verifiedAt = now }
    fun expired(now: Long): Boolean = now - verifiedAt >= ttlMs
}

/** Identity is supplied by LiveKit, never by an untrusted JSON payload. */
internal fun isOwnerStop(sender: String?, owner: String?, topic: String?, type: String?): Boolean =
    !owner.isNullOrEmpty() && sender == owner && topic == "garma.screen-share" && type == "stop"
