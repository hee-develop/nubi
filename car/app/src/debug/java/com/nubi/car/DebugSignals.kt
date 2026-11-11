package com.nubi.car

import android.content.Context
import android.util.Log
import com.nubi.car.trip.Gear
import com.nubi.car.trip.TripEngineProvider

/**
 * E2E용 가짜 신호를 엔진에 넣는다. 처리 순서는 아래와 같다.
 *
 * - `reset=1`: 상태기계·큐·시계·재생을 모두 비우고 실제 위치 수신을 끈다(이후 loc·gpx 주입만 받는다)
 * - `vin=<VIN>`: 차량 SDK 대신 이 VIN으로 서버 차량 ID를 받는다(에뮬레이터의 VIN은 서버 형식 검사에 걸려 등록이 400이라, `pm clear` 뒤에도 서버 발급 ID가 필요한 E2E용)
 * - `real=1`: 실제 위치 수신을 다시 켠다
 * - `gear`: P·R·N·D
 * - `loc=<lat>,<lon>[,<headingDeg>]`: 위치 샘플 1개(시각은 현재 시계). 실제 위치 콜백은 이때부터 무시한다
 * - `gpx=<assets 파일명>`: car/app/src/debug/assets 의 GPX를 1초 간격으로 재생한다. 실제 위치 콜백은 이때부터 무시한다
 * - `park=1`: gpx 재생이 끝나면 기어를 P로 바꾼다(숫자는 기어 P에서만 보이므로 재생 끝을 화면으로 알 수 있게 한다)
 * - `now=<epoch ms>`: 시계를 그 시각으로 옮기고 바로 종료 조건(P 5분)을 확인한다(기어 처리 뒤에 적용)
 * - `flush=1`: 큐를 바로 업로드한다(재시도 대기 무시)
 * - `queue=1`: 업로드 큐에 남은 항목 수를 로그로 남긴다(`NubiDebug: 큐 pendingEntries=N`, E2E가 삭제 뒤 큐가 비었는지 확인한다)
 *
 * 순서는 reset → vin → real → gear → loc → gpx → now → flush다. 속도는 수집하지 않으므로 주입하지 않는다.
 */
object DebugSignals {
    private const val TAG = "NubiDebug"

    fun apply(context: Context, value: (String) -> String?) {
        val engine = TripEngineProvider.get(context)
        if (value("reset") == "1") {
            GpxPlayer.stop()
            engine.reset()
            TripEngineProvider.coverage(context).clear()
            TripEngineProvider.place(context).clear()
            TripEngineProvider.summary(context).onTripStarted()
            TripEngineProvider.intro(context).clear()
        }
        value("vin")?.let { TripEngineProvider.vehicleIdResolver(context).onVin(it) }
        if (value("real") == "1") engine.setRealLocationAccepted(true)
        value("gear")?.let { engine.onGear(gearOf(it)) }
        value("loc")?.let {
            val p = it.split(",").map(String::toDouble)
            require(p.size >= 2) { "loc=<lat>,<lon>[,<headingDeg>]: $it" }
            engine.setRealLocationAccepted(false)
            engine.onLocation(p[0], p[1], p.getOrNull(2)?.toFloat(), null)
        }
        value("gpx")?.let {
            engine.setRealLocationAccepted(false)
            GpxPlayer.play(context, engine, it, parkAtEnd = value("park") == "1")
        }
        value("now")?.let { engine.setClock(it.toLong()) }
        if (value("flush") == "1") engine.flush()
        if (value("queue") == "1") Log.i(TAG, "큐 pendingEntries=${engine.pendingEntries}")
        Log.i(TAG, "주입 완료")
    }

    private fun gearOf(name: String) = when (name.uppercase()) {
        "P" -> Gear.P
        "R" -> Gear.R
        "N" -> Gear.N
        "D" -> Gear.D
        else -> error("알 수 없는 기어: $name")
    }
}
