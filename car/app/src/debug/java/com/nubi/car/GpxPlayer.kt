package com.nubi.car

import android.content.Context
import android.util.Log
import com.nubi.car.trip.Gear
import com.nubi.car.trip.TripEngine
import com.nubi.car.trip.haversineM
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.ScheduledExecutorService

/** GPX의 trkpt(lat·lon)를 1초 간격으로 엔진에 넣는다. 시간 정보는 쓰지 않는다. [parkAtEnd]면 마지막 점을 넣은 뒤 기어를 P로 바꾼다(숫자는 기어 P에서만 보이므로 E2E가 재생 끝을 화면으로 알 수 있게). */
object GpxPlayer {
    private val point = Regex("""<(?:trkpt|wpt|rtept)\s[^>]*?lat="([-0-9.]+)"[^>]*?lon="([-0-9.]+)"""", RegexOption.IGNORE_CASE)
    private var scheduler: ScheduledExecutorService? = null
    private var task: Future<*>? = null

    @Synchronized
    fun play(context: Context, engine: TripEngine, assetName: String, parkAtEnd: Boolean = false) {
        stop()
        val text = context.assets.open(assetName).bufferedReader().use { it.readText() }
        val pts = point.findAll(text).map { it.groupValues[1].toDouble() to it.groupValues[2].toDouble() }.toList()
        require(pts.isNotEmpty()) { "GPX에 점이 없습니다: $assetName" }
        Log.i("NubiDebug", "GPX 재생 시작: $assetName ${pts.size}점")
        val s = Executors.newSingleThreadScheduledExecutor()
        scheduler = s
        var i = 0
        task = s.scheduleAtFixedRate({
            if (i >= pts.size) {
                if (parkAtEnd) engine.onGear(Gear.P)
                s.shutdown()
                return@scheduleAtFixedRate
            }
            val (lat, lon) = pts[i]
            val next = pts.getOrNull(i + 1)
            val heading = next?.let { bearing(lat, lon, it.first, it.second) }
            engine.onLocation(lat, lon, heading, 1f)
            i++
        }, 0, 1, TimeUnit.SECONDS)
    }

    @Synchronized
    fun stop() {
        task?.cancel(false)
        scheduler?.shutdownNow()
        task = null
        scheduler = null
    }

    private fun bearing(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Float {
        if (haversineM(aLat, aLon, bLat, bLon) < 0.5) return 0f
        val y = Math.sin(Math.toRadians(bLon - aLon)) * Math.cos(Math.toRadians(bLat))
        val x = Math.cos(Math.toRadians(aLat)) * Math.sin(Math.toRadians(bLat)) -
            Math.sin(Math.toRadians(aLat)) * Math.cos(Math.toRadians(bLat)) * Math.cos(Math.toRadians(bLon - aLon))
        return ((Math.toDegrees(Math.atan2(y, x)) + 360) % 360).toFloat()
    }
}
