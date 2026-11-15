package com.nubi.car.screens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class ExtrasModelsTest {
    @Test
    fun 설정_응답을_읽는다() {
        val s = parseSettings("""{"recordingPaused":true,"homeRegion":"11140","statsOptIn":false,"drivingMap":false,"hideHomeInCards":true,"consentWithdrawnAt":null}""")
        assertTrue(s.recordingPaused); assertEquals("11140", s.homeRegion); assertFalse(s.drivingMap); assertFalse(s.consentWithdrawn)
        val w = parseSettings("""{"recordingPaused":false,"homeRegion":null,"consentWithdrawnAt":"2026-11-12T00:00:00.000Z"}""")
        assertNull(w.homeRegion); assertTrue(w.consentWithdrawn); assertTrue(w.recordingBlocked)
    }

    @Test(expected = IOException::class)
    fun 형식이_틀리면_IOException() {
        parseSettings("{}")
    }

    @Test
    fun 도감을_시도별로_묶고_요약한다() {
        val items = parseDex(
            """{"items":[
              {"code":"11110","name":"종로구","displayName":"서울 종로구","sidoName":"서울","level":2,"depop92":false,"faded":false},
              {"code":"11140","name":"중구","displayName":"서울 중구","sidoName":"서울","level":0,"depop92":false},
              {"code":"42720","name":"홍천군","displayName":"강원 홍천군","sidoName":"강원","level":1,"depop92":true,"faded":true}]}""",
        )
        val g = groupBySido(items)
        assertEquals(listOf("서울", "강원"), g.map { it.sido })
        assertEquals(1, g[0].colored)
        assertTrue(items[2].faded)
        assertFalse(items[1].faded)
        val s = dexSummary(items)
        assertEquals(DexSummary(2, 3, 1, 1), s)
    }

    @Test
    fun 리포트와_코드_소개를_읽는다() {
        val r = parseReport("""{"date":"2026-11-12","tripCount":2,"distanceKm":3.5,"newKm":1.2,"newWays":4,"revivedKm":0.3,"newRegions":[{"code":"1","displayName":"서울 중구","sidoName":"서울"}],"newStays":[]}""")
        assertEquals(1.2, r.newKm, 0.0); assertEquals(listOf("서울 중구"), r.newRegions)
        val c = parseCode("""{"code":"012345","url":"http://h/g/012345","expiresAt":"2026-11-12T01:05:00.000Z"}""")
        assertEquals("012345", c.code)
        assertEquals(parseIsoMillis("2026-11-12T01:05:00.000Z"), c.expiresAtMs)
        val i = parseIntro("""{"sample":true,"code":"11110","items":[{"kind":"attraction","title":"A (예시)","lat":37.5,"lon":127.0,"addr":"x"},{"kind":"festival","title":"F","lat":37.6,"lon":127.1}]}""")
        assertTrue(i.sample)
        assertEquals(37.5, i.first("attraction")!!.lat, 0.0)
        assertNull(i.first("festival")!!.addr)
        assertNull(i.first("food"))
    }

    @Test
    fun KST_날짜와_달() {
        // 2026-11-11T16:00:00Z = 2026-11-12 01:00 KST
        val ms = parseIsoMillis("2026-11-11T16:00:00.000Z")
        assertEquals("2026-11-12", kstDate(ms))
        assertEquals("2026-11", kstMonth(ms))
        assertEquals("2026-11-11", kstDate(parseIsoMillis("2026-11-11T14:59:59.000Z")))
    }

    @Test
    fun 도로_목록() {
        val r = parseRoads("""{"items":[{"roadKey":"nm:1","displayName":"세종대로","percent":85.5,"drivenM":855,"totalM":1000,"completed":false}],"total":1}""")
        assertEquals(85.5, r[0].percent, 0.0)
    }
}
