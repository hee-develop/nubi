package com.nubi.car.trip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

class VehicleIdTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val cipher = testCipher()

    private class FakeVehicleApi(var behavior: (String) -> String) : VehicleApi {
        val vins = ArrayList<String>()
        override fun register(vin: String): String {
            vins.add(vin)
            return behavior(vin)
        }
    }

    private fun resolver(api: VehicleApi, file: File = File(tmp.root, "vehicle-id.enc"), attempts: Int = 3) =
        VehicleIdResolver(VehicleIdStore(file) { cipher }, api, directExecutor, delay = {}, attempts = attempts)

    @Test
    fun 서버가_준_ID를_암호화해_저장하고_다음에는_서버를_부르지_않고_재사용한다() {
        val api = FakeVehicleApi { "server-issued-id" }
        val file = File(tmp.root, "vehicle-id.enc")
        val first = resolver(api, file)
        first.onVin("VIN-SECRET-9")
        assertEquals("server-issued-id", first.vehicleId)
        assertEquals(listOf("VIN-SECRET-9"), api.vins)
        val raw = file.readText()
        assertFalse("ID가 평문으로 저장되면 안 된다", raw.contains("server-issued-id"))
        assertFalse("VIN은 어디에도 저장하지 않는다", raw.contains("VIN-SECRET-9"))
        // 재시작: VIN을 읽기 전에도 저장된 ID를 쓰고, VIN이 와도 서버를 다시 부르지 않는다
        val second = resolver(api, file)
        second.preload()
        assertEquals("server-issued-id", second.vehicleId)
        second.onVin("VIN-SECRET-9")
        assertEquals(1, api.vins.size)
    }

    @Test
    fun 일시_실패는_재시도하고_성공하면_저장한다() {
        var calls = 0
        val api = FakeVehicleApi { if (++calls < 3) throw IOException("down") else "id-3" }
        val r = resolver(api)
        r.onVin("VIN")
        assertEquals("id-3", r.vehicleId)
        assertEquals(3, calls)
    }

    @Test
    fun 서버가_5xx를_주면_재시도하고_끝내_실패하면_null이다_UUID_대체는_엔진이_한다() {
        val api = FakeVehicleApi { throw HttpFailure(503, "HTTP 503") }
        val r = resolver(api)
        r.onVin("VIN")
        assertNull(r.vehicleId)
        assertEquals(3, api.vins.size)
    }

    @Test
    fun 영구_4xx는_재시도하지_않는다() {
        val api = FakeVehicleApi { throw HttpFailure(400, "HTTP 400") }
        val r = resolver(api)
        r.onVin("VIN")
        assertNull(r.vehicleId)
        assertEquals(1, api.vins.size)
    }

    @Test
    fun VIN이_없으면_register를_부르지_않는다() {
        val api = FakeVehicleApi { "never" }
        val r = resolver(api)
        r.preload()
        assertNull(r.vehicleId)
        assertTrue(api.vins.isEmpty())
    }

    @Test
    fun PermanentFailure는_재시도하지_않는다() {
        val api = FakeVehicleApi { throw PermanentFailure("TLS 필요") }
        val r = resolver(api, attempts = 3)
        r.onVin("VIN")
        assertEquals(1, api.vins.size)
        assertNull(r.vehicleId)
    }

    @Test
    fun 키를_못_풀어_메모리_모드면_저장_파일을_읽지도_쓰지도_않는다() {
        val file = File(tmp.root, "vehicle-id.enc")
        VehicleIdStore(file) { cipher }.save("kept-id")
        val before = file.readText()
        val held = VehicleIdStore(file, { false }) { cipher }
        assertNull(held.load())
        held.save("new-id")
        assertEquals(before, file.readText())
        assertEquals("kept-id", VehicleIdStore(file) { cipher }.load())
    }
}
