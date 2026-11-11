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
import com.nubi.car.screens.IntroTracker
import com.nubi.car.screens.TripSummaryState
import com.nubi.car.screens.copyTrail
import com.nubi.car.screens.tripBbox
import com.nubi.car.screens.UxState
import com.nubi.car.voice.VoiceAdapter
import com.nubi.car.voice.VoiceDirector
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

    @Volatile
    private var introTracker: IntroTracker? = null

    @Volatile
    private var summaryState: TripSummaryState? = null

    @Volatile
    private var voiceAdapterRef: VoiceAdapter? = null

    @Volatile
    private var thumbRepo: MapRepository? = null

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

    /** 지금 시군구의 지역 소개(관광지·축제). 엔진과 같은 수명이다. */
    fun intro(context: Context): IntroTracker {
        get(context)
        return introTracker!!
    }

    /** 하차 요약 카드 상태와 썸네일 지도용 저장소(주 지도와 따로 둬서 보기를 서로 바꾸지 않는다). */
    fun summary(context: Context): TripSummaryState {
        get(context)
        return summaryState!!
    }

    fun thumbRepository(context: Context): MapRepository {
        get(context)
        return thumbRepo!!
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
            epochs = object : PurgeEpochs {
                override fun purgeEpoch() = store.getString(KEY_PURGE_EPOCH)?.toLongOrNull() ?: 0L
                override fun filesEpoch() = store.getString(KEY_FILES_EPOCH)?.toLongOrNull() ?: 0L
                override fun bump(): Long = (purgeEpoch() + 1).also { store.putString(KEY_PURGE_EPOCH, it.toString()) }
                override fun markFiles(epoch: Long) = store.putString(KEY_FILES_EPOCH, epoch.toString())
            },
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
        val place = PlaceTracker(HttpPlaceApi(BuildConfig.SERVER_URL), Executors.newSingleThreadExecutor(), { vehicle.vehicleId }, { engine.status.lastLocation }, paused = { engine.recordingPaused })
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
        // 음성 안내(I01 처음 들어선 시군구·I03 하차 브리핑). TTS가 실패·미지원이면 아무 일도 하지 않는다
        val voiceAdapter = VoiceAdapter(context)
        voiceAdapterRef = voiceAdapter
        val voice = VoiceDirector(voiceAdapter, { engine.status.gear }, { FeatureFlags.voice }, { SystemClock.elapsedRealtime() })
        livePoller.onRegion = { r -> if (r.firstTime) voice.onFirstRegion(r.code, r.displayName) }
        // 하차 요약 카드: 트립이 끝날 때 궤적 범위를 떠 두고(정산되면 원본 궤적이 지워진다), 정산이 끝나면 카드를 준비한다
        val tripSummary = TripSummaryState()
        summaryState = tripSummary
        thumbRepo = MapRepository(mapApi, mapWorkers, { vehicle.vehicleId }, mapSchedule)
        engine.onTripEnded = {
            val snap = screen.trail.snapshot()
            tripSummary.onEnded(tripBbox(snap), if (snap.lons.isEmpty()) null else copyTrail(snap))
        }
        val coverageStarted = engine.onTripStarted
        engine.onTripStarted = {
            coverageStarted()
            screen.onTripStarted()
            voice.onTripStarted()
            tripSummary.onTripStarted()
        }
        // 기록 멈춤은 마지막 값을 저장해 두었다가 서버 설정이 오기 전에도 지킨다. 음성 켜기·끄기는 기기에만 둔다(서버 설정에 없는 항목).
        engine.recordingPaused = store.getString(TripEngine.KEY_PAUSED) == "1"
        FeatureFlags.applyVoicePref(store.getString(KEY_VOICE_PREF) != "0")
        val extras = ExtrasController(
            api = HttpExtrasApi(BuildConfig.SERVER_URL),
            executor = Executors.newSingleThreadExecutor { r -> Thread(r, "nubi-extras").apply { isDaemon = true } },
            vehicleId = { vehicle.vehicleId },
            allowed = { !UxState.blocked && qrAllowed(true, engine.status.gear, engine.status.state, false) },
            elapsedMs = { SystemClock.elapsedRealtime() },
            applySettings = { s ->
                // 서버가 멈춤을 알리면 진행 중 트립은 End로 끝내고 멈춘다("이후 기록만 멈춘다")
                if (s.recordingBlocked) {
                    if (!engine.recordingPaused) engine.pauseRecording()
                } else {
                    engine.recordingPaused = false
                }
                store.putString(TripEngine.KEY_PAUSED, if (s.recordingBlocked) "1" else "0")
                FeatureFlags.applyServerDrivingMap(s.drivingMap)
            },
            onDataDeleted = {
                // 1) 로컬 기록 멈춤을 먼저 켜고 저장, 2) 업로드 큐(dead-letter·서버 등록 포함)·진행 중 트립 버리기,
                // 3) 요약 카드·궤적·잠정 결과·coverage·place·intro·지도 캐시 비우기
                engine.purgeAfterDataDeletion()
                purgeLocalViews(screen, coverage, place)
            },
            applyLocalPause = { on ->
                if (on) engine.pauseRecording() else engine.recordingPaused = false
                store.putString(TripEngine.KEY_PAUSED, if (on) "1" else "0")
            },
            gear = { engine.status.gear },
            loadPausePending = { store.getString(KEY_PAUSE_PENDING) == "1" },
            savePausePending = { store.putString(KEY_PAUSE_PENDING, if (it) "1" else "0") },
        )
        // 서버가 기록 멈춤·동의 철회로 트립을 받지 않았다: 설정을 다시 읽어 로컬 멈춤을 맞춘다
        uploader.onPausedByServer = { extras.refreshSettings() }
        extrasController = extras
        // 기어·QR: 기어가 바뀌면 말하는 중인 음성을 다시 확인하고 QR 요청 세대를 올린다
        engine.addGearListener { _ ->
            voiceAdapter.recheck()
            extras.onGearChanged()
        }
        introTracker = IntroTracker(HttpExtrasApi(BuildConfig.SERVER_URL), Executors.newSingleThreadExecutor { r -> Thread(r, "nubi-intro").apply { isDaemon = true } }, { SystemClock.elapsedRealtime() })
        // 정차(P) 진입 때 서버 설정을 다시 읽는다(폰에서 바꾼 기록 멈춤 등)
        val parkedBefore = engine.onParked
        engine.onParked = {
            parkedBefore()
            extras.refreshSettings()
        }
        coverage.onTripSettled = { settledLocalId ->
            val counted = coverage.matching as? MatchingLine.Counted
            // 하차 브리핑: 기어가 P일 때만(숫자는 P에서만 말한다). 새 도로가 없으면 말하지 않는다
            if (engine.status.gear == Gear.P) voice.onTripSettled(counted?.newKm)
            tripSummary.onSettled(counted?.newKm, coverage.newRegions, SystemClock.elapsedRealtime())
            thumbRepo?.invalidate() // 정산으로 달린 길이 달라졌으니 썸네일이 새로 받는다
            place.refresh()
            screen.onTripSettled(settledLocalId, engine.recordingLocalId)
        }
        return engine
    }

    /** 서비스가 시작됐다: 음성 재생을 다시 받는다. */
    fun voiceOpen(context: Context) {
        get(context)
        voiceAdapterRef?.open()
    }

    /** 서비스 onDestroy·onTaskRemoved: 재생 중단 → 포커스 반납 → TTS 해제, 이후 새 재생·포커스 요청을 막는다. */
    fun voiceRelease() {
        voiceAdapterRef?.release()
    }

    /** 데이터 삭제 뒤 화면용 로컬 상태를 비운다(release 빌드에서도). 메인·워커 어느 스레드에서 불러도 된다. */
    private fun purgeLocalViews(screen: MapScreen, coverage: CoverageTracker, place: PlaceTracker) {
        summaryState?.onTripStarted()
        introTracker?.clear()
        coverage.clearAll()
        place.clear()
        screen.onTripStarted() // 로컬 궤적과 잠정 결과를 비운다
        screen.onTripSettled() // 지도 캐시(달린 길·시군구 단계)를 버리고 다시 받는다
        thumbRepo?.invalidate()
        coverage.refreshNational()
        coverage.refreshRegions()
    }

    /** 음성 켜기·끄기를 기기에 저장하고 플래그에 반영한다(서버 설정에 없는 항목이라 로컬에만 둔다). */
    fun setVoicePref(context: Context, on: Boolean) {
        context.applicationContext.getSharedPreferences("nubi", Context.MODE_PRIVATE).edit().putString(KEY_VOICE_PREF, if (on) "1" else "0").apply()
        FeatureFlags.applyVoicePref(on)
        voiceAdapterRef?.recheck() // 끄면 말하는 중이어도 바로 멈춘다(stillAllowed가 플래그를 읽는다)
    }

    private const val KEY_VOICE_PREF = "voicePref"
    private const val KEY_PAUSE_PENDING = "pausePending"
    private const val KEY_PURGE_EPOCH = "purgeEpoch"
    private const val KEY_FILES_EPOCH = "filesEpoch"
}
