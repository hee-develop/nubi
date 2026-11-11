package com.nubi.car.screens

import android.util.Log
import com.nubi.car.trip.HttpFailure
import org.json.JSONObject
import java.util.concurrent.Executor

enum class CodeKind { GUEST, PAIR, SHARE }

enum class CodeError { NOT_PARKED, GUEST_LIMIT, ALREADY_PAIRED, UNAVAILABLE, FAILED }

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
    /** 데이터를 지웠다(지도 캐시·도감·전국 숫자를 비운다). */
    private val onDataDeleted: () -> Unit = {},
    private val wallMs: () -> Long = { System.currentTimeMillis() },
) {
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

    // 설정 -----------------------------------------------------------------

    /** 시작할 때와 정차 진입 때 부른다. 실패하면 마지막 값을 유지한다. */
    fun refreshSettings() = work {
        val id = vehicleId() ?: return@work
        try {
            val s = api.getSettings(id)
            settings = s
            settingsError = false
            applySettings(s)
        } catch (e: Exception) {
            settingsError = true
            Log.w(TAG, "설정 조회 실패: ${e.javaClass.simpleName}")
        }
    }

    /** 설정 한 항목을 바꾼다(부분 갱신). 서버 응답이 새 값이다. */
    fun update(patch: JSONObject) = work {
        val id = vehicleId() ?: return@work
        try {
            val s = api.putSettings(id, patch)
            settings = s
            settingsError = false
            applySettings(s)
        } catch (e: Exception) {
            settingsError = true
            Log.w(TAG, "설정 변경 실패: ${e.javaClass.simpleName}")
        }
    }

    fun setPaused(paused: Boolean) = update(JSONObject().put("recordingPaused", paused))

    fun setDrivingMap(on: Boolean) = update(JSONObject().put("drivingMap", on))

    /** [code]가 null이면 '지정 안 함'. */
    fun setHomeRegion(code: String?) = update(JSONObject().put("homeRegion", code ?: JSONObject.NULL))

    // 데이터 지우기(2단계 확인) ----------------------------------------------

    fun startDelete() {
        if (deleteStep == DeleteStep.NONE || deleteStep == DeleteStep.DONE || deleteStep == DeleteStep.FAILED) deleteStep = DeleteStep.CONFIRM_1
    }

    fun confirmDeleteFirst() {
        if (deleteStep == DeleteStep.CONFIRM_1) deleteStep = DeleteStep.CONFIRM_2
    }

    fun cancelDelete() {
        if (deleteStep != DeleteStep.WORKING) deleteStep = DeleteStep.NONE
    }

    /** 두 번째 확인 뒤에만 서버를 부른다. 그 밖의 단계에서는 아무 일도 하지 않는다. */
    fun confirmDeleteFinal() {
        if (deleteStep != DeleteStep.CONFIRM_2) return
        deleteStep = DeleteStep.WORKING
        work {
            val id = vehicleId()
            if (id == null) {
                deleteStep = DeleteStep.FAILED
                return@work
            }
            try {
                api.deleteData(id)
                deleteStep = DeleteStep.DONE
                dex.clear()
                almostRoads.clear()
                allRoads.clear()
                daily.clear()
                monthly.clear()
                guestCount = null
                try {
                    onDataDeleted()
                } catch (t: Throwable) {
                    Log.w(TAG, "삭제 알림 예외: ${t.javaClass.simpleName}")
                }
                refreshSettings()
            } catch (e: Exception) {
                deleteStep = DeleteStep.FAILED
                Log.w(TAG, "데이터 삭제 실패: ${e.javaClass.simpleName}")
            }
        }
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

    fun requestGuestCode() = issue(CodeKind.GUEST) {
        val c = api.guestCode(it)
        CodeState(CodeKind.GUEST, c.url, c.code, elapsedMs(), qrMatrix(c.url))
    }

    fun requestPairCode() = issue(CodeKind.PAIR) {
        val c = api.pairCode(it)
        CodeState(CodeKind.PAIR, c.url, c.code, elapsedMs(), qrMatrix(c.url))
    }

    fun requestShare() = issue(CodeKind.SHARE) {
        val url = api.shareNational(it)
        CodeState(CodeKind.SHARE, url, null, elapsedMs(), qrMatrix(url))
    }

    private fun issue(kind: CodeKind, make: (String) -> CodeState) {
        if (!allowed()) {
            closeCodes()
            return
        }
        codeError = null
        work {
            val id = vehicleId() ?: return@work
            try {
                val s = make(id)
                // 받는 사이 기어가 P를 벗어났으면 보이지 않고 버린다(plan 9-2)
                if (!allowed()) return@work
                when (kind) {
                    CodeKind.GUEST -> guest = s
                    CodeKind.PAIR -> pair = s
                    CodeKind.SHARE -> share = s
                }
                if (s.matrix == null) codeError = kind to CodeError.FAILED
            } catch (e: HttpFailure) {
                codeError = kind to when {
                    e.status == 403 -> CodeError.NOT_PARKED
                    e.status == 409 && kind == CodeKind.GUEST -> CodeError.GUEST_LIMIT
                    e.status == 409 -> CodeError.ALREADY_PAIRED
                    e.status == 503 -> CodeError.UNAVAILABLE
                    else -> CodeError.FAILED
                }
            } catch (e: Exception) {
                codeError = kind to CodeError.FAILED
                Log.w(TAG, "QR 요청 실패: ${e.javaClass.simpleName}")
            }
        }
    }

    /** 모든 QR·코드를 지운다. 기어가 P를 벗어나거나 DO가 걸리면 화면이 바로 부른다. */
    fun closeCodes() {
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

    private fun work(block: () -> Unit) {
        try {
            executor.execute {
                try {
                    block()
                } catch (t: Throwable) {
                    Log.w(TAG, "작업 예외: ${t.javaClass.simpleName}")
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "작업 등록 실패: ${t.javaClass.simpleName}")
        }
    }

    private companion object {
        const val TAG = "NubiExtras"
    }
}
