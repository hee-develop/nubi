package com.nubi.car.trip

import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

enum class Gear { P, R, N, D }

enum class TripState { IDLE, RECORDING, ENDED }

/** 위치 샘플. [tsMillis]는 벽시계(서버에 보내는 값)이고 판정용 시간은 상태기계 입구의 elapsedRealtime으로 따로 받는다. [gear]는 상태기계가 채운다. */
data class Sample(
    val tsMillis: Long,
    val lat: Double,
    val lon: Double,
    val headingDeg: Float? = null,
    val confidence: Float? = null,
    val gear: Gear? = null,
)

data class TripPoint(val seq: Int, val sample: Sample)

/** 상태기계가 바깥(서비스)에 알리는 일. */
sealed interface TripEvent {
    /** 트립이 시작됐다. [points]는 시작 전에 모아 둔 샘플 포함. */
    data class Started(val startedAtMillis: Long, val points: List<TripPoint>) : TripEvent

    data class PointsAccepted(val points: List<TripPoint>) : TripEvent

    data class Ended(val endedAtMillis: Long) : TripEvent
}

data class TripConfig(
    /** 이 시간 이상 지나고 [slowMinDistanceM] 이상 움직였으면 채택. */
    val minIntervalMillis: Long = 5_000,
    /** 직전 채택점에서 이만큼 이상 움직이면 시간과 상관없이 채택. */
    val minDistanceM: Double = 20.0,
    /** 5초 조건이 적용되려면 직전 채택점에서 최소 이만큼은 움직여야 한다(정지 중 흔들림으로 점이 쌓이지 않게). */
    val slowMinDistanceM: Double = 5.0,
    /** 트립 시작: 첫 대기 샘플에서의 직선 변위. */
    val startDisplacementM: Double = 50.0,
    val parkedEndMillis: Long = 5 * 60_000,
    /** 기어를 모르는 차량: 채택점 변위가 [minDistanceM] 미만인 채로 이만큼 지속되면 종료. */
    val stillEndMillis: Long = 5 * 60_000,
    /** 대기 중 모아 두는 샘플 상한(끝없이 쌓이지 않게). */
    val maxPendingSamples: Int = 200,
)

fun haversineM(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Double {
    val r = 6_371_008.8
    val dLat = Math.toRadians(bLat - aLat)
    val dLon = Math.toRadians(bLon - aLon)
    val h = sin(dLat / 2) * sin(dLat / 2) + cos(Math.toRadians(aLat)) * cos(Math.toRadians(bLat)) * sin(dLon / 2) * sin(dLon / 2)
    return 2 * r * asin(min(1.0, sqrt(h)))
}

fun haversineM(a: Sample, b: Sample): Double = haversineM(a.lat, a.lon, b.lat, b.lon)

/** 테스트용: 위도 차이를 그대로 미터로 쓰는 거리 함수(경계값을 정확히 만들기 위해). */
fun latDiffAsMeters(a: Sample, b: Sample): Double = abs(b.lat - a.lat)

/**
 * IDLE → RECORDING(첫 대기 샘플 기준 직선 변위 50m) → ENDED. Android에 의존하지 않는다.
 * 모든 경과 시간 판정은 호출자가 넘기는 elapsedRealtime(ms)로만 한다(벽시계 금지).
 *
 * - 샘플 채택: 직전 채택점에서 20m 이상이면 채택. 5초 조건은 직전 채택점에서 5m 이상 움직였을 때만 적용한다.
 * - 시작: 대기 샘플(IDLE/ENDED에서 채택한 것)의 첫 샘플에서 직선 변위가 50m 이상이고 기어가 P가 아닐 때(기어 null이면 변위만으로).
 *   대기 샘플부터 트립에 포함한다. 기어 P인 동안의 샘플은 버리고 P로 바뀌면 대기 샘플을 폐기한다.
 * - 종료: 기어 P가 5분 유지되면 종료. P 진입 이후의 샘플은 트립에 넣지 않으므로 종료 시각은 P 진입 전 마지막 채택 샘플 시각이다.
 *   기어를 모르는 차량은 채택점 변위가 20m 미만인 채로 5분 지속되면 종료한다. [onStop]도 마지막 채택 샘플 시각으로 종료한다.
 * - 재개: 종료 뒤 기어가 R/N/D로 바뀌면 즉시 새 트립을 받을 수 있고, 기어를 모르면 새 변위 50m가 되는 즉시 새 트립이 시작된다.
 */
class TripStateMachine(
    private val config: TripConfig = TripConfig(),
    private val distance: (Sample, Sample) -> Double = ::haversineM,
) {
    var state: TripState = TripState.IDLE
        private set
    var sampleCount: Int = 0
        private set
    var distanceM: Double = 0.0
        private set
    var gear: Gear? = null
        private set

    val pendingSampleCount: Int get() = pending.size

    private var lastAccepted: Sample? = null
    private var lastAcceptedElapsed = 0L

    /**
     * 마지막으로 받은 원시 위치. 채택 여부·기어와 무관하게(기어 P에서도) 갱신하고 트립에는 넣지 않는다.
     * 정차 화면의 '지금 있는 곳' 조회에만 쓰고, 메모리에만 두며 [reset]에서 지운다.
     */
    var lastRaw: Sample? = null
        private set
    private val pending = ArrayList<Sample>()
    private var nextSeq = 0
    private var parkedSinceElapsed: Long? = null

    /** 기어 null 차량의 정지 판정 기준점: 마지막으로 직전 기준점에서 20m 이상 움직인 채택 샘플과 그때의 elapsedRealtime. */
    private var anchor: Sample? = null
    private var anchorElapsed = 0L

    fun onGear(newGear: Gear?, elapsedMillis: Long): List<TripEvent> {
        gear = newGear
        if (newGear == Gear.P) {
            if (parkedSinceElapsed == null) parkedSinceElapsed = elapsedMillis
            if (state != TripState.RECORDING) {
                pending.clear()
                lastAccepted = null
            }
        } else {
            parkedSinceElapsed = null
            if (state == TripState.ENDED && newGear != null) resetToIdle()
        }
        return emptyList()
    }

    fun onLocation(raw: Sample, elapsedMillis: Long): List<TripEvent> {
        lastRaw = raw
        // 기어가 P면 대기 중이든 기록 중이든 샘플을 트립에 넣지 않는다.
        if (gear == Gear.P) return emptyList()
        val sample = raw.copy(gear = gear)
        val last = lastAccepted
        val moved = last?.let { distance(it, sample) } ?: 0.0
        if (last != null) {
            val elapsedSinceLast = elapsedMillis - lastAcceptedElapsed
            val accept = moved >= config.minDistanceM || (moved >= config.slowMinDistanceM && elapsedSinceLast >= config.minIntervalMillis)
            if (!accept) return emptyList()
        }
        lastAccepted = sample
        lastAcceptedElapsed = elapsedMillis

        if (state == TripState.RECORDING) {
            if (anchor?.let { distance(it, sample) >= config.minDistanceM } != false) {
                anchor = sample
                anchorElapsed = elapsedMillis
            }
            distanceM += moved
            val point = TripPoint(nextSeq++, sample)
            sampleCount++
            return listOf(TripEvent.PointsAccepted(listOf(point)))
        }

        // IDLE 또는 ENDED(재개 대기): 대기 샘플을 모아 첫 샘플 기준 직선 변위로 시작을 판정한다.
        pending.add(sample)
        if (pending.size > config.maxPendingSamples) pending.removeAt(0)
        if (distance(pending.first(), sample) < config.startDisplacementM) return emptyList()
        nextSeq = 0
        val points = pending.map { TripPoint(nextSeq++, it) }
        distanceM = 0.0
        for (i in 1 until pending.size) distanceM += distance(pending[i - 1], pending[i])
        sampleCount = points.size
        val startedAt = pending.first().tsMillis
        pending.clear()
        anchor = sample
        anchorElapsed = elapsedMillis
        state = TripState.RECORDING
        return listOf(TripEvent.Started(startedAt, points))
    }

    /** 주기적으로 부른다. 기어 P 5분 유지(또는 기어 null 차량의 5분 정지)면 종료한다. */
    fun onTick(elapsedMillis: Long): List<TripEvent> {
        if (state != TripState.RECORDING) return emptyList()
        val since = parkedSinceElapsed
        if (since != null && elapsedMillis - since >= config.parkedEndMillis) return end()
        if (gear == null && elapsedMillis - anchorElapsed >= config.stillEndMillis) return end()
        return emptyList()
    }

    /** 서비스 종료·task 제거. 기록 중이면 마지막 채택 샘플 시각으로 종료한다. */
    fun onStop(): List<TripEvent> = if (state == TripState.RECORDING) end() else emptyList()

    /** 상태를 모두 비운다(서비스 재시작·디버그 초기화용). */
    fun reset() {
        resetToIdle()
        gear = null
        parkedSinceElapsed = null
        lastRaw = null
    }

    private fun end(): List<TripEvent> {
        val endedAt = lastAccepted?.tsMillis ?: return emptyList()
        state = TripState.ENDED
        pending.clear()
        lastAccepted = null
        anchor = null
        return listOf(TripEvent.Ended(endedAt))
    }

    private fun resetToIdle() {
        state = TripState.IDLE
        pending.clear()
        lastAccepted = null
        anchor = null
        sampleCount = 0
        distanceM = 0.0
        nextSeq = 0
    }
}
