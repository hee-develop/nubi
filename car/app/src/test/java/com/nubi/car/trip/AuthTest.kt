package com.nubi.car.trip

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URL
import kotlin.concurrent.thread

class AuthTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val cipher = testCipher()

    @Before
    fun before() = Auth.reset()

    @After
    fun after() {
        Auth.reset()
        Auth.onUnauthorized = {}
    }

    private class FakeApi(var behavior: (String) -> Registration) : VehicleApi {
        val vins = ArrayList<String>()
        override fun register(vin: String): String = registerWithToken(vin).vehicleId
        override fun registerWithToken(vin: String): Registration {
            vins.add(vin)
            return behavior(vin)
        }
    }

    private fun resolver(api: VehicleApi, dir: File = tmp.root) = VehicleIdResolver(
        store = VehicleIdStore(File(dir, "vehicle-id.enc")) { cipher },
        tokenStore = VehicleIdStore(File(dir, "vehicle-token.enc")) { cipher },
        api = api,
        executor = directExecutor,
        delay = {},
    )

    @Test
    fun 등록_응답의_토큰을_암호화해_저장하고_다음_실행에서_읽는다() {
        val api = FakeApi { Registration("vid", "tok-secret") }
        resolver(api).onVin("VIN-1")
        assertEquals("tok-secret", Auth.token)
        val raw = File(tmp.root, "vehicle-token.enc").readText()
        assertFalse("토큰이 평문으로 저장되면 안 된다", raw.contains("tok-secret"))
        Auth.reset()
        val again = resolver(api)
        again.preload()
        assertEquals("tok-secret", Auth.token)
        assertEquals("vid", again.vehicleId)
    }

    @Test
    fun 서버가_토큰을_안_주면_토큰은_null이고_헤더를_붙이지_않는다() {
        val api = FakeApi { Registration("vid", null) }
        resolver(api).onVin("VIN-1")
        assertNull(Auth.token)
    }

    @Test
    fun 거절되면_재등록을_한_번만_시도하고_성공하면_새_토큰을_쓴다() {
        var n = 0
        val api = FakeApi { Registration("vid", "tok-${++n}") }
        val r = resolver(api)
        r.onVin("VIN-1")
        assertEquals("tok-1", Auth.token)
        r.onUnauthorized()
        assertEquals("tok-2", Auth.token)
        assertFalse(Auth.failed)
        // 새 토큰으로도 거절되면 더 등록하지 않고 실패 상태로 둔다
        r.onUnauthorized()
        assertEquals(2, api.vins.size)
        assertTrue(Auth.failed)
        // 요청이 성공하면 풀린다
        Auth.onAuthorized()
        assertFalse(Auth.failed)
    }

    @Test
    fun 재등록이_실패하면_실패_상태가_되고_큐를_건드리지_않는다() {
        var fail = false
        val api = FakeApi { if (fail) throw IOException("down") else Registration("vid", "t") }
        val r = resolver(api)
        r.onVin("VIN-1")
        fail = true
        r.onUnauthorized()
        assertTrue(Auth.failed)
        assertEquals("t", Auth.token) // 옛 토큰은 그대로
    }

    @Test
    fun VIN을_모르면_재등록하지_못하고_실패_상태가_된다() {
        val r = resolver(FakeApi { Registration("vid", "t") })
        r.onUnauthorized()
        assertTrue(Auth.failed)
    }

    // HTTP 계층: 실제 로컬 소켓 서버로 헤더와 401 훅을 본다 ------------------------------

    private class OneShotServer(val status: Int) : AutoCloseable {
        private val socket = ServerSocket(0)
        val port: Int get() = socket.localPort

        @Volatile
        var request: String = ""
        private val t = thread(isDaemon = true) {
            try {
                socket.accept().use { c ->
                    val reader = c.getInputStream().bufferedReader()
                    val sb = StringBuilder()
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                        sb.appendLine(line)
                    }
                    request = sb.toString()
                    val body = "{\"ok\":true}"
                    c.getOutputStream().write("HTTP/1.1 $status X\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body".toByteArray())
                }
            } catch (e: Exception) {
            }
        }

        override fun close() {
            socket.close()
        }
    }

    @Test
    fun 토큰이_있으면_모든_호출에_Bearer가_붙는다() {
        Auth.token = "abc123"
        OneShotServer(200).use { s ->
            getText("http://127.0.0.1:${s.port}", "/x?vehicleId=1")
            assertTrue(s.request, s.request.contains("Authorization: Bearer abc123"))
        }
        OneShotServer(200).use { s ->
            postJson("http://127.0.0.1:${s.port}", "/y", org.json.JSONObject())
            assertTrue(s.request, s.request.contains("Authorization: Bearer abc123"))
        }
        OneShotServer(200).use { s ->
            putJson("http://127.0.0.1:${s.port}", "/z", org.json.JSONObject())
            assertTrue(s.request, s.request.contains("Authorization: Bearer abc123"))
        }
        OneShotServer(200).use { s ->
            deleteRequest("http://127.0.0.1:${s.port}", "/w")
            assertTrue(s.request, s.request.contains("Authorization: Bearer abc123"))
        }
    }

    @Test
    fun 등록_요청에는_토큰을_붙이지_않고_토큰이_없으면_헤더가_없다() {
        Auth.token = "abc123"
        OneShotServer(200).use { s ->
            postJson("http://127.0.0.1:${s.port}", "/vehicles/register", org.json.JSONObject(), authorize = false)
            assertFalse(s.request, s.request.contains("Authorization"))
        }
        Auth.token = null
        OneShotServer(200).use { s ->
            getText("http://127.0.0.1:${s.port}", "/x")
            assertFalse(s.request, s.request.contains("Authorization"))
        }
    }

    @Test
    fun 인증_거절_401과_403은_재등록_훅을_부르고_HttpFailure를_그대로_던진다() {
        Auth.token = "t"
        for (code in listOf(401, 403)) {
            var called = 0
            Auth.onUnauthorized = { called++ }
            OneShotServer(code).use { s ->
                try {
                    getText("http://127.0.0.1:${s.port}", "/x")
                    throw AssertionError("예외가 나야 한다")
                } catch (e: HttpFailure) {
                    assertEquals(code, e.status)
                }
            }
            assertEquals(1, called)
        }
    }
}
