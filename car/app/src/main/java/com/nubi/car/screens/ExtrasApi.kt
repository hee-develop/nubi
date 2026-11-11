package com.nubi.car.screens

import com.nubi.car.trip.HttpFailure
import com.nubi.car.trip.deleteRequest
import com.nubi.car.trip.getText
import com.nubi.car.trip.postJson
import com.nubi.car.trip.putJson
import org.json.JSONObject
import java.net.URLEncoder
import java.util.Locale

/** T4 부가 기능이 쓰는 서버 API(계약서 05 3장 T2 소유 경로). 모든 호출은 워커 스레드에서만 부른다. 토큰은 공용 HTTP 함수가 붙인다. */
interface ExtrasApi {
    fun getSettings(vehicleId: String): ServerSettings

    /** 부분 갱신. [patch]에 든 항목만 바뀐다. */
    fun putSettings(vehicleId: String, patch: JSONObject): ServerSettings

    /** 트립·점·커버리지·지역 기록을 모두 지우고 위치정보 동의를 철회한다. */
    fun deleteData(vehicleId: String)

    fun regionsList(vehicleId: String): List<DexItem>
    fun roads(vehicleId: String, almostOnly: Boolean, limit: Int): List<RoadItem>
    fun dailyReport(vehicleId: String, date: String): Report
    fun monthlyReport(vehicleId: String, month: String): Report

    /** 게스트 QR용 코드(P일 때만 서버가 낸다). */
    fun guestCode(vehicleId: String): CodeInfo
    fun guestSessions(vehicleId: String): Int
    fun guestEndAll(vehicleId: String): Int
    fun pairCode(vehicleId: String): CodeInfo

    /** 전국 공유 카드를 만들고 링크를 돌려준다. */
    fun shareNational(vehicleId: String): String

    /** 지역 소개. [lat]·[lon]은 그 시군구 안의 현재 위치(길안내 거리 정렬용). */
    fun intro(code: String, lat: Double, lon: Double): Intro
}

class HttpExtrasApi(private val baseUrl: String) : ExtrasApi {
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    override fun getSettings(vehicleId: String) = parseSettings(getText(baseUrl, "/vehicles/${enc(vehicleId)}/settings"))

    override fun putSettings(vehicleId: String, patch: JSONObject) = parseSettings(putJson(baseUrl, "/vehicles/${enc(vehicleId)}/settings", patch))

    override fun deleteData(vehicleId: String) {
        deleteRequest(baseUrl, "/vehicles/${enc(vehicleId)}/data")
    }

    override fun regionsList(vehicleId: String) = parseDex(getText(baseUrl, "/regions/list?vehicleId=${enc(vehicleId)}&sort=name"))

    override fun roads(vehicleId: String, almostOnly: Boolean, limit: Int) =
        parseRoads(getText(baseUrl, "/coverage/roads?vehicleId=${enc(vehicleId)}&limit=$limit&sort=percent" + if (almostOnly) "&filter=almost" else ""))

    override fun dailyReport(vehicleId: String, date: String) = parseReport(getText(baseUrl, "/reports/daily?vehicleId=${enc(vehicleId)}&date=$date"))

    override fun monthlyReport(vehicleId: String, month: String) = parseReport(getText(baseUrl, "/reports/monthly?vehicleId=${enc(vehicleId)}&month=$month"))

    override fun guestCode(vehicleId: String) = parseCode(postJson(baseUrl, "/guest/code", JSONObject().put("vehicleId", vehicleId).put("gear", "P")))

    override fun guestSessions(vehicleId: String): Int =
        try {
            JSONObject(getText(baseUrl, "/guest/sessions?vehicleId=${enc(vehicleId)}")).getInt("active")
        } catch (e: HttpFailure) {
            throw e
        } catch (e: Exception) {
            throw java.io.IOException("응답 형식 오류 guest/sessions")
        }

    override fun guestEndAll(vehicleId: String): Int =
        try {
            JSONObject(postJson(baseUrl, "/guest/end-all", JSONObject().put("vehicleId", vehicleId))).optInt("ended", 0)
        } catch (e: HttpFailure) {
            throw e
        } catch (e: Exception) {
            throw java.io.IOException("응답 형식 오류 guest/end-all")
        }

    override fun pairCode(vehicleId: String) = parseCode(postJson(baseUrl, "/pair/code", JSONObject().put("vehicleId", vehicleId).put("gear", "P")))

    override fun shareNational(vehicleId: String) = parseShareUrl(postJson(baseUrl, "/share/cards", JSONObject().put("vehicleId", vehicleId).put("kind", "national")))

    override fun intro(code: String, lat: Double, lon: Double) =
        parseIntro(getText(baseUrl, String.format(Locale.US, "/regions/%s/intro?lat=%.5f&lon=%.5f", enc(code), lat, lon)))
}
