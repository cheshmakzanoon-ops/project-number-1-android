package com.garma.screenshare

import org.junit.Assert.*
import org.junit.Test

class ScreenShareLeaseTest {
    @Test fun `network silence expires permission exactly at thirty seconds`() {
        val lease = ScreenShareLease(100L)
        assertFalse(lease.expired(30_099L))
        assertTrue(lease.expired(30_100L))
    }
    @Test fun `only a positive server verdict renews the lease`() {
        val lease = ScreenShareLease(0L)
        lease.renew(20_000L)
        assertFalse(lease.expired(49_999L))
        assertTrue(lease.expired(50_000L))
    }
    @Test fun `matching topic from another participant cannot stop the share`() {
        assertFalse(isOwnerStop("other", "owner", "garma.screen-share", "stop"))
        assertFalse(isOwnerStop(null, "owner", "garma.screen-share", "stop"))
    }
    @Test fun `only an explicit stop from the authenticated owner is accepted`() {
        assertTrue(isOwnerStop("owner", "owner", "garma.screen-share", "stop"))
        assertFalse(isOwnerStop("owner", "owner", "different-topic", "stop"))
        assertFalse(isOwnerStop("owner", "owner", "garma.screen-share", null))
        assertFalse(isOwnerStop("owner", "owner", "garma.screen-share", "start"))
    }
    @Test fun `missing owner cannot authorize a stop`() {
        assertFalse(isOwnerStop(null, null, "garma.screen-share", "stop"))
        assertFalse(isOwnerStop("", "", "garma.screen-share", "stop"))
    }
}
