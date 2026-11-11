package com.nubi.car.trip

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.nubi.car.BuildConfig
import com.nubi.car.map.HttpMapApi
import com.nubi.car.map.LivePoller
import com.nubi.car.map.MapRepository
import com.nubi.car.map.MapScreen
import com.nubi.car.FeatureFlags
import com.nubi.car.screens.ExtrasController
import com.nubi.car.screens.HttpExtrasApi
import com.nubi.car.screens.UxState
import com.nubi.car.screens.qrAllowed
import com.nubi.car.signals.VehicleInfo
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/** 프로세스에 하나뿐인 [TripEngine]에 실제 Android 의존성을 꽂는다. */
object TripEngineProvider {
    @Volatile
    private var instance: TripEngine? = null

    @Volatile
    private var tracker: CoverageTracker? = null

    @Volatile
    private var placeTracker: PlaceTracker? = null

    @Volatile
    private var resolver: VehicleIdResolver? = null

    @Volatile
    private var mapScreen: MapScreen? = null

    @Volatile
    private var extrasController: ExtrasController? = null

    fun get(context: Context): TripEngine =
        instance ?: synchronized(this) { instance ?: create(context.applicationContext).also { instance = it } }

    /** 차량 ID 해석기. VIN 주입 같은 debug 전용 호출은 debug 소스셋(DebugSignals)에서만 이 객체를 쓴다. */
    fun vehicleIdResolver(context: Context): VehicleIdResolver {
        get(context)
        return resolver!!
    }

    /** 도로 색칠 결과(종료 한 줄)·전국 완료율 상태. 엔진과 같은 수명이다. */
    fun coverage(context: Context): CoverageTracker {
        get(context)
        return tracker!!
    }

    /** 정차 화면의 현재 시군구·이웃 상태. 엔진과 같은 수명이다. */
    fun place(context: Context): PlaceTracker {
        get(context)
        return placeTracker!!
    }

    /** 지도 화면 상태(저장소·잠정 색칠 폴링·로컬 궤적). 엔진과 같은 수명이다. */
    fun map(context: Context): MapScreen {
        get(context)
        return mapScreen!!
    }

    /** 정차 메뉴·QR 상태와 서버 설정(기록 멈춤·지도·내 지역). 엔진과 같은 수명이다. */
    fun extras(context: Context): ExtrasController {
        get(context)
        return extrasController!!
    }

    private fun create(context: Context): TripEngine {
        val main = Handler(Looper.getMainLooper())
        val scheduler = object : Scheduler {
            override fun post(block: () -> Unit) {
                main.post(block)
            }

            override fun postDelayed(delayMs: Long, block: () -> Unit): Cancellable {
                val r = Runnable(block)
                main.postDelayed(r, delayMs)
                return Cancellable { main.removeCallbacks(r) }
            }
        }
        val clock = object : Clock {
            override fun elapsedMs() = SystemClock.elapsedRealtime()
            override fun wallMs() = System.currentTimeMillis()
        }
        val prefs = context.getSharedPreferences("nubi", Context.MODE_PRIVATE)
        val store = object : KeyValueStore {
            override fun getString(key: String) = prefs.getString(key, null)
            override fun putString(key: String, value: String) {
                prefs.edit().putString(key, value).apply()
            }
        }
        val dir = File(context.filesDir, "trips").apply { mkdirs() }
        // Keystore unwrap·파일 읽기는 워커에서 한다. 메인 스레드는 아무것도 기다리지 않는다.
        val setup = lazy { KeystoreCipher.create(dir) }
        val uploader = Uploader(
            queueFile = File(dir, "queue.jsonl"),
            idsFile = File(dir, "server-ids.jsonl"),
            deadLetterFile = File(dir, "dead-letter.jsonl"),
            api = HttpTripApi(BuildConfig.SERVER_URL),
            cipherSetup = { setup.value },
        )
        val resolver = VehicleIdResolver(
            store = VehicleIdStore(File(dir, "vehicle-id.enc"), { setup.value.persistent }) { setup.value.cipher },
            tokenStore = VehicleIdStore(File(dir, "vehicle-token.enc"), { setup.value.persistent }) { setup.value.cipher },
            api = HttpVehicleApi(BuildConfig.SERVER_URL),
            executor = Executors.newSingleThreadExecutor(),
        )
        this.resolver = resolver
        val vehicle = VehicleInfo(context, resolver)
        val coverage = CoverageTracker(HttpCoverageApi(BuildConfig.SERVER_URL), Executors.newCachedThreadPool(), { vehicle.vehicleId }, cache = store)
        uploader.onTripEnded = coverage::onTripEnded
        tracker = coverage
        val engine = TripEngine(clock, scheduler, Executors.newSingleThreadExecutor(), vehicle, store, uploader).also { it.onTripStarted = coverage::onTripStarted }
        // 정차(P) 진입 때와 트립 종료(매칭 폴링이 끝난 뒤) 때 마지막 채택 위치로 현재 시군구·이웃을 한 번 조회한다
        val place = PlaceTracker(HttpPlaceApi(BuildConfig.SERVER_URL), Executors.newSingleThreadExecutor(), { vehicle.vehicleId }, { engine.status.lastLocation })
        placeTracker = place
        engine.onParked = place::refresh
        // 지도: 서버 칸·잠정 색칠은 워커 2개에서, 지연 예약은 데몬 스케줄러 하나에서 돈다. 주행 중 지도를 켠 경우 업로드를 20초 간격으로 당긴다(계약서 05 3장).
        val mapApi = HttpMapApi(BuildConfig.SERVER_URL)
        val mapTimer: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "nubi-map-timer").apply { isDaemon = true } }
        val mapSchedule: (Long, () -> Unit) -> Cancellable = { delay, block ->
            val f = mapTimer.schedule(block, delay, TimeUnit.MILLISECONDS)
            Cancellable { f.cancel(false) }
        }
        val mapWorkers = Executors.newFixedThreadPool(2) { r -> Thread(r, "nubi-map-worker").apply { isDaemon = true } }
        val repo = MapRepository(mapApi, mapWorkers, { vehicle.vehicleId }, mapSchedule)
        val livePoller = LivePoller(mapApi, mapWorkers, { uploader.liveTripId }, mapSchedule, repo, localTripId = { engine.recordingLocalId })
        val screen = MapScreen(repo, livePoller)
        mapScreen = screen
        uploader.onPointsUploaded = { livePoller.kick() }
        engine.onLocationSample = { lat, lon, ts, recording -> screen.onLocationSample(lat, lon, ts, recording) }
        val coverageStarted = engine.onTripStarted
        engine.onTripStarted = {
            coverageStarted()
            screen.onTripStarted()
        }
        // 기록 멈춤은 마지막 값을 저장해 두었다가 서버 설정이 오기 전에도 지킨다. 음성 켜기·끄기는 기기에만 둔다(서버 설정에 없는 항목).
        engine.recordingPaused = store.getString(TripEngine.KEY_PAUSED) == "1"
        FeatureFlags.applyVoicePref(store.getString(KEY_VOICE_PREF) != "0")
        val extras = ExtrasController(
            api = HttpExtrasApi(BuildConfig.SERVER_URL),
            executor = Executors.newSingleThreadExecutor { r -> Thread(r, "nubi-extras").apply { isDaemon = true } },
            vehicleId = { vehicle.vehicleId },
            allowed = { qrAllowed(true, engine.status.gear, engine.status.state, UxState.distractionOptimized) },
            elapsedMs = { SystemClock.elapsedRealtime() },
            applySettings = { s ->
                engine.recordingPaused = s.recordingBlocked
                store.putString(TripEngine.KEY_PAUSED, if (s.recordingBlocked) "1" else "0")
                FeatureFlags.applyServerDrivingMap(s.drivingMap)
            },
            onDataDeleted = {
                coverage.clear()
                place.clear()
                screen.onTripSettled()
                coverage.refreshNational()
                coverage.refreshRegions()
            },
        )
        extrasController = extras
        // 정차(P) 진입 때 서버 설정을 다시 읽는다(폰에서 바꾼 기록 멈춤 등)
        val parkedBefore = engine.onParked
        engine.onParked = {
            parkedBefore()
            extras.refreshSettings()
        }
        coverage.onTripSettled = { settledLocalId ->
            place.refresh()
            screen.onTripSettled(settledLocalId, engine.recordingLocalId)
        }
        return engine
    }

    /** 음성 켜기·끄기를 기기에 저장하고 플래그에 반영한다(서버 설정에 없는 항목이라 로컬에만 둔다). */
    fun setVoicePref(context: Context, on: Boolean) {
        context.applicationContext.getSharedPreferences("nubi", Context.MODE_PRIVATE).edit().putString(KEY_VOICE_PREF, if (on) "1" else "0").apply()
        FeatureFlags.applyVoicePref(on)
    }

    private const val KEY_VOICE_PREF = "voicePref"
}
