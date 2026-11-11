package com.nubi.car.screens

import com.nubi.car.trip.HttpFailure
import com.nubi.car.trip.LatLon
import com.nubi.car.trip.directExecutor
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IntroTrackerTest {
    private class Api(var behavior: (String, Double?, Double?) -> Intro) : ExtrasApi {
        val calls = ArrayList<Triple<String, Double?, Double?>>()
        override fun intro(code: String, lat: Double?, lon: Double?): Intro {
            calls.add(Triple(code, lat, lon))
            return behavior(code, lat, lon)
        }
        override fun getSettings(vehicleId: String) = throw UnsupportedOperationException()
        override fun putSettings(vehicleId: String, patch: JSONObject) = throw UnsupportedOperationException()
        override fun deleteData(vehicleId: String) = throw UnsupportedOperationException()
        override fun regionsList(vehicleId: String) = throw UnsupportedOperationException()
        override fun roads(vehicleId: String, almostOnly: Boolean, limit: Int) = throw UnsupportedOperationException()
        override fun dailyReport(vehicleId: String, date: String) = throw UnsupportedOperationException()
        override fun monthlyReport(vehicleId: String, month: String) = throw UnsupportedOperationException()
        override fun guestCode(vehicleId: String) = throw UnsupportedOperationException()
        override fun guestSessions(vehicleId: String) = throw UnsupportedOperationException()
        override fun guestEndAll(vehicleId: String) = throw UnsupportedOperationException()
        override fun pairCode(vehicleId: String) = throw UnsupportedOperationException()
        override fun shareNational(vehicleId: String) = throw UnsupportedOperationException()
    }

    private var now = 0L
    private val intro = Intro("11110", true, listOf(IntroItem("attraction", "A (예시)", 37.5, 127.0, null)))

    @Test
    fun 시군구마다_한_번만_받고_같은_시군구면_다시_묻지_않는다() {
        val api = Api { _, _, _ -> intro }
        val t = IntroTracker(api, directExecutor, { now })
        t.ensure("11110", LatLon(37.5, 127.0))
        t.ensure("11110", LatLon(37.5, 127.0))
        assertEquals(1, api.calls.size)
        assertEquals("11110", t.intro!!.code)
        assertEquals(37.5, api.calls[0].second!!, 0.0)
    }

    @Test
    fun 실패하면_일정_시간_다시_묻지_않고_지나면_다시_시도한다() {
        var fail = true
        val api = Api { _, _, _ -> if (fail) throw HttpFailure(429, "HTTP 429") else intro }
        val t = IntroTracker(api, directExecutor, { now }, retryMs = 60_000)
        t.ensure("11110", null)
        assertNull(t.intro)
        now = 30_000
        t.ensure("11110", null)
        assertEquals(1, api.calls.size)
        fail = false
        now = 61_000
        t.ensure("11110", null)
        assertEquals(2, api.calls.size)
        assertTrue(t.intro != null)
    }

    @Test
    fun 위치가_시군구_밖이라_400이면_좌표_없이_다시_묻는다() {
        val api = Api { _, lat, _ -> if (lat != null) throw HttpFailure(400, "HTTP 400") else intro }
        val t = IntroTracker(api, directExecutor, { now })
        t.ensure("11110", LatLon(35.0, 129.0))
        assertEquals(2, api.calls.size)
        assertNull(api.calls[1].second)
        assertEquals("11110", t.intro!!.code)
    }

    @Test
    fun 시군구가_바뀌면_새로_받는다() {
        val api = Api { code, _, _ -> intro.copy(code = code) }
        val t = IntroTracker(api, directExecutor, { now })
        t.ensure("11110", null)
        t.ensure("11140", null)
        assertEquals(listOf("11110", "11140"), api.calls.map { it.first })
        assertEquals("11140", t.intro!!.code)
        t.clear()
        assertNull(t.intro)
    }
}
