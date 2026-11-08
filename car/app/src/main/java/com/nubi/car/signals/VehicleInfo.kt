package com.nubi.car.signals

import ai.pleos.playground.vehicle.Vehicle
import android.content.Context
import android.util.Log
import java.security.MessageDigest

/** Vehicle SDK로 VIN(해시)과 오도미터(km)를 읽는다. 실패·미지원은 null. */
class VehicleInfo(private val context: Context) {
    private var vehicle: Vehicle? = null

    /** VIN의 SHA-256(소문자 hex). 아직 못 읽었거나 실패면 null. */
    @Volatile
    var vinHash: String? = null
        private set

    @Synchronized
    fun start() {
        if (vehicle != null) return
        try {
            val v = Vehicle(context)
            v.initialize()
            vehicle = v
            v.getCarInfo().getVINInfo(
                { vin: String? ->
                    Log.i(TAG, "VIN 읽음(길이=${vin?.length})")
                    if (!vin.isNullOrBlank()) vinHash = sha256Hex(vin)
                },
                { e -> Log.w(TAG, "VIN 실패: ${e.message}") },
            )
        } catch (e: Throwable) {
            Log.w(TAG, "Vehicle SDK 초기화 실패", e)
        }
    }

    /** 현재 누적 주행거리(km). 콜백은 SDK 스레드에서 올 수 있다. 실패하면 null. */
    fun readOdometerKm(callback: (Double?) -> Unit) {
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
    fun stop() {
        try {
            vehicle?.release()
        } catch (e: Throwable) {
            Log.w(TAG, "Vehicle release 실패", e)
        }
        vehicle = null
    }

    companion object {
        private const val TAG = "NubiVehicle"

        fun sha256Hex(text: String): String =
            MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
