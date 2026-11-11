package com.nubi.car.trip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException
import java.util.concurrent.Executor

class PlaceTest {
    private val direct = Executor { it.run() }
    private val here = LatLon(37.56, 126.98)
    private val jung = PlaceAt("11140", "서울 중구", 2, false)
    private val nb = Neighbor("11110", "서울 종로구", 0, false, 37.6, 127.0)

    private class FakeApi(
        var at: () -> PlaceAt? = { null },
        var neighbors: () -> List<Neighbor> = { emptyList() },
    ) : PlaceApi {
        var atCalls = 0
        var nbCalls = 0
        override fun getRegionAt(lat: Double, lon: Double, vehicleId: String): PlaceAt? {
            atCalls++
            return at()
        }

        override fun getNeighbors(code: String, vehicleId: String): List<Neighbor> {
            nbCalls++
            return neighbors()
        }
    }

    private fun tracker(api: PlaceApi, id: () -> String? = { "v" }, loc: () -> LatLon? = { here }, scheduled: MutableList<Pair<Long, () -> Unit>> = mutableListOf()) =
        PlaceTracker(api, direct, id, loc, { d, b -> scheduled += d to b }, 30_000)

    @Test
    fun 조회하면_현재_시군구와_첫_이웃을_담는다() {
        val api = FakeApi({ jung }, { listOf(nb, nb.copy(code = "x")) })
        val t = tracker(api)
        t.refresh()
        assertEquals(PlaceInfo(jung, nb), t.info)
        assertEquals(1, api.atCalls)
        assertEquals(1, api.nbCalls)
    }

    @Test
    fun 위치를_모르면_조회하지_않는다() {
        val api = FakeApi({ jung })
        tracker(api, loc = { null }).refresh()
        assertEquals(0, api.atCalls)
    }

    @Test
    fun 실패하면_마지막_성공_값을_유지하고_30초_뒤_한_번만_다시_시도한다() {
        val api = FakeApi({ jung }, { listOf(nb) })
        val sched = mutableListOf<Pair<Long, () -> Unit>>()
        val t = tracker(api, scheduled = sched)
        t.refresh()
        api.at = { throw IOException("끊김") }
        t.refresh()
        assertEquals(PlaceInfo(jung, nb), t.info)
        assertEquals(1, sched.size)
        assertEquals(30_000L, sched[0].first)
        sched[0].second() // 재시도도 실패해도 더 예약하지 않는다
        assertEquals(1, sched.size)
        assertEquals(PlaceInfo(jung, nb), t.info)
    }

    @Test
    fun 이웃_조회만_실패하면_같은_시군구는_옛_이웃을_유지하고_다른_시군구는_버린다() {
        val api = FakeApi({ jung }, { listOf(nb) })
        val t = tracker(api)
        t.refresh()
        api.neighbors = { throw IOException("x") }
        t.refresh()
        assertEquals(PlaceInfo(jung, nb), t.info)
        api.at = { PlaceAt("11110", "서울 종로구", 1, false) }
        t.refresh()
        assertEquals("서울 종로구", t.info.place?.displayName)
        assertNull(t.info.neighbor)
    }

    @Test
    fun 시군구를_못_찾으면_값을_지운다() {
        val api = FakeApi({ jung }, { listOf(nb) })
        val t = tracker(api)
        t.refresh()
        api.at = { null }
        t.refresh()
        assertEquals(PlaceInfo(null, null), t.info)
    }

    @Test
    fun 차량_ID가_없으면_예약해서_기다린다() {
        val api = FakeApi({ jung }, { listOf(nb) })
        var id: String? = null
        val sched = mutableListOf<Pair<Long, () -> Unit>>()
        val t = tracker(api, id = { id }, scheduled = sched)
        t.refresh()
        assertEquals(0, api.atCalls)
        assertEquals(1, sched.size)
        id = "v"
        sched[0].second()
        assertEquals(PlaceInfo(jung, nb), t.info)
    }

    @Test
    fun 예외가_executor_밖으로_새지_않는다() {
        val api = FakeApi({ throw IllegalStateException("x") })
        tracker(api).refresh()
    }

    @Test
    fun 안_가_본_이웃만_고르고_모두_가_봤으면_표시한다() {
        val visited = nb.copy(level = 2)
        val api = FakeApi({ jung }, { listOf(visited, nb.copy(code = "b", level = 0, displayName = "서울 용산구")) })
        val t = tracker(api)
        t.refresh()
        assertEquals("서울 용산구", t.info.neighbor?.displayName)
        assertEquals(false, t.info.neighborsAllVisited)
        api.neighbors = { listOf(visited, visited.copy(code = "c", level = 3)) }
        t.refresh()
        assertNull(t.info.neighbor)
        assertEquals(true, t.info.neighborsAllVisited)
        api.neighbors = { emptyList() } // 이웃 자체가 없으면 '모두 가 봤다'가 아니다
        t.refresh()
        assertEquals(false, t.info.neighborsAllVisited)
    }

    @Test
    fun 새_위치가_2km_이상_멀어지면_조회_전에_옛_값을_비운다() {
        val api = FakeApi({ jung }, { listOf(nb) })
        var loc: LatLon? = here
        val t = tracker(api, loc = { loc })
        t.refresh()
        assertEquals(PlaceInfo(jung, nb), t.info)
        // 오프라인: 이후 조회가 모두 실패한다
        api.at = { throw IOException("끊김") }
        loc = LatLon(here.lat + 0.005, here.lon) // 약 555m: 아직 같은 곳으로 본다
        t.refresh()
        assertEquals(PlaceInfo(jung, nb), t.info)
        loc = LatLon(here.lat + 0.03, here.lon) // 약 3.3km: 옛 시군구를 '지금'으로 두지 않는다
        t.refresh()
        assertEquals(PlaceInfo(null, null), t.info)
    }

    @Test
    fun clear하면_값과_기준_위치를_모두_지운다() {
        val api = FakeApi({ jung }, { listOf(nb) })
        val t = tracker(api)
        t.refresh()
        t.clear()
        assertEquals(PlaceInfo(null, null), t.info)
    }
}
