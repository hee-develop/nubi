package com.nubi.car.trip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QueueTest {
    @Test
    fun 큐_항목은_JSON_한_줄로_왕복한다() {
        val entries = listOf(
            QueueEntry.Start("a", "veh", "veh", 1_000, null),
            QueueEntry.Point("a", TripPoint(3, Sample(2_000, 37.5, 127.0, 90f, 0.5f, 42f, Gear.D))),
            QueueEntry.Point("a", TripPoint(4, Sample(3_000, 37.6, 127.1))),
            QueueEntry.End("a", 3_000, 12.5),
        )
        entries.forEach {
            val line = QueueCodec.encode(it)
            assertEquals(false, line.contains('\n'))
            assertEquals(it, QueueCodec.decode(line))
        }
    }

    @Test
    fun 깨진_줄은_버린다() {
        assertNull(QueueCodec.decode("{not json"))
    }

    @Test
    fun 재시도_간격은_2초부터_두_배씩_최대_5분이다() {
        assertEquals(0L, backoffMillis(0))
        assertEquals(2_000L, backoffMillis(1))
        assertEquals(4_000L, backoffMillis(2))
        assertEquals(64_000L, backoffMillis(6))
        assertEquals(300_000L, backoffMillis(9))
        assertEquals(300_000L, backoffMillis(100))
    }
}
