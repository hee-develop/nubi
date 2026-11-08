package com.nubi.car.trip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class QueueTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun 큐_항목은_JSON_한_줄로_왕복한다() {
        val entries = listOf(
            QueueEntry.Start("a", "veh", "veh", 1_000, null),
            QueueEntry.Point("a", TripPoint(3, Sample(2_000, 37.5, 127.0, 90f, 0.5f, Gear.D))),
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
    fun 속도는_저장하지_않는다() {
        assertFalse(QueueCodec.encode(QueueEntry.Point("a", point(1))).contains("speed"))
    }

    @Test
    fun 깨진_줄은_버린다() {
        assertNull(QueueCodec.decode("{not json"))
    }

    @Test
    fun 파일은_줄_단위로_암호화되고_왕복한다() {
        val cipher = testCipher()
        val file = File(tmp.root, "q.jsonl")
        val q = TripQueue(file, cipher)
        val entries = listOf(start("a"), *points("a", 0..2), QueueEntry.End("a", 9_000, null))
        q.append(entries)
        val raw = file.readText()
        assertFalse("평문 좌표가 파일에 보이면 안 된다", raw.contains("37.5") || raw.contains("lat") || raw.contains("veh"))
        assertEquals(entries.size, raw.lines().count { it.isNotBlank() })
        assertEquals(entries, TripQueue(file, cipher).load().entries)
    }

    @Test
    fun 키가_다르거나_평문인_줄은_건너뛴다() {
        val file = File(tmp.root, "q.jsonl")
        TripQueue(file, testCipher()).append(listOf(start("a")))
        file.appendText(QueueCodec.encode(start("legacy")) + "\n")
        val loaded = TripQueue(file, testCipher()).load()
        assertEquals(0, loaded.entries.size) // 다른 키 + 평문 줄 모두 건너뜀
        assertEquals(2, loaded.corrupt) // 건너뛴 줄은 센다
    }

    @Test
    fun rewrite는_파일을_통째로_바꾼다() {
        val cipher = testCipher()
        val file = File(tmp.root, "q.jsonl")
        val q = TripQueue(file, cipher)
        q.append(listOf(start("a"), start("b")))
        q.rewrite(listOf(start("b")))
        assertEquals(listOf(start("b")), q.load().entries)
        assertTrue(File(tmp.root, "q.jsonl.tmp").exists().not())
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
