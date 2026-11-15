package com.nubi.car.signals

import ai.pleos.playground.vehicle.Vehicle
import android.content.Context
import android.util.Log
import com.nubi.car.trip.VehicleIdResolver
import com.nubi.car.trip.VehicleSource

/** Vehicle SDK로 VIN을 읽어 서버 발급 차량 ID로 바꾸고, 오도미터(km)를 읽는다. 실패·미지원은 null. */
class VehicleInfo(private val context: Context, private val resolver: VehicleIdResolver) : VehicleSource {
    private var vehicle: Vehicle? = null

    /** 서버가 발급한 차량 ID(`HMAC-SHA256(서버 비밀키, VIN)`). 아직 못 받았거나 VIN을 못 읽었으면 null. VIN 원문은 저장·로그에 남기지 않는다. */
    override val vehicleId: String? get() = resolver.vehicleId

    @Synchronized
    override fun start() {
        if (vehicle != null) return
        resolver.preload()
        try {
            val v = Vehicle(context)
            v.initialize()
            vehicle = v
            v.getCarInfo().getVINInfo(
                { vin: String? ->
                    Log.i(TAG, "VIN 읽음(길이=${vin?.length})")
                    if (!vin.isNullOrBlank()) resolver.onVin(vin)
                },
                { e -> Log.w(TAG, "VIN 실패: ${e.message}") },
            )
        } catch (e: Throwable) {
            Log.w(TAG, "Vehicle SDK 초기화 실패", e)
        }
    }

    /** 현재 누적 주행거리(km). 콜백은 SDK 스레드에서 올 수 있다. 실패하면 null. */
    override fun readOdometerKm(callback: (Double?) -> Unit) {
        val v = vehicle
        if (v == null) {
            callback(null)
            return
        }
        try {
            v.getOdometer().getCurrentDistanceDriven(
                { km: Float? ->
                    Log.i(TAG, "Odometer 읽음: $km")
                    callback(km?.toDouble())
                },
                { e ->
                    Log.w(TAG, "Odometer 실패: ${e.message}")
                    callback(null)
                },
            )
        } catch (e: Throwable) {
            Log.w(TAG, "Odometer 호출 예외", e)
            callback(null)
        }
    }

    @Synchronized
    override fun stop() {
        try {
            vehicle?.release()
        } catch (e: Throwable) {
            Log.w(TAG, "Vehicle release 실패", e)
        }
        vehicle = null
    }

    private companion object {
        const val TAG = "NubiVehicle"
    }
}
