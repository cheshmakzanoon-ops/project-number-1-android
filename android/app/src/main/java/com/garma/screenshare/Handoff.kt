package com.garma.screenshare

import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * The restricted LiveKit credentials the server mints for one MediaProjection
 * session. Nothing here is stored: they live in memory for the length of one
 * share and are gone when the service stops.
 */
data class ScreenShareCredentials(
    val url: String,
    val token: String,
    val room: String,
    val identity: String,
    val sessionId: String,
    val displayName: String,
)

/**
 * Talks to the SAME Convex deployment the web app uses, over its public HTTP
 * API, with the deployment URL baked into the build (`BuildConfig.CONVEX_URL`).
 *
 * Two calls only:
 *
 *  - `redeem(code)` — exchange the opaque one-time code (the sole thing that
 *    travelled through the deep link) for a restricted LiveKit grant. The
 *    server consumes the code exactly once, and mints the auxiliary
 *    "<userId>:screen" identity itself; this client never chooses an identity,
 *    a room, a source or a TTL.
 *  - `sessionLive(sessionId)` — poll whether the share is still allowed (the
 *    call still ringing/active and the user still a present participant). This
 *    is how a hangup on the web side ends the capture even if a stop message
 *    never arrives.
 *
 * No secrets are ever logged, and error messages carry only a short reason.
 */
object HandoffClient {

    private const val REDEEM_PATH = "livekit:redeemScreenShareHandoff"
    private const val SESSION_PATH = "screenShare:sessionState"

    fun redeem(convexUrl: String, code: String): ScreenShareCredentials {
        val body = JSONObject()
            .put("path", REDEEM_PATH)
            .put("args", JSONObject().put("code", code))
            .put("format", "json")
            .toString()
        val value = post("$convexUrl/api/action", body)
        return ScreenShareCredentials(
            url = value.getString("url"),
            token = value.getString("token"),
            room = value.getString("room"),
            identity = value.getString("identity"),
            sessionId = value.getString("sessionId"),
            displayName = value.optString("displayName", ""),
        )
    }

    /** True while the server still allows this capture to publish. */
    fun sessionLive(convexUrl: String, sessionId: String): Boolean {
        val body = JSONObject()
            .put("path", SESSION_PATH)
            .put("args", JSONObject().put("sessionId", sessionId))
            .put("format", "json")
            .toString()
        return post("$convexUrl/api/query", body).optBoolean("live", false)
    }

    private fun post(endpoint: String, body: String): JSONObject {
        val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 10_000
            readTimeout = 15_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        try {
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = conn.responseCode
            val text = (if (status in 200..299) conn.inputStream else conn.errorStream)
                ?.let { stream -> BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).readText() }
                ?: ""
            if (text.isEmpty()) throw IOException("empty_response")
            val json = JSONObject(text)
            if (json.optString("status") != "success") {
                // The server's own reason is short and carries no credential
                // ("handoff_invalid", "unauthorized", …).
                throw IOException(json.optString("errorMessage", "request_failed").take(180))
            }
            return json.getJSONObject("value")
        } finally {
            conn.disconnect()
        }
    }
}
