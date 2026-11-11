package com.nubi.car.map

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.time.Instant

const val CLS_MW = 0
const val CLS_PR = 1
const val CLS_SC = 2
const val CLS_MN = 3

/**
 * 바탕 도로 way 하나. 좌표는 **정규화 Web Mercator**(x·y 0~1, 북쪽이 y=0)로 읽어 두 배열에 나눠 담는다. 그릴 때마다 삼각함수를 안 쓰고 객체도 안 만들려는 것이다.
 * [drivenAtMs]가 0이면 그 차량이 인정받은 적 없는 길.
 */
class MapWay(
    val id: Long,
    val cls: Int,
    val mx: DoubleArray,
    val my: DoubleArray,
    val drivenAtMs: Long,
    val coverage: Double,
) {
    val minX = mx.min()
    val maxX = mx.max()
    val minY = my.min()
    val maxY = my.max()
    val driven: Boolean get() = drivenAtMs > 0L
}

/** 한 칸(서버 `/map/base` 응답 하나). [truncated]면 서버가 상한(8,000)에서 잘랐다. */
class BaseCell(val key: CellKey, val ways: List<MapWay>, val truncated: Boolean)

class LiveWay(val id: Long, val mx: DoubleArray, val my: DoubleArray, val isNew: Boolean) {
    val minX = mx.min()
    val maxX = mx.max()
    val minY = my.min()
    val maxY = my.max()
}

data class LiveRegion(val code: String, val displayName: String, val level: Int, val firstTime: Boolean)

/** `GET /trips/:id/live` 응답. [receivedAtMs]는 이 앱이 받은 시각(실시간 반영 지연 측정용). */
class LiveState(val status: String, val upToSeq: Int, val ways: List<LiveWay>, val region: LiveRegion?, val receivedAtMs: Long) {
    val newCount: Int get() = ways.count { it.isNew }

    companion object {
        val EMPTY = LiveState("idle", -1, emptyList(), null, 0L)
    }
}

/** 시군구 한 곳의 칠. 링(바깥·구멍)을 모두 한 목록에 두고 짝수-홀수 규칙으로 채운다. */
class RegionShape(
    val code: String,
    val name: String,
    val level: Int,
    val depop: Boolean,
    val faded: Boolean,
    val ringsX: List<DoubleArray>,
    val ringsY: List<DoubleArray>,
) {
    val minX = ringsX.minOfOrNull { it.min() } ?: 0.0
    val maxX = ringsX.maxOfOrNull { it.max() } ?: 0.0
    val minY = ringsY.minOfOrNull { it.min() } ?: 0.0
    val maxY = ringsY.maxOfOrNull { it.max() } ?: 0.0
}

class RegionCell(val key: RegionCellKey, val regions: List<RegionShape>)

class MapParseException(message: String) : Exception(message)

/** `[[lon,lat],…]`를 정규화 Mercator (x 배열, y 배열)로 읽는다. */
private fun coords(arr: JSONArray): Pair<DoubleArray, DoubleArray> {
    val n = arr.length()
    if (n < 2) throw MapParseException("좌표가 2개 미만")
    val xs = DoubleArray(n)
    val ys = DoubleArray(n)
    for (i in 0 until n) {
        val p = arr.getJSONArray(i)
        xs[i] = mercX(p.getDouble(0))
        ys[i] = mercY(p.getDouble(1))
    }
    return xs to ys
}

private fun clsOf(code: String): Int = when (code) {
    "mw" -> CLS_MW
    "pr" -> CLS_PR
    "sc" -> CLS_SC
    else -> CLS_MN
}

private fun isoMs(s: String): Long = try {
    Instant.parse(s).toEpochMilli()
} catch (e: Exception) {
    0L
}

private inline fun <T> parsing(what: String, block: () -> T): T = try {
    block()
} catch (e: JSONException) {
    throw MapParseException("응답 형식 오류 $what")
}

/** `GET /map/base` 응답을 [key] 칸으로 읽는다. 모양이 틀린 way는 건너뛰고, 응답 전체가 JSON이 아니면 [MapParseException]. */
fun parseBase(text: String, key: CellKey): BaseCell = parsing("map/base") {
    val o = JSONObject(text)
    val arr = o.getJSONArray("ways")
    val ways = ArrayList<MapWay>(arr.length())
    for (i in 0 until arr.length()) {
        try {
            val w = arr.getJSONObject(i)
            val (lon, lat) = coords(w.getJSONArray("c"))
            val d = w.optJSONObject("d")
            ways.add(MapWay(w.getLong("id"), clsOf(w.optString("cls")), lon, lat, d?.let { isoMs(it.optString("at")) } ?: 0L, d?.optDouble("cov", 0.0) ?: 0.0))
        } catch (e: JSONException) {
            // 모양이 틀린 way 하나 때문에 칸 전체를 버리지 않는다
        } catch (e: MapParseException) {
        }
    }
    BaseCell(key, ways, o.optBoolean("truncated", false))
}

/** `GET /trips/:id/live` 응답. */
fun parseLive(text: String, nowMs: Long): LiveState = parsing("trips/live") {
    val o = JSONObject(text)
    val arr = o.getJSONArray("ways")
    val ways = ArrayList<LiveWay>(arr.length())
    for (i in 0 until arr.length()) {
        try {
            val w = arr.getJSONObject(i)
            val (lon, lat) = coords(w.getJSONArray("c"))
            ways.add(LiveWay(w.getLong("id"), lon, lat, w.optBoolean("isNew", false)))
        } catch (e: JSONException) {
        } catch (e: MapParseException) {
        }
    }
    val r = o.optJSONObject("region")?.let { LiveRegion(it.getString("code"), it.getString("displayName"), it.optInt("level", 0), it.optBoolean("firstTime", false)) }
    LiveState(o.getString("status"), o.optInt("upToSeq", -1), ways, r, nowMs)
}

/** `GET /map/regions` 응답. */
fun parseRegions(text: String, key: RegionCellKey): RegionCell = parsing("map/regions") {
    val arr = JSONObject(text).getJSONArray("regions")
    val out = ArrayList<RegionShape>(arr.length())
    for (i in 0 until arr.length()) {
        try {
            val r = arr.getJSONObject(i)
            val lons = ArrayList<DoubleArray>()
            val lats = ArrayList<DoubleArray>()
            val polys = r.getJSONArray("p")
            for (pi in 0 until polys.length()) {
                val rings = polys.getJSONArray(pi)
                for (ri in 0 until rings.length()) {
                    val (lo, la) = coords(rings.getJSONArray(ri))
                    lons.add(lo)
                    lats.add(la)
                }
            }
            if (lons.isEmpty()) continue
            out.add(RegionShape(r.getString("code"), r.optString("name"), r.optInt("level", 0), r.optBoolean("depop", false), r.optBoolean("faded", false), lons, lats))
        } catch (e: JSONException) {
        } catch (e: MapParseException) {
        }
    }
    RegionCell(key, out)
}
