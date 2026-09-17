package com.garma.screenshare

import java.net.URI

/** Pure response guards: malformed credentials never reach capture startup. */
object HandoffPolicy {
    fun isSecureRoomUrl(value: String): Boolean = try {
        val uri = URI(value)
        value.length <= 2048 && uri.scheme == "wss" && !uri.host.isNullOrEmpty() &&
            uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
            (uri.port == -1 || uri.port in 1..65535)
    } catch (_: Exception) { false }

    fun validCredentials(url: String, token: String, room: String, identity: String, sessionId: String): Boolean =
        isSecureRoomUrl(url) && token.length in 20..8192 && room.length in 1..256 &&
            identity.length in 8..256 && identity.endsWith(":screen") && sessionId.length in 1..128 &&
            listOf(token, room, identity, sessionId).none { value -> value.any { it.isISOControl() } }
}
