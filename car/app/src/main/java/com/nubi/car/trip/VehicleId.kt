package com.nubi.car.trip

import android.util.Log
import java.io.File
import java.util.concurrent.Executor

/** 서버가 발급한 차량 ID를 암호화해 한 파일에 둔다(DEK 암호화, [LineCipher]). VIN 자체는 어디에도 저장하지 않는다. */
class VehicleIdStore(
    private val file: File,
    /** false면(키를 못 풀어 메모리 임시 키로 동작 중) 파일을 읽지도 쓰지도 않는다. 기존 파일을 덮어쓰지 않으려는 것이다. */
    private val persistent: () -> Boolean = { true },
    private val cipher: () -> LineCipher,
) {
    fun load(): String? = try {
        if (!persistent() || !file.exists()) null else cipher().decrypt(file.readText().trim())?.takeIf { it.isNotBlank() }
    } catch (e: Exception) {
        null
    }

    fun save(vehicleId: String) {
        if (!persistent()) return
        FileIo.writeAtomically(file, cipher().encrypt(vehicleId).toByteArray())
    }
}

/**
 * VIN → 서버 발급 차량 ID. 저장된 ID가 있으면 서버를 부르지 않고 재사용하고, 없으면 `POST /vehicles/register`로 받아 암호화 저장한다.
 * 네트워크·Keystore를 만지므로 [executor](워커)에서만 돈다. VIN은 로그·저장에 남기지 않는다(예외도 클래스 이름만 남긴다).
 * 일시적 실패(네트워크·408·425·429·5xx)는 [attempts]번까지 [delay]를 두고 다시 시도하고, 그래도 안 되면 null로 둔다
 * (엔진이 시작 후 10초 뒤 UUID로 대체한다). 서버가 400 등 영구 4xx를 주거나 [PermanentFailure](release에서 http라 등록을 막은 경우)면 재시도하지 않는다.
 */
class VehicleIdResolver(
    private val store: VehicleIdStore,
    private val api: VehicleApi,
    private val executor: Executor,
    private val delay: (Long) -> Unit = { Thread.sleep(it) },
    private val attempts: Int = 3,
    /** 차량 토큰 저장소(같은 DEK 암호화). 없으면 토큰을 디스크에 두지 않는다. */
    private val tokenStore: VehicleIdStore? = null,
) {
    @Volatile
    var vehicleId: String? = null
        private set

    /** 재등록용 VIN. 메모리에만 두고 저장·로그하지 않는다. */
    @Volatile
    private var lastVin: String? = null

    /** 저장된 토큰을 읽어 [Auth]에 올렸는지, 서버에서 토큰을 받아 보려고 한 번 시도했는지(인증이 꺼진 서버는 토큰을 안 주므로 반복하지 않는다). */
    @Volatile
    private var tokenAttempted = false

    init {
        Auth.onUnauthorized = { onUnauthorized() }
    }

    /** VIN을 읽기 전에도 이미 받아 둔 ID가 있으면 쓴다. */
    fun preload() = run { resolve(null) }

    /** VIN 콜백에서 부른다(콜백 스레드를 막지 않는다). 이미 ID가 있으면 아무것도 하지 않는다(토큰이 없을 때 한 번만 토큰을 받아 본다). */
    fun onVin(vin: String) {
        lastVin = vin
        if (vehicleId != null && tokenStore != null && Auth.token == null && !tokenAttempted) {
            tokenAttempted = true
            runAlways { refreshToken() }
            return
        }
        run { resolve(vin) }
    }

    /**
     * 서버가 401·403을 줬다: 재등록(`POST /vehicles/register`)으로 새 토큰을 **1회** 받아 본다. 성공하면 다음 요청부터 새 토큰이 붙고,
     * 실패하거나 이미 한 번 해 본 뒤라면 [Auth.failed]를 켠다(화면이 상태 문구를 보인다). 업로드 큐는 건드리지 않는다.
     */
    fun onUnauthorized() {
        if (Auth.reregistered) {
            Auth.failed = true
            return
        }
        Auth.reregistered = true
        runAlways {
            if (!refreshToken()) Auth.failed = true
        }
    }

    /** 저장된 VIN(메모리)으로 등록해 토큰을 받는다. 성공하면 true. */
    @Synchronized
    private fun refreshToken(): Boolean {
        val vin = lastVin ?: return false
        return try {
            val r = api.registerWithToken(vin)
            val t = r.token
            if (t != null) {
                Auth.token = t
                try {
                    tokenStore?.save(t)
                } catch (e: Exception) {
                    Log.w(TAG, "토큰 저장 실패(이번 실행에서만 사용): ${e.javaClass.simpleName}")
                }
            }
            if (vehicleId == null) {
                vehicleId = r.vehicleId
                try {
                    store.save(r.vehicleId)
                } catch (e: Exception) {
                    Log.w(TAG, "차량 ID 저장 실패: ${e.javaClass.simpleName}")
                }
            }
            t != null
        } catch (e: Exception) {
            Log.w(TAG, "재등록 실패 ${e.javaClass.simpleName}")
            false
        }
    }

    private fun runAlways(block: () -> Unit) {
        try {
            executor.execute {
                try {
                    block()
                } catch (t: Throwable) {
                    Log.w(TAG, "토큰 작업 예외: ${t.javaClass.simpleName}")
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "토큰 작업 등록 실패: ${t.javaClass.simpleName}")
        }
    }

    private fun run(block: () -> Unit) {
        if (vehicleId != null) return
        try {
            executor.execute {
                try {
                    block()
                } catch (t: Throwable) {
                    Log.w(TAG, "차량 ID 확인 예외: ${t.javaClass.simpleName}")
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "차량 ID 확인 작업 등록 실패: ${t.javaClass.simpleName}")
        }
    }

    @Synchronized
    private fun resolve(vin: String?) {
        if (Auth.token == null) tokenStore?.load()?.let { Auth.token = it }
        if (vehicleId != null) return
        store.load()?.let {
            vehicleId = it
            return
        }
        if (vin == null) return
        for (i in 1..attempts) {
            var retry = true
            try {
                val reg = api.registerWithToken(vin)
                val id = reg.vehicleId
                reg.token?.let { t ->
                    Auth.token = t
                    try {
                        tokenStore?.save(t)
                    } catch (e: Exception) {
                        Log.w(TAG, "토큰 저장 실패(이번 실행에서만 사용): ${e.javaClass.simpleName}")
                    }
                }
                tokenStore?.let { tokenAttempted = true }
                try {
                    store.save(id)
                } catch (e: Exception) {
                    Log.w(TAG, "차량 ID 저장 실패(이번 실행에서만 사용): ${e.javaClass.simpleName}")
                }
                vehicleId = id
                return
            } catch (e: PermanentFailure) {
                Log.w(TAG, "차량 등록 불가(재시도 안 함): ${e.message}")
                retry = false
            } catch (e: HttpFailure) {
                Log.w(TAG, "차량 등록 실패 HTTP ${e.status}")
                retry = e.status == 408 || e.status == 425 || e.status == 429 || e.status >= 500
            } catch (e: Exception) {
                Log.w(TAG, "차량 등록 실패 ${e.javaClass.simpleName}")
            }
            if (!retry) return
            if (i < attempts) delay(3_000L * i)
        }
    }

    private companion object {
        const val TAG = "NubiVehicleId"
    }
}
