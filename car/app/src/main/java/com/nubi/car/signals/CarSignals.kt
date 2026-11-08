package com.nubi.car.signals

import android.car.Car
import android.car.VehicleGear
import android.car.VehiclePropertyIds
import android.car.hardware.CarPropertyConfig
import android.car.hardware.CarPropertyValue
import android.car.hardware.property.CarPropertyManager
import android.content.Context
import android.util.Log
import com.nubi.car.trip.Gear

/**
 * AAOS CarPropertyManager로 기어(GEAR_SELECTION)만 읽는다. 속도는 수집하지 않는다(CAR_SPEED 권한도 요청하지 않는다).
 * 권한 거부·미지원이면 조용히 건너뛴다(앱은 죽지 않는다).
 */
class CarSignals(
    private val context: Context,
    private val onGear: (Gear?) -> Unit,
) {
    private var car: Car? = null
    private var pm: CarPropertyManager? = null

    private val callback = object : CarPropertyManager.CarPropertyEventCallback {
        override fun onChangeEvent(value: CarPropertyValue<*>) = handle(value.propertyId, value.value)
        override fun onErrorEvent(propertyId: Int, areaId: Int) {
            Log.w(TAG, "속성 오류 id=$propertyId area=$areaId")
        }
    }

    @Synchronized
    fun start() {
        if (car != null) return
        try {
            val c = Car.createCar(context) ?: return
            car = c
            val manager = c.getCarManager(Car.PROPERTY_SERVICE) as CarPropertyManager
            pm = manager
            listOf(VehiclePropertyIds.GEAR_SELECTION).forEach { id ->
                try {
                    val config = manager.getCarPropertyConfig(id)
                    if (config == null) {
                        Log.w(TAG, "미지원 속성 id=$id")
                        return@forEach
                    }
                    try {
                        handle(id, manager.getProperty<Any>(id, 0)?.value)
                    } catch (e: Exception) {
                        Log.w(TAG, "읽기 실패 id=$id: ${e.message}")
                    }
                    val rate = if (config.changeMode == CarPropertyConfig.VEHICLE_PROPERTY_CHANGE_MODE_CONTINUOUS) {
                        CarPropertyManager.SENSOR_RATE_NORMAL
                    } else {
                        CarPropertyManager.SENSOR_RATE_ONCHANGE
                    }
                    manager.registerCallback(callback, id, rate)
                } catch (e: Exception) {
                    // SecurityException(권한 거부) 포함. 이 신호만 포기한다.
                    Log.w(TAG, "구독 실패 id=$id: ${e.javaClass.simpleName} ${e.message}")
                }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "Car 연결 실패", e)
        }
    }

    @Synchronized
    fun stop() {
        try {
            pm?.unregisterCallback(callback)
            car?.disconnect()
        } catch (e: Throwable) {
            Log.w(TAG, "Car 해제 실패", e)
        }
        car = null
        pm = null
    }

    private fun handle(propertyId: Int, value: Any?) {
        when (propertyId) {
            VehiclePropertyIds.GEAR_SELECTION -> (value as? Int)?.let {
                Log.i(TAG, "기어 $it")
                onGear(gearOf(it))
            }
        }
    }

    private fun gearOf(value: Int): Gear? = when (value) {
        VehicleGear.GEAR_PARK -> Gear.P
        VehicleGear.GEAR_REVERSE -> Gear.R
        VehicleGear.GEAR_NEUTRAL -> Gear.N
        VehicleGear.GEAR_DRIVE -> Gear.D
        else -> null
    }

    private companion object {
        const val TAG = "NubiCarSignals"
    }
}
