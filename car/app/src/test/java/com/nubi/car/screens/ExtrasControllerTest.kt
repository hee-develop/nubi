package com.nubi.car.screens

import com.nubi.car.trip.HttpFailure
import com.nubi.car.trip.directExecutor
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExtrasControllerTest {
    private class FakeApi : ExtrasApi {
        var settings = ServerSettings(false, null, true, true, false)
        val puts = ArrayList<JSONObject>()
        var deleted = 0
        var guestFails: Int? = null
        var guestCalls = 0
        override fun getSettings(vehicleId: String) = settings
        override fun putSettings(vehicleId: String, patch: JSONObject): ServerSettings {
            puts.add(patch)
            if (patch.has("recordingPaused")) settings = settings.copy(recordingPaused = patch.getBoolean("recordingPaused"))
            if (patch.has("drivingMap")) settings = settings.copy(drivingMap = patch.getBoolean("drivingMap"))
            return settings
        }
        override fun deleteData(vehicleId: String) {
            deleted++
            settings = settings.copy(recordingPaused = true, consentWithdrawn = true)
        }
        override fun regionsList(vehicleId: String) = listOf(DexItem("11110", "종로구", "서울 종로구", "서울", 2, false, false))
        override fun roads(vehicleId: String, almostOnly: Boolean, limit: Int) = listOf(RoadItem("k", "세종대로", 85.0, 850, 1000, false))
        override fun dailyReport(vehicleId: String, date: String) = Report(1, 2.0, 1.5, 0.0, listOf("서울 중구"), 1)
        override fun monthlyReport(vehicleId: String, month: String) = Report(3, 9.0, 4.0, 0.5, emptyList(), 2)
        override fun guestCode(vehicleId: String): CodeInfo {
            guestCalls++
            guestFails?.let { throw HttpFailure(it, "HTTP $it") }
            return CodeInfo("123456", "http://x/g/123456", 0)
        }
        override fun guestSessions(vehicleId: String) = 2
        override fun guestEndAll(vehicleId: String) = 2
        override fun pairCode(vehicleId: String) = CodeInfo("654321", "http://x/p/654321", 0)
        override fun shareNational(vehicleId: String) = "http://x/s/abc"
        override fun intro(code: String, lat: Double?, lon: Double?) = Intro(code, true, emptyList())
    }

    private var parked = true
    private var applied: ServerSettings? = null
    private var deletedHook = 0
    private var clock = 0L
    private val api = FakeApi()

    private fun controller() = ExtrasController(
        api, directExecutor, { "vid" }, { parked }, { clock },
        applySettings = { applied = it }, onDataDeleted = { deletedHook++ },
    )

    @Test
    fun 설정을_읽으면_반영_훅이_불리고_기록_멈춤은_철회도_포함한다() {
        val c = controller()
        c.refreshSettings()
        assertEquals(api.settings, applied)
        api.settings = api.settings.copy(consentWithdrawn = true)
        c.refreshSettings()
        assertTrue(applied!!.recordingBlocked)
    }

    @Test
    fun 기록_멈춤과_지도_토글은_부분_갱신으로_보낸다() {
        val c = controller()
        c.setPaused(true)
        c.setDrivingMap(false)
        c.setHomeRegion("11140")
        c.setHomeRegion(null)
        assertEquals(true, api.puts[0].getBoolean("recordingPaused"))
        assertEquals(1, api.puts[0].length())
        assertEquals(false, api.puts[1].getBoolean("drivingMap"))
        assertEquals("11140", api.puts[2].getString("homeRegion"))
        assertTrue(api.puts[3].isNull("homeRegion"))
        assertTrue(applied!!.recordingPaused)
    }

    @Test
    fun 데이터_지우기는_두_번_확인해야_서버를_부른다() {
        val c = controller()
        c.confirmDeleteFinal() // 확인 없이는 아무 일도 없다
        assertEquals(0, api.deleted)
        c.startDelete()
        c.confirmDeleteFinal() // 1단계에서 바로 최종 확인은 무시
        assertEquals(0, api.deleted)
        assertEquals(DeleteStep.CONFIRM_1, c.deleteStep)
        c.confirmDeleteFirst()
        assertEquals(DeleteStep.CONFIRM_2, c.deleteStep)
        c.cancelDelete()
        assertEquals(DeleteStep.NONE, c.deleteStep)
        assertEquals(0, api.deleted)
        c.startDelete(); c.confirmDeleteFirst(); c.confirmDeleteFinal()
        assertEquals(1, api.deleted)
        assertEquals(DeleteStep.DONE, c.deleteStep)
        assertEquals(1, deletedHook)
        assertTrue("지운 뒤 설정을 다시 읽어 철회 상태가 반영된다", applied!!.consentWithdrawn)
    }

    @Test
    fun 도감과_도로와_오늘은_열면_받는다() {
        val c = controller()
        c.loadDex(); c.loadRoads(); c.loadToday(0)
        assertEquals(1, c.dex.value!!.size)
        assertEquals("세종대로", c.almostRoads.value!![0].displayName)
        assertEquals(1.5, c.daily.value!!.newKm, 0.0)
        assertEquals(4.0, c.monthly.value!!.newKm, 0.0)
    }

    @Test
    fun 게스트_코드는_P에서만_받고_P를_벗어나면_바로_지운다() {
        val c = controller()
        parked = false
        c.requestGuestCode()
        assertEquals("정차가 아니면 서버를 부르지도 않는다", 0, api.guestCalls)
        parked = true
        c.requestGuestCode()
        assertEquals("123456", c.guest!!.code)
        assertNotNull(c.guest!!.matrix)
        parked = false
        c.closeCodes()
        assertNull(c.guest)
    }

    @Test
    fun 받는_사이_기어가_바뀌면_QR을_보이지_않고_버린다() {
        val c = ExtrasController(
            object : ExtrasApi by api {
                override fun guestCode(vehicleId: String): CodeInfo {
                    parked = false // 응답을 기다리는 사이 D로
                    return CodeInfo("111111", "http://x/g/111111", 0)
                }
            },
            directExecutor, { "vid" }, { parked }, { clock }, { },
        )
        c.requestGuestCode()
        assertNull(c.guest)
    }

    @Test
    fun 만료된_코드는_지운다() {
        val c = controller()
        c.requestGuestCode()
        clock = 299_000
        c.expireCodes()
        assertNotNull(c.guest)
        clock = 300_000
        c.expireCodes()
        assertNull(c.guest)
    }

    @Test
    fun 서버_오류는_종류별_오류로_남는다() {
        val c = controller()
        api.guestFails = 409
        c.requestGuestCode()
        assertEquals(CodeKind.GUEST to CodeError.GUEST_LIMIT, c.codeError)
        api.guestFails = 403
        c.requestGuestCode()
        assertEquals(CodeError.NOT_PARKED, c.codeError!!.second)
        api.guestFails = 500
        c.requestGuestCode()
        assertEquals(CodeError.FAILED, c.codeError!!.second)
        assertFalse(c.guest != null)
    }

    @Test
    fun 모두_내리기는_인원을_0으로_하고_QR을_지운다() {
        val c = controller()
        c.requestGuestCode()
        c.refreshGuestCount()
        assertEquals(2, c.guestCount)
        c.endAllGuests()
        assertEquals(0, c.guestCount)
        assertNull(c.guest)
    }

    @Test
    fun 공유와_차주_연결_QR() {
        val c = controller()
        c.requestShare(); c.requestPairCode()
        assertEquals("http://x/s/abc", c.share!!.url)
        assertNull(c.share!!.code)
        assertEquals("654321", c.pair!!.code)
    }
}
