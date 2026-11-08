package com.nubi.car

import ai.pleos.playground.location.fused.FusedLocation
import ai.pleos.playground.location.fused.listener.FusedLocationListener
import ai.pleos.playground.location.fused.model.LocationData
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log
import com.nubi.car.signals.CarSignals
import com.nubi.car.trip.TripEngine

/**
 * 위치 기록 포그라운드 서비스. 화면이 사라져도 FusedLocation·차량 신호 콜백을 유지하고 [TripEngine]에 넘긴다.
 * 샘플 채택·상태기계·큐·업로드는 엔진이 한다.
 */
class TripRecordingService : Service() {
    private lateinit var engine: TripEngine
    private var fused: FusedLocation? = null
    private var signals: CarSignals? = null

    private val listener = object : FusedLocationListener {
        override fun onChanged(location: LocationData?) {
            if (location == null) {
                Log.w(LOC_TAG, "onChanged null")
                return
            }
            Log.i(LOC_TAG, "onChanged lat=${location.latitude} lon=${location.longitude} heading=${location.heading} conf=${location.confidence} ts=${location.timestampMillis}")
            if (!engine.acceptRealLocation) return
            engine.onLocation(location.latitude, location.longitude, location.heading, location.confidence, location.timestampMillis)
        }

        override fun onError(e: Exception) {
            Log.w(LOC_TAG, "onError ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    override fun onCreate() {
        super.onCreate()
        engine = TripEngine.get(this)
        startInForeground()
        startSources()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 최근 앱에서 지워도 서비스는 유지한다.
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        stopSources()
        engine.onStop()
        super.onDestroy()
    }

    private fun startInForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW))
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(getString(R.string.notification_title))
            .setOngoing(true)
            .build()
        try {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } catch (e: Exception) {
            Log.w(TAG, "startForeground(location) 실패: ${e.javaClass.simpleName} ${e.message}")
            throw e
        }
    }

    private fun startSources() {
        signals = CarSignals(this, engine::onGear, engine::onSpeedKph).also { it.start() }
        try {
            val f = FusedLocation(this)
            f.initialize()
            fused = f
            Log.i(LOC_TAG, "isSupported=${f.isSupported()}")
            f.registerFusedLocationCallback(listener)
        } catch (e: Throwable) {
            Log.w(LOC_TAG, "FusedLocation 시작 실패: ${e.javaClass.simpleName} ${e.message}")
        }
    }

    private fun stopSources() {
        try {
            fused?.unregisterFusedLocationCallback(listener)
            fused?.release()
        } catch (e: Throwable) {
            Log.w(LOC_TAG, "FusedLocation 해제 실패", e)
        }
        fused = null
        signals?.stop()
        signals = null
    }

    companion object {
        const val LOC_TAG = "NubiLoc"
        private const val TAG = "NubiService"
        private const val CHANNEL_ID = "trip-recording"
        private const val NOTIFICATION_ID = 1

        fun start(context: Context) {
            context.startForegroundService(Intent(context, TripRecordingService::class.java))
        }
    }
}
