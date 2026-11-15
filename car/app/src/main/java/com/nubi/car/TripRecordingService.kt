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
import com.nubi.car.trip.TripEngineProvider
import com.nubi.car.trip.coordForLog

/**
 * 위치 기록 포그라운드 서비스. 화면이 사라져도 FusedLocation·차량 신호 콜백을 유지하고 [TripEngine]에 넘긴다.
 * 샘플 채택·상태기계·큐·업로드는 엔진이 한다.
 */
class TripRecordingService : Service() {
    private lateinit var engine: TripEngine
    private var fused: FusedLocation? = null
    private var signals: CarSignals? = null
    private var started = false

    private val listener = object : FusedLocationListener {
        override fun onChanged(location: LocationData?) {
            if (location == null) {
                Log.w(LOC_TAG, "onChanged null")
                return
            }
            Log.i(LOC_TAG, "onChanged ${coordForLog(location.latitude, location.longitude)} conf=${location.confidence}")
            if (!engine.acceptRealLocation) return
            // 에뮬레이터는 heading을 항상 0.0으로 준다(실측 docs/sdk-check.md). 실제 북쪽과 구분할 수 없으므로 0.0은 값 없음(null)으로 보낸다.
            val heading = location.heading.takeIf { it != 0f }
            engine.onLocation(location.latitude, location.longitude, heading, location.confidence, location.timestampMillis)
        }

        override fun onError(e: Exception) {
            Log.w(LOC_TAG, "onError ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    override fun onCreate() {
        super.onCreate()
        engine = TripEngineProvider.get(this)
        if (!startInForeground()) {
            // 조용히 접지 않는다. 실패를 저장해 다음에 화면이 앞에 올 때 안내하고 재시작을 시도한다.
            engine.onServiceFailed()
            stopSelf()
            return
        }
        started = true
        TripEngineProvider.voiceOpen(this)
        engine.onServiceStart()
        // 대기 화면의 전국 완료율은 서비스 시작 때 1회만 받는다(실패하면 생략).
        TripEngineProvider.coverage(this).apply {
            refreshNational()
            refreshRegions()
        }
        startSources()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 앱이 최근 목록에서 지워졌다. 기록 중이던 트립을 마지막 채택 샘플 시각으로 끝내고 서비스도 접는다.
        TripEngineProvider.voiceRelease() // 재생 중단 → 포커스 반납 → 해제, 이후 새 재생 금지
        if (started) {
            started = false
            stopSources()
            engine.onServiceStop()
        }
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        // Suspend(IGN OFF)는 Pleos SDK에 별도 콜백이 없다. 프로세스가 죽기 전 onDestroy가 오면 여기서 트립을 끝내고 차량 SDK를 해제한다.
        // 오지 않고 프로세스가 죽는 경우는 다음 서비스 시작 때 미종료 트립 복구(Uploader.recoverUnfinished)가 End를 넣는다.
        TripEngineProvider.voiceRelease()
        if (started) {
            started = false
            stopSources()
            engine.onServiceStop()
        }
        super.onDestroy()
    }

    private fun startInForeground(): Boolean {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW))
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(getString(R.string.notification_title))
            .setOngoing(true)
            .build()
        return try {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            true
        } catch (e: Exception) {
            // 권한이 빠졌거나 백그라운드 시작이 막혔을 때 앱이 죽지 않도록 서비스만 접는다(호출자가 실패 상태를 저장한다).
            Log.w(TAG, "startForeground(location) 실패: ${e.javaClass.simpleName} ${e.message}")
            false
        }
    }

    private fun startSources() {
        signals = CarSignals(this, engine::onGear).also { it.start() }
        try {
            val f = FusedLocation(this)
            f.initialize()
            val supported = f.isSupported()
            Log.i(LOC_TAG, "isSupported=$supported")
            if (!supported) {
                // 위치 기능이 없는 차량. 콜백을 등록하지 않고 화면에 알린다.
                engine.onLocationUnsupported()
                try {
                    f.release()
                } catch (e: Throwable) {
                    Log.w(LOC_TAG, "FusedLocation 해제 실패", e)
                }
                return
            }
            fused = f
            f.registerFusedLocationCallback(listener)
        } catch (e: Throwable) {
            Log.w(LOC_TAG, "FusedLocation 시작 실패: ${e.javaClass.simpleName} ${e.message}")
            engine.onLocationUnsupported()
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
