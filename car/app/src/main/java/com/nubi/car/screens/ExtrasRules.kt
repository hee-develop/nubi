package com.nubi.car.screens

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.nubi.car.trip.Gear
import com.nubi.car.trip.TripState
import com.nubi.car.trip.extrasVisible
import com.nubi.car.trip.numbersVisible

/** 정차 메뉴(탭)를 보일지: 플래그가 켜져 있고, 숫자를 보여도 되는 기어 P이며 주행 규제(DO)가 없을 때만. */
fun menuAllowed(flag: Boolean, gear: Gear?, state: TripState, distractionOptimized: Boolean): Boolean =
    flag && extrasVisible(numbersVisible(gear, state), distractionOptimized)

/** QR·코드를 보여도 되는지(plan 9-2). **기어가 P일 때만**(기어를 모르면 거부) 허용하고, P를 벗어나거나 DO가 걸리면 false라 바로 닫는다. [flag]는 guest/share 플래그. */
fun qrAllowed(flag: Boolean, gear: Gear?, state: TripState, distractionOptimized: Boolean): Boolean =
    gear == Gear.P && menuAllowed(flag, gear, state, distractionOptimized)

/** 코드 유효 시간(서버 `CODE_TTL_MS`, 5분). 남은 시간은 기기 단조 시계로 센다(서버·기기 시계 차이나 debug 시계에 흔들리지 않게). */
const val CODE_TTL_MS = 5 * 60_000L

fun remainingMs(receivedElapsedMs: Long, nowElapsedMs: Long, ttlMs: Long = CODE_TTL_MS): Long =
    (ttlMs - (nowElapsedMs - receivedElapsedMs)).coerceIn(0L, ttlMs)

/** `4:59` 꼴. 올림이라 5분을 받은 직후는 `5:00`이고 0이면 `0:00`. */
fun formatRemaining(ms: Long): String {
    val s = ((ms.coerceAtLeast(0) + 999) / 1000).toInt()
    return "%d:%02d".format(s / 60, s % 60)
}

/** QR 모듈 행렬(true = 어두운 칸). 인코딩이 안 되면(너무 길다 등) null. 여백(quiet zone) 2칸 포함. */
fun qrMatrix(text: String, quiet: Int = 2): Array<BooleanArray>? = try {
    val hints = mapOf(EncodeHintType.MARGIN to quiet, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.CHARACTER_SET to "UTF-8")
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints)
    Array(m.height) { y -> BooleanArray(m.width) { x -> m.get(x, y) } }
} catch (e: Exception) {
    null
}

/** 로드 상태가 있는 값 하나. */
class Slot<T> {
    enum class Status { EMPTY, LOADING, OK, FAILED }

    @Volatile
    var status = Status.EMPTY
        private set

    @Volatile
    var value: T? = null
        private set

    fun loading() {
        status = Status.LOADING
    }

    fun ok(v: T) {
        value = v
        status = Status.OK
    }

    fun failed() {
        status = Status.FAILED
    }

    fun clear() {
        value = null
        status = Status.EMPTY
    }
}
