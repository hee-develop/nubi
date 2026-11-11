package com.nubi.car.screens

import com.nubi.car.trip.Gear
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
        var guestCode: String? = null
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
        val gears = ArrayList<String>()
        override fun guestCode(vehicleId: String, gear: String): CodeInfo {
            guestCalls++
            gears.add(gear)
            guestFails?.let { throw HttpFailure(it, "HTTP $it", guestCode) }
            return CodeInfo("123456", "http://x/g/123456", 0)
        }
        override fun guestSessions(vehicleId: String) = 2
        override fun guestEndAll(vehicleId: String) = 2
        override fun pairCode(vehicleId: String, gear: String) = CodeInfo("654321", "http://x/p/654321", 0)
        override fun shareNational(vehicleId: String) = "http://x/s/abc"
        override fun intro(code: String, lat: Double?, lon: Double?) = Intro(code, true, emptyList())
    }

    private var parked = true
    private var gear: Gear? = Gear.P
    private var localPaused: Boolean? = null
    private var applied: ServerSettings? = null
    private var deletedHook = 0
    private var clock = 0L
    private val api = FakeApi()

    private fun controller(executor: java.util.concurrent.Executor = directExecutor) = ExtrasController(
        api, executor, { "vid" }, { parked }, { clock },
        applySettings = { applied = it }, onDataDeleted = { deletedHook++ },
        applyLocalPause = { localPaused = it }, gear = { gear },
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
                override fun guestCode(vehicleId: String, gear: String): CodeInfo {
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
        api.guestCode = "not_parked"
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

    @Test
    fun 기록_멈춤_켜기는_서버를_기다리지_않고_로컬에_바로_적용하고_실패하면_다시_보낸다() {
        val failing = object : ExtrasApi by api {
            var fail = true
            override fun putSettings(vehicleId: String, patch: JSONObject): ServerSettings {
                if (fail) throw java.io.IOException("offline")
                return api.putSettings(vehicleId, patch)
            }
        }
        val c = ExtrasController(failing, directExecutor, { "vid" }, { parked }, { clock }, applySettings = { applied = it }, applyLocalPause = { localPaused = it }, gear = { gear })
        c.refreshSettings()
        c.setPaused(true)
        assertEquals("오프라인이어도 로컬은 멈춘다", true, localPaused)
        assertTrue(c.pausePending)
        assertTrue(c.settings!!.recordingPaused)
        // 서버 설정을 읽으려 해도(옛 값 false) 대기 중인 멈춤을 덮어쓰지 않는다
        c.refreshSettings()
        assertTrue(c.pausePending)
        assertEquals(true, localPaused)
        failing.fail = false
        c.syncPendingPause()
        assertFalse(c.pausePending)
        assertTrue(applied!!.recordingPaused)
    }

    @Test
    fun 기록_멈춤_끄기는_서버가_확인한_뒤에만_적용한다() {
        val failing = object : ExtrasApi by api {
            override fun putSettings(vehicleId: String, patch: JSONObject): ServerSettings = throw java.io.IOException("offline")
        }
        api.settings = api.settings.copy(recordingPaused = true)
        val c = ExtrasController(failing, directExecutor, { "vid" }, { parked }, { clock }, applySettings = { applied = it }, applyLocalPause = { localPaused = it }, gear = { gear })
        c.refreshSettings()
        c.setPaused(false)
        assertNull("서버가 확인하기 전에는 로컬 멈춤을 풀지 않는다", localPaused)
        assertTrue(applied!!.recordingPaused)
    }

    @Test
    fun 데이터_삭제_뒤_설정_조회가_실패해도_로컬_정리는_이미_끝났다() {
        var order = ""
        val failing = object : ExtrasApi by api {
            override fun deleteData(vehicleId: String) { order += "D"; api.deleteData(vehicleId) }
            override fun getSettings(vehicleId: String): ServerSettings = throw java.io.IOException("offline")
        }
        val c = ExtrasController(failing, directExecutor, { "vid" }, { parked }, { clock }, applySettings = { applied = it }, onDataDeleted = { order += "P" }, applyLocalPause = { localPaused = it }, gear = { gear })
        c.startDelete(); c.confirmDeleteFirst(); c.confirmDeleteFinal()
        assertEquals("서버 삭제 성공 뒤에 로컬 정리", "DP", order)
        assertEquals(DeleteStep.DONE, c.deleteStep)
        assertTrue("설정 조회 실패는 표시만 하고 로컬 상태를 되돌리지 않는다", c.settingsError)
        assertNull("삭제 전 읽어 둔 설정이 없으니 풀린 적도 없다", applied)
    }

    @Test
    fun 삭제_실행기가_작업을_거절하면_FAILED로_두고_다시_시도할_수_있다() {
        val rejecting = java.util.concurrent.Executor { throw java.util.concurrent.RejectedExecutionException("full") }
        val c = controller(rejecting)
        c.startDelete(); c.confirmDeleteFirst(); c.confirmDeleteFinal()
        assertEquals(DeleteStep.FAILED, c.deleteStep)
        assertEquals(0, api.deleted)
        c.startDelete()
        assertEquals("실패 뒤 다시 시작할 수 있다", DeleteStep.CONFIRM_1, c.deleteStep)
    }

    @Test
    fun 삭제_서버_호출이_던지면_FAILED이고_로컬_정리를_하지_않는다() {
        val boom = object : ExtrasApi by api {
            override fun deleteData(vehicleId: String) = throw IllegalStateException("x")
        }
        val c = ExtrasController(boom, directExecutor, { "vid" }, { parked }, { clock }, applySettings = { }, onDataDeleted = { deletedHook++ }, gear = { gear })
        c.startDelete(); c.confirmDeleteFirst(); c.confirmDeleteFinal()
        assertEquals(DeleteStep.FAILED, c.deleteStep)
        assertEquals(0, deletedHook)
    }

    @Test
    fun 화면을_쓸_수_없는_상태에서는_삭제와_설정_변경을_받지_않는다() {
        val c = controller()
        parked = false
        c.startDelete()
        assertEquals(DeleteStep.NONE, c.deleteStep)
        c.setPaused(true)
        assertNull(localPaused)
        c.setDrivingMap(false)
        assertTrue(api.puts.isEmpty())
    }

    @Test
    fun QR은_실제_기어_P일_때만_받고_서버에_실제_기어를_보낸다_기어를_모르면_거부() {
        val c = controller()
        gear = null
        c.requestGuestCode()
        assertEquals(0, api.guestCalls)
        gear = Gear.P
        c.requestGuestCode()
        assertEquals(listOf("P"), api.gears)
    }

    @Test
    fun 기어가_바뀌면_세대가_올라가_늦게_온_QR_응답은_버려진다() {
        var ctl: ExtrasController? = null
        val slow = object : ExtrasApi by api {
            override fun guestCode(vehicleId: String, gear: String): CodeInfo {
                ctl!!.onGearChanged() // 기어가 바뀌었다가(이벤트) 다시 P로 돌아왔다
                return CodeInfo("222222", "http://x/g/222222", 0)
            }
        }
        val c = ExtrasController(slow, directExecutor, { "vid" }, { parked }, { clock }, applySettings = { }, gear = { gear })
        ctl = c
        c.requestGuestCode()
        assertNull("기어가 바뀌는 사이 온 응답은 P로 돌아와도 보이지 않는다", c.guest)
    }

    @Test
    fun 오류는_원인별로_다르다_403은_not_parked_forbidden_local_only를_구분한다() {
        val c = controller()
        for ((status, code, expect) in listOf(
            Triple(403, "not_parked", CodeError.NOT_PARKED),
            Triple(403, "forbidden", CodeError.FORBIDDEN),
            Triple(403, "local_only", CodeError.LOCAL_ONLY),
            Triple(401, "unauthorized", CodeError.AUTH),
            Triple(429, "too_many_requests", CodeError.RATE_LIMITED),
        )) {
            api.guestFails = status
            api.guestCode = code
            c.requestGuestCode()
            assertEquals("$status $code", expect, c.codeError!!.second)
        }
    }

    @Test
    fun 차량_ID가_없으면_전용_오류() {
        val c = ExtrasController(api, directExecutor, { null }, { parked }, { clock }, applySettings = { }, gear = { gear })
        c.requestGuestCode()
        assertEquals(CodeKind.GUEST to CodeError.NO_VEHICLE, c.codeError)
    }
}
