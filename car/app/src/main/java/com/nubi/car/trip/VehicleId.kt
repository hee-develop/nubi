package com.nubi.car.trip

import android.util.Log
import java.io.File
import java.util.concurrent.Executor

/** 서버가 발급한 차량 ID를 암호화해 한 파일에 둔다(DEK 암호화, [LineCipher]). VIN 자체는 어디에도 저장하지 않는다. */
class VehicleIdStore(private val file: File, private val cipher: () -> LineCipher) {
    fun load(): String? = try {
        if (!file.exists()) null else cipher().decrypt(file.readText().trim())?.takeIf { it.isNotBlank() }
    } catch (e: Exception) {
        null
    }

    fun save(vehicleId: String) {
        FileIo.writeAtomically(file, cipher().encrypt(vehicleId).toByteArray())
    }
}

/**
 * VIN → 서버 발급 차량 ID. 저장된 ID가 있으면 서버를 부르지 않고 재사용하고, 없으면 `POST /vehicles/register`로 받아 암호화 저장한다.
 * 네트워크·Keystore를 만지므로 [executor](워커)에서만 돈다. VIN은 로그·저장에 남기지 않는다(예외도 클래스 이름만 남긴다).
 * 일시적 실패(네트워크·408·425·429·5xx)는 [attempts]번까지 [delay]를 두고 다시 시도하고, 그래도 안 되면 null로 둔다
 * (엔진이 시작 후 10초 뒤 UUID로 대체한다). 서버가 400 등 영구 4xx를 주면 재시도하지 않는다.
 */
class VehicleIdResolver(
    private val store: VehicleIdStore,
    private val api: VehicleApi,
    private val executor: Executor,
    private val delay: (Long) -> Unit = { Thread.sleep(it) },
    private val attempts: Int = 3,
) {
    @Volatile
    var vehicleId: String? = null
        private set

    /** VIN을 읽기 전에도 이미 받아 둔 ID가 있으면 쓴다. */
    fun preload() = run { resolve(null) }

    /** VIN 콜백에서 부른다(콜백 스레드를 막지 않는다). 이미 ID가 있으면 아무것도 하지 않는다. */
    fun onVin(vin: String) = run { resolve(vin) }

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
        if (vehicleId != null) return
        store.load()?.let {
            vehicleId = it
            return
        }
        if (vin == null) return
        for (i in 1..attempts) {
            var retry = true
            try {
                val id = api.register(vin)
                try {
                    store.save(id)
                } catch (e: Exception) {
                    Log.w(TAG, "차량 ID 저장 실패(이번 실행에서만 사용): ${e.javaClass.simpleName}")
                }
                vehicleId = id
                return
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
