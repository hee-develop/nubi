package com.nubi.car.trip

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

enum class Gear { P, R, N, D }

enum class TripState { IDLE, RECORDING, ENDED }

/** 위치 샘플. [gear]는 상태기계가 채운다(들어올 때 값은 무시). */
data class Sample(
    val tsMillis: Long,
    val lat: Double,
    val lon: Double,
    val headingDeg: Float? = null,
    val confidence: Float? = null,
    val speedKph: Float? = null,
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
    val minIntervalMillis: Long = 5_000,
    val minDistanceM: Double = 20.0,
    val startDistanceM: Double = 50.0,
    val parkedEndMillis: Long = 5 * 60_000,
    /** 대기 중 모아 두는 샘플 상한(주차 중 GPS 흔들림이 끝없이 쌓이지 않게). */
    val maxPendingSamples: Int = 200,
)

fun haversineM(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Double {
    val r = 6_371_008.8
    val dLat = Math.toRadians(bLat - aLat)
    val dLon = Math.toRadians(bLon - aLon)
    val h = sin(dLat / 2) * sin(dLat / 2) + cos(Math.toRadians(aLat)) * cos(Math.toRadians(bLat)) * sin(dLon / 2) * sin(dLon / 2)
    return 2 * r * asin(min(1.0, sqrt(h)))
}

/**
 * IDLE → RECORDING(누적 이동 50m) → ENDED(P 5분 또는 stop). Android에 의존하지 않는다. 시각은 모두 호출자가 넘긴다.
 *
 * - 샘플 채택: 직전 채택 샘플에서 5초 이상 또는 20m 이상 떨어진 것만.
 * - 대기 중(IDLE)에는 채택 샘플을 모아 두었다가 누적 이동이 50m에 닿으면 모은 것까지 포함해 시작한다.
 *   기어가 P인 동안의 대기 샘플은 버린다(주차 중 흔들림으로 트립이 생기지 않게).
 * - 종료(ENDED) 뒤에는 기어가 P가 아닌 값(R/N/D)으로 바뀌면 다시 IDLE이 된다.
 * - 종료 시각은 마지막 채택 샘플 시각이다.
 */
class TripStateMachine(private val config: TripConfig = TripConfig()) {
    var state: TripState = TripState.IDLE
        private set
    var sampleCount: Int = 0
        private set
    var distanceM: Double = 0.0
        private set
    var gear: Gear? = null
        private set

    private var lastAccepted: Sample? = null
    private val pending = ArrayList<Sample>()
    private var nextSeq = 0
    private var parkedSinceMillis: Long? = null

    fun onGear(newGear: Gear?, nowMillis: Long): List<TripEvent> {
        gear = newGear
        if (newGear == Gear.P) {
            if (parkedSinceMillis == null) parkedSinceMillis = nowMillis
            if (state == TripState.IDLE) pending.clear()
        } else {
            parkedSinceMillis = null
            if (state == TripState.ENDED && newGear != null) resetToIdle()
        }
        return emptyList()
    }

    fun onLocation(raw: Sample): List<TripEvent> {
        if (state == TripState.ENDED) return emptyList()
        val sample = raw.copy(gear = gear)
        val last = lastAccepted
        if (last != null) {
            val moved = haversineM(last.lat, last.lon, sample.lat, sample.lon)
            if (sample.tsMillis - last.tsMillis < config.minIntervalMillis && moved < config.minDistanceM) return emptyList()
        }
        lastAccepted = sample
        return when (state) {
            TripState.RECORDING -> {
                last?.let { distanceM += haversineM(it.lat, it.lon, sample.lat, sample.lon) }
                val point = TripPoint(nextSeq++, sample)
                sampleCount++
                listOf(TripEvent.PointsAccepted(listOf(point)))
            }
            TripState.IDLE -> {
                if (gear == Gear.P) return emptyList()
                pending.add(sample)
                if (pending.size > config.maxPendingSamples) pending.removeAt(0)
                if (pathLength(pending) < config.startDistanceM) return emptyList()
                val points = pending.map { TripPoint(nextSeq++, it) }
                distanceM = pathLength(pending)
                sampleCount = points.size
                pending.clear()
                state = TripState.RECORDING
                listOf(TripEvent.Started(points.first().sample.tsMillis, points))
            }
            TripState.ENDED -> emptyList()
        }
    }

    /** 주기적으로 부른다. 기어 P가 5분 이어졌으면 종료한다. */
    fun onTick(nowMillis: Long): List<TripEvent> {
        val since = parkedSinceMillis ?: return emptyList()
        if (state == TripState.RECORDING && nowMillis - since >= config.parkedEndMillis) return end()
        return emptyList()
    }

    /** 앱 Suspend·서비스 종료. 기록 중이면 종료한다. */
    fun onStop(): List<TripEvent> = if (state == TripState.RECORDING) end() else emptyList()

    /** 상태를 모두 비운다(디버그 초기화용). */
    fun reset() {
        resetToIdle()
        gear = null
        parkedSinceMillis = null
    }

    private fun end(): List<TripEvent> {
        val endedAt = lastAccepted?.tsMillis ?: return emptyList()
        state = TripState.ENDED
        return listOf(TripEvent.Ended(endedAt))
    }

    private fun resetToIdle() {
        state = TripState.IDLE
        pending.clear()
        lastAccepted = null
        sampleCount = 0
        distanceM = 0.0
        nextSeq = 0
    }

    private fun pathLength(samples: List<Sample>): Double {
        var sum = 0.0
        for (i in 1 until samples.size) sum += haversineM(samples[i - 1].lat, samples[i - 1].lon, samples[i].lat, samples[i].lon)
        return sum
    }
}
