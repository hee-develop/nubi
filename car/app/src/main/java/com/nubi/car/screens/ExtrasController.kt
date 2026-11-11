package com.nubi.car.screens

import android.util.Log
import com.nubi.car.trip.Gear
import com.nubi.car.trip.HttpFailure
import org.json.JSONObject
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicInteger

enum class CodeKind { GUEST, PAIR, SHARE }

enum class CodeError { NOT_PARKED, GUEST_LIMIT, ALREADY_PAIRED, UNAVAILABLE, FAILED, NO_VEHICLE, RATE_LIMITED, FORBIDDEN, LOCAL_ONLY, AUTH }

/** 화면에 떠 있는 QR 하나. [code]는 6자리(공유 카드는 없음), [receivedElapsedMs]는 받은 순간의 단조 시계. */
class CodeState(val kind: CodeKind, val url: String, val code: String?, val receivedElapsedMs: Long, val matrix: Array<BooleanArray>?)

/** 데이터 지우기 확인 단계(메뉴 깊이를 늘리지 않고 설정 탭 안에서 2단계). */
enum class DeleteStep { NONE, CONFIRM_1, CONFIRM_2, WORKING, DONE, FAILED }

/**
 * 정차 메뉴(도감·도로·오늘·설정)와 QR의 상태·서버 호출. 모든 네트워크는 [executor]에서 하고 결과는 @Volatile 필드로 남기며 화면이 1초마다 읽는다.
 * QR은 [allowed]가 false가 되는 순간(기어가 P를 벗어남·DO) [closeCodes]로 바로 지운다.
 */
class ExtrasController(
    private val api: ExtrasApi,
    private val executor: Executor,
    private val vehicleId: () -> String?,
    /** 기어 P이고 DO가 아닌지(메뉴·QR을 보여도 되는지). 호출 시점의 값. */
    private val allowed: () -> Boolean,
    private val elapsedMs: () -> Long,
    /** 서버 설정을 받았다(엔진·플래그에 반영). 워커 스레드에서 불린다. */
    private val applySettings: (ServerSettings) -> Unit,
    /**
     * 데이터 삭제가 서버에서 성공했다. 로컬 정리를 **이 순서로** 한다: 기록 멈춤을 먼저 켜고 저장 → 업로드 큐·진행 중 트립 버리기 → 요약·궤적·잠정 결과·coverage·place·intro·지도 캐시 비우기.
     * 워커 스레드에서 불린다.
     */
    private val onDataDeleted: () -> Unit = {},
    /** 기록 멈춤 **켜기**를 서버 응답을 기다리지 않고 로컬(엔진)에 바로 적용하고 저장한다. 오프라인에서도 멈춰야 한다. */
    private val applyLocalPause: (Boolean) -> Unit = {},
    /** 지금 기어(서버에 실제 값을 보낸다). */
    private val gear: () -> Gear? = { Gear.P },
    /** 로컬 멈춤이 서버에 안 닿은 상태(켜기를 누른 시각, epoch ms)를 저장·복원한다. 재시작해도 같은 의도 시각으로 켜기를 다시 보낸다. 없으면 null. */
    private val loadPausePending: () -> Long? = { null },
    private val savePausePending: (Long?) -> Unit = {},
    /** 사용자 의도의 시각(기기 시계, epoch ms). 서버가 다른 기기의 더 늦은 변경과 순서를 가리는 데 쓴다. */
    private val intentClock: () -> Long = { System.currentTimeMillis() },
) {
    /** 요청마다 올리는 세대 번호. 기어가 바뀌거나 코드를 닫을 때 올라가서 늦게 온 응답이 QR을 되살리지 못한다. */
    private val generation = AtomicInteger()

    private val loadedPending: Long? = try {
        loadPausePending()
    } catch (t: Throwable) {
        null
    }

    /** 로컬에서 멈췄지만(켜기) 서버에는 아직 닿지 않았다. 저장해 두었다가 재시작 뒤에도 서버 동기화를 재시도한다([syncPendingPause]). */
    @Volatile
    var pausePending = loadedPending != null
        private set

    /** 켜기를 누른 시각(서버로 보내는 의도 시각). */
    @Volatile
    private var pauseIntentMs = loadedPending ?: 0L

    /** 멈춤 켜기·끄기를 누를 때마다 올라간다('마지막 의도'만 유효). 늦게 온 옛 의도의 응답은 무시한다. */
    @Volatile
    private var intent = 0

    @Volatile
    private var pauseFailures = 0

    @Volatile
    private var pauseNextTryAt = 0L

    /** 권한 문제(403 forbidden·local_only)로 재전송을 멈췄다. 사용자가 다시 켜기를 누를 때까지. */
    @Volatile
    private var pausePermanent = false
    private val pushInFlight = java.util.concurrent.atomic.AtomicBoolean(false)

    private fun setPending(v: Boolean) {
        pausePending = v
        try {
            savePausePending(if (v) pauseIntentMs else null)
        } catch (t: Throwable) {
            Log.w(TAG, "멈춤 대기 저장 실패: ${t.javaClass.simpleName}")
        }
    }

    /** 설정을 아직(또는 못) 불러오지 못했을 때 화면이 쓰는 기본값. 설정 탭의 토글·삭제는 이 값으로도 쓸 수 있다. */
    val settingsOrDefault: ServerSettings get() = settings ?: ServerSettings(pausePending, null, true, true, false)

    /** 대기 중인 멈춤이 있으면 화면에 보이는 설정의 recordingPaused는 항상 로컬 값(켜짐)이다. */
    private fun reconcile(s: ServerSettings): ServerSettings = if (pausePending) s.copy(recordingPaused = true) else s

    @Volatile
    var settings: ServerSettings? = null
        private set

    @Volatile
    var settingsError = false
        private set

    val dex = Slot<List<DexItem>>()
    val almostRoads = Slot<List<RoadItem>>()
    val allRoads = Slot<List<RoadItem>>()
    val daily = Slot<Report>()
    val monthly = Slot<Report>()

    @Volatile
    var guest: CodeState? = null
        private set

    @Volatile
    var pair: CodeState? = null
        private set

    @Volatile
    var share: CodeState? = null
        private set

    @Volatile
    var codeError: Pair<CodeKind, CodeError>? = null
        private set

    /** '같이 탄 사람 n명'. 모르면 null. */
    @Volatile
    var guestCount: Int? = null
        private set

    @Volatile
    var deleteStep = DeleteStep.NONE
        private set

    private fun resetBackoff() {
        pauseFailures = 0
        pauseNextTryAt = 0L
    }

    // 설정 -----------------------------------------------------------------

    /**
     * 시작할 때·정차 진입·설정 탭 열기에서 부른다(백오프를 초기화한다). 설정은 항상 읽되, 로컬 멈춤이 서버에 안 닿았다면(저장돼 재시작 뒤에도 남는다)
     * 서버 값의 recordingPaused 대신 로컬 값을 유지하고 켜기를 다시 보낸다. 읽기가 실패하면 마지막 값을 유지한다.
     */
    fun refreshSettings() {
        resetBackoff()
        work {
            val id = vehicleId() ?: return@work
            try {
                val s = reconcile(api.getSettings(id))
                settings = s
                settingsError = false
                applySettings(s)
            } catch (e: Exception) {
                settingsError = true
                Log.w(TAG, "설정 조회 실패: ${e.javaClass.simpleName}")
            }
        }
        syncPendingPause()
    }

    /** 연결이 살아났다(어떤 요청이든 성공): 멈춤 재전송 백오프를 풀고 바로 다시 보낸다. */
    fun onConnectivity() {
        if (!pausePending || pausePermanent) return
        pauseNextTryAt = 0L
        pushPause()
    }

    /** 설정 한 항목을 바꾼다(부분 갱신). 서버 응답이 새 값이다. 멈춤이 대기 중이면 응답이 와도 recordingPaused는 로컬 값을 유지한다. 화면을 열어도 되는 상태일 때만. */
    fun update(patch: JSONObject) {
        if (!allowed()) return
        work {
            val id = vehicleId() ?: return@work
            try {
                val s = reconcile(api.putSettings(id, patch))
                settings = s
                settingsError = false
                applySettings(s)
            } catch (e: Exception) {
                settingsError = true
                Log.w(TAG, "설정 변경 실패: ${e.javaClass.simpleName}")
            }
        }
    }

    /**
     * 기록 멈춤("이후 기록만 멈춘다"). **켜기**는 로컬(엔진)에 즉시 적용·저장하고(진행 중 트립은 엔진이 End로 끝낸다) 서버에 **의도 시각**과 함께 보낸다.
     * 못 보내면 대기로 남겨 다시 보낸다. **끄기**는 대기를 풀고 서버가 확인한 뒤에만 적용한다. 켜기·끄기는 마지막 의도 하나만 유효하고,
     * 서버는 마지막 멈춤 상태 변경보다 오래된 의도를 무시하고 현재 값을 돌려준다(그 응답이 오면 대기를 버리고 서버 값을 따른다).
     */
    fun setPaused(paused: Boolean) {
        if (!allowed()) return
        intent++
        resetBackoff()
        pausePermanent = false
        val at = intentClock()
        if (!paused) {
            setPending(false)
            update(JSONObject().put("recordingPaused", false).put("intentAt", isoOf(at)))
            return
        }
        pauseIntentMs = at
        applyLocalPause(true)
        setPending(true)
        settings = settingsOrDefault.copy(recordingPaused = true)
        settingsError = false
        pushPause()
    }

    /** 로컬 멈춤이 서버에 안 닿았을 때 다시 보낸다(정차 진입·화면 복귀·주기). 백오프 중이거나 권한 문제로 멈췄으면 보내지 않는다. */
    fun syncPendingPause() {
        if (!pausePending || pausePermanent) return
        if (elapsedMs() < pauseNextTryAt) return
        pushPause()
    }

    private fun pushPause() {
        if (!pushInFlight.compareAndSet(false, true)) return
        val seq = intent
        val queued = work {
            try {
                val id = vehicleId() ?: return@work
                try {
                    val patch = JSONObject().put("recordingPaused", true).put("intentAt", isoOf(pauseIntentMs))
                    val s = api.putSettings(id, patch)
                    if (seq != intent) return@work // 그 사이 끄기를 눌렀다: 옛 켜기 응답은 무시
                    // 서버가 더 늦은 다른 기기의 변경 때문에 이 켜기를 무시했다면 recordingPaused=false가 온다: 대기를 버리고 서버 값을 따른다
                    setPending(false)
                    resetBackoff()
                    settings = s
                    settingsError = false
                    applySettings(s)
                } catch (e: Exception) {
                    if (seq != intent) return@work
                    settingsError = true // 로컬 멈춤은 그대로 두고 나중에 다시 보낸다
                    if (e is HttpFailure && e.status == 403 && (e.code == "forbidden" || e.code == "local_only")) {
                        pausePermanent = true // 권한 문제는 다시 보내도 같다
                    } else {
                        pauseFailures++
                        pauseNextTryAt = elapsedMs() + minOf(BACKOFF_BASE_MS shl minOf(pauseFailures - 1, 5), BACKOFF_MAX_MS)
                    }
                    Log.w(TAG, "기록 멈춤 서버 동기화 실패(로컬은 멈춤, ${pauseFailures}회): ${e.javaClass.simpleName}")
                }
            } finally {
                pushInFlight.set(false)
            }
        }
        if (!queued) pushInFlight.set(false)
    }

    private fun isoOf(ms: Long): String =
        java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date(ms))

    fun setDrivingMap(on: Boolean) = update(JSONObject().put("drivingMap", on))

    /** [code]가 null이면 '지정 안 함'. */
    fun setHomeRegion(code: String?) = update(JSONObject().put("homeRegion", code ?: JSONObject.NULL))

    // 데이터 지우기(2단계 확인) ----------------------------------------------

    fun startDelete() {
        if (!allowed()) {
            deleteStep = DeleteStep.NONE
            return
        }
        if (deleteStep == DeleteStep.NONE || deleteStep == DeleteStep.DONE || deleteStep == DeleteStep.FAILED) deleteStep = DeleteStep.CONFIRM_1
    }

    fun confirmDeleteFirst() {
        if (!allowed()) {
            deleteStep = DeleteStep.NONE
            return
        }
        if (deleteStep == DeleteStep.CONFIRM_1) deleteStep = DeleteStep.CONFIRM_2
    }

    fun cancelDelete() {
        if (deleteStep != DeleteStep.WORKING) deleteStep = DeleteStep.NONE
    }

    /**
     * 두 번째 확인 뒤에만 서버를 부른다. 성공하면 [onDataDeleted]로 로컬을 정리하고(기록 멈춤 먼저) 설정을 다시 읽는다.
     * 작업을 못 올렸거나 실패하면 FAILED로 두어 다시 시도할 수 있다.
     */
    fun confirmDeleteFinal() {
        if (deleteStep != DeleteStep.CONFIRM_2) return
        if (!allowed()) {
            deleteStep = DeleteStep.NONE
            return
        }
        deleteStep = DeleteStep.WORKING
        val queued = work {
            val id = vehicleId()
            if (id == null) {
                deleteStep = DeleteStep.FAILED
                return@work
            }
            try {
                api.deleteData(id)
            } catch (t: Throwable) {
                deleteStep = DeleteStep.FAILED
                Log.w(TAG, "데이터 삭제 실패: ${t.javaClass.simpleName}")
                return@work
            }
            try {
                onDataDeleted()
            } catch (t: Throwable) {
                Log.w(TAG, "삭제 뒤 로컬 정리 예외: ${t.javaClass.simpleName}")
            }
            setPending(false) // 서버도 멈춤 상태가 됐다(대기할 것이 없다)
            dex.clear()
            almostRoads.clear()
            allRoads.clear()
            daily.clear()
            monthly.clear()
            guestCount = null
            closeCodes()
            deleteStep = DeleteStep.DONE
            // 서버 설정 조회가 실패해도 로컬 멈춤은 유지된다(onDataDeleted가 이미 켰다)
            refreshSettings()
        }
        if (!queued) deleteStep = DeleteStep.FAILED
    }

    // 조회 탭 ----------------------------------------------------------------

    fun loadDex() = load(dex) { api.regionsList(it) }

    fun loadRoads() {
        load(almostRoads) { api.roads(it, almostOnly = true, limit = 20) }
        load(allRoads) { api.roads(it, almostOnly = false, limit = 30) }
    }

    /** [nowMs]는 엔진 시계(debug `now=`를 따른다). 서버 리포트가 KST 날짜·달 기준이라 같은 시계로 날짜를 만든다. */
    fun loadToday(nowMs: Long) {
        load(daily) { api.dailyReport(it, kstDate(nowMs)) }
        load(monthly) { api.monthlyReport(it, kstMonth(nowMs)) }
    }

    private fun <T> load(slot: Slot<T>, fetch: (String) -> T) {
        slot.loading()
        work {
            val id = vehicleId()
            if (id == null) {
                slot.failed()
                return@work
            }
            try {
                slot.ok(fetch(id))
            } catch (e: Exception) {
                slot.failed()
                Log.w(TAG, "조회 실패: ${e.javaClass.simpleName}")
            }
        }
    }

    // QR --------------------------------------------------------------------

    fun requestGuestCode() = issue(CodeKind.GUEST) { id, g ->
        val c = api.guestCode(id, g)
        CodeState(CodeKind.GUEST, c.url, c.code, elapsedMs(), qrMatrix(c.url))
    }

    fun requestPairCode() = issue(CodeKind.PAIR) { id, g ->
        val c = api.pairCode(id, g)
        CodeState(CodeKind.PAIR, c.url, c.code, elapsedMs(), qrMatrix(c.url))
    }

    fun requestShare() = issue(CodeKind.SHARE) { id, _ ->
        val url = api.shareNational(id)
        CodeState(CodeKind.SHARE, url, null, elapsedMs(), qrMatrix(url))
    }

    private fun issue(kind: CodeKind, make: (String, String) -> CodeState) {
        val g = gear()
        if (!allowed() || g != Gear.P) {
            closeCodes()
            return
        }
        codeError = null
        val gen = generation.incrementAndGet()
        work {
            val id = vehicleId()
            if (id == null) {
                codeError = kind to CodeError.NO_VEHICLE
                return@work
            }
            try {
                val s = make(id, g.name)
                // 받는 사이 기어가 P를 벗어났거나 코드를 닫았다면(세대가 바뀜) 보이지 않고 버린다(plan 9-2)
                if (gen != generation.get() || !allowed() || gear() != Gear.P) return@work
                when (kind) {
                    CodeKind.GUEST -> guest = s
                    CodeKind.PAIR -> pair = s
                    CodeKind.SHARE -> share = s
                }
                if (s.matrix == null) codeError = kind to CodeError.FAILED
            } catch (e: HttpFailure) {
                if (gen != generation.get()) return@work
                codeError = kind to when {
                    e.status == 401 || e.code == "unauthorized" -> CodeError.AUTH
                    e.status == 403 && e.code == "local_only" -> CodeError.LOCAL_ONLY
                    e.status == 403 && e.code == "not_parked" -> CodeError.NOT_PARKED
                    e.status == 403 -> CodeError.FORBIDDEN
                    e.status == 429 -> CodeError.RATE_LIMITED
                    e.status == 409 && kind == CodeKind.GUEST -> CodeError.GUEST_LIMIT
                    e.status == 409 -> CodeError.ALREADY_PAIRED
                    e.status == 503 -> CodeError.UNAVAILABLE
                    else -> CodeError.FAILED
                }
            } catch (e: Exception) {
                if (gen != generation.get()) return@work
                codeError = kind to CodeError.FAILED
                Log.w(TAG, "QR 요청 실패: ${e.javaClass.simpleName}")
            }
        }
    }

    /** 기어가 바뀌었다(엔진 콜백). 진행 중인 QR 요청을 무효로 하고, P가 아니면 열려 있는 QR을 바로 닫는다. */
    fun onGearChanged() {
        generation.incrementAndGet()
        if (!allowed() || gear() != Gear.P) closeCodes()
    }

    /** 모든 QR·코드를 지운다. 기어가 P를 벗어나거나 DO가 걸리면 화면이 바로 부른다. */
    fun closeCodes() {
        generation.incrementAndGet()
        guest = null
        pair = null
        share = null
        codeError = null
    }

    fun closeCode(kind: CodeKind) {
        when (kind) {
            CodeKind.GUEST -> guest = null
            CodeKind.PAIR -> pair = null
            CodeKind.SHARE -> share = null
        }
    }

    /** 코드 시간이 다 지났다면 지운다(만료된 QR을 계속 보이지 않는다). 1초마다 부른다. */
    fun expireCodes() {
        val now = elapsedMs()
        guest?.let { if (remainingMs(it.receivedElapsedMs, now) <= 0L) guest = null }
        pair?.let { if (remainingMs(it.receivedElapsedMs, now) <= 0L) pair = null }
    }

    fun refreshGuestCount() = work {
        val id = vehicleId() ?: return@work
        try {
            guestCount = api.guestSessions(id)
        } catch (e: Exception) {
            Log.w(TAG, "같이 탄 사람 조회 실패: ${e.javaClass.simpleName}")
        }
    }

    fun endAllGuests() = work {
        val id = vehicleId() ?: return@work
        try {
            api.guestEndAll(id)
            guestCount = 0
            guest = null
        } catch (e: Exception) {
            Log.w(TAG, "모두 내리기 실패: ${e.javaClass.simpleName}")
        }
    }

    /** [block]을 워커에 올린다. 올렸으면 true, 실행기가 거절했으면 false. */
    private fun work(block: () -> Unit): Boolean = try {
        executor.execute {
            try {
                block()
            } catch (t: Throwable) {
                Log.w(TAG, "작업 예외: ${t.javaClass.simpleName}")
            }
        }
        true
    } catch (t: Throwable) {
        Log.w(TAG, "작업 등록 실패: ${t.javaClass.simpleName}")
        false
    }

    private companion object {
        const val BACKOFF_BASE_MS = 30_000L
        const val BACKOFF_MAX_MS = 10 * 60_000L
        const val TAG = "NubiExtras"
    }
}
