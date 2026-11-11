package com.nubi.car.map

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class MapParseTest {
    private val key = CellKey(14, 1693, 500)

    @Test
    fun 바탕_도로_응답을_읽는다() {
        val json = """{"z":14,"truncated":true,"ways":[
          {"id":11,"cls":"mw","rk":"mw:1","c":[[127.0,37.5],[127.01,37.5]]},
          {"id":12,"cls":"mn","rk":"nm:a","c":[[127.0,37.5],[127.0,37.51],[127.01,37.51]],"d":{"at":"2026-02-01T00:00:00.000Z","cov":0.8}}
        ]}"""
        val cell = parseBase(json, key)
        assertEquals(key, cell.key)
        assertTrue(cell.truncated)
        assertEquals(2, cell.ways.size)
        val a = cell.ways[0]
        assertEquals(CLS_MW, a.cls)
        assertFalse(a.driven)
        assertEquals(mercX(127.0), a.mx[0], 1e-12)
        assertEquals(mercY(37.5), a.my[0], 1e-12)
        assertEquals(mercX(127.0), a.minX, 1e-12)
        assertEquals(mercX(127.01), a.maxX, 1e-12)
        val b = cell.ways[1]
        assertEquals(CLS_MN, b.cls)
        assertTrue(b.driven)
        assertEquals(java.time.Instant.parse("2026-02-01T00:00:00Z").toEpochMilli(), b.drivenAtMs)
        assertEquals(0.8, b.coverage, 1e-9)
        assertEquals(3, b.mx.size)
        // 북쪽 점이 y가 작다
        assertTrue(b.my[1] < b.my[0])
    }

    @Test
    fun 모양이_틀린_way는_건너뛰고_칸은_살린다() {
        val json = """{"ways":[
          {"id":1,"cls":"mw","c":[[127.0,37.5]]},
          {"cls":"mw","c":[[127.0,37.5],[127.1,37.5]]},
          {"id":3,"cls":"zz","c":[[127.0,37.5],[127.1,37.5]]}
        ]}"""
        val cell = parseBase(json, key)
        assertEquals(listOf(3L), cell.ways.map { it.id })
        assertEquals(CLS_MN, cell.ways[0].cls) // 모르는 등급은 그 밖(mn)
        assertFalse(cell.truncated)
    }

    @Test
    fun JSON이_아니거나_ways가_없으면_예외() {
        for (bad in listOf("<html>", "", """{"error":"x"}""")) {
            try {
                parseBase(bad, key)
                fail("예외가 나야 한다: $bad")
            } catch (e: MapParseException) {
                // 기대한 동작
            }
        }
    }

    @Test
    fun 잠정_색칠_응답을_읽는다() {
        val json = """{"status":"ready","upToSeq":59,"ways":[
          {"id":1,"c":[[127.0,37.5],[127.0,37.51]],"isNew":true},
          {"id":2,"c":[[127.0,37.51],[127.0,37.52]],"isNew":false}],
          "region":{"code":"11140","displayName":"서울 중구","level":0,"firstTime":true}}"""
        val s = parseLive(json, 1234L)
        assertEquals("ready", s.status)
        assertEquals(59, s.upToSeq)
        assertEquals(2, s.ways.size)
        assertEquals(1, s.newCount)
        assertTrue(s.ways[0].isNew)
        assertEquals(LiveRegion("11140", "서울 중구", 0, true), s.region)
        assertEquals(1234L, s.receivedAtMs)
    }

    @Test
    fun 잠정_색칠은_region이_없어도_읽는다() {
        val s = parseLive("""{"status":"idle","upToSeq":-1,"ways":[]}""", 5L)
        assertEquals("idle", s.status)
        assertNull(s.region)
        assertTrue(s.ways.isEmpty())
        assertEquals(0, s.newCount)
    }

    @Test
    fun 시군구_응답을_링_목록으로_읽는다() {
        val json = """{"z":8,"regions":[
          {"code":"11140","name":"서울 중구","level":2,"depop":false,"faded":true,"p":[[[[127.0,37.5],[127.1,37.5],[127.1,37.6],[127.0,37.5]]]]},
          {"code":"26110","name":"부산 중구","level":0,"depop":true,"faded":false,"p":[[[[129.0,35.0],[129.1,35.0],[129.1,35.1],[129.0,35.0]],[[129.02,35.02],[129.04,35.02],[129.04,35.04],[129.02,35.02]]]]},
          {"code":"x","name":"빈","level":0,"depop":false,"faded":false,"p":[]}
        ]}"""
        val cell = parseRegions(json, RegionCellKey(8, 7, 2))
        assertEquals(2, cell.regions.size) // 링이 없는 지역은 건너뜀
        val jung = cell.regions[0]
        assertEquals(2, jung.level)
        assertTrue(jung.faded)
        assertEquals(1, jung.ringsX.size)
        assertEquals(4, jung.ringsX[0].size)
        val busan = cell.regions[1]
        assertTrue(busan.depop)
        assertEquals(2, busan.ringsX.size) // 바깥 링과 구멍 링
        assertNotNull(busan.minX)
        assertTrue(busan.minX < busan.maxX)
    }
}
