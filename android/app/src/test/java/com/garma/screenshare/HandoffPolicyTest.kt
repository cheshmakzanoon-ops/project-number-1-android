package com.garma.screenshare

import org.junit.Assert.*
import org.junit.Test

class HandoffPolicyTest {
    @Test fun secureHostAndExplicitPortAreAccepted() {
        assertTrue(HandoffPolicy.isSecureRoomUrl("wss://media.example.test"))
        assertTrue(HandoffPolicy.isSecureRoomUrl("wss://media.example.test:443"))
    }
    @Test fun plaintextAndNonWebSocketSchemesAreRejected() {
        for (url in listOf("ws://media.test", "http://media.test", "https://media.test", "file:///media")) {
            assertFalse(HandoffPolicy.isSecureRoomUrl(url))
        }
    }
    @Test fun credentialQueryAndFragmentUrlsAreRejected() {
        for (url in listOf("wss://user:password@media.test", "wss://media.test?token=x", "wss://media.test#token")) {
            assertFalse(HandoffPolicy.isSecureRoomUrl(url))
        }
    }
    @Test fun malformedAndMissingHostsAreRejected() {
        for (url in listOf("wss:///path", "wss://", "wss://bad host", "wss://media.test:99999")) {
            assertFalse(HandoffPolicy.isSecureRoomUrl(url))
        }
    }
    private fun valid(token: String = "a".repeat(40), identity: String = "owner:screen", room: String = "room", session: String = "session") =
        HandoffPolicy.validCredentials("wss://media.test", token, room, identity, session)
    @Test fun wellFormedScreenOnlyIdentityIsAccepted() { assertTrue(valid()) }
    @Test fun nonScreenIdentityIsRejected() { assertFalse(valid(identity = "owner")) }
    @Test fun emptyOversizedAndControlFieldsAreRejected() {
        assertFalse(valid(token = ""))
        assertFalse(valid(token = "a".repeat(8193)))
        assertFalse(valid(room = ""))
        assertFalse(valid(session = ""))
        assertFalse(valid(room = "bad\nroom"))
    }
}
