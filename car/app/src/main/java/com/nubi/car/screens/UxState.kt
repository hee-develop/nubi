package com.nubi.car.screens

/**
 * 주행 규제(DO) 상태를 화면 밖(컨트롤러)이 읽도록 공유한다. 화면(MainActivity)이 규제 값을 받으면 갱신하고, 화면이 멈추면(onPause) true로 되돌린다.
 * 값을 모르면 DO로 본다(fail-closed).
 */
object UxState {
    @Volatile
    var distractionOptimized: Boolean = true

    /** 주행 규제 중 `UX_RESTRICTIONS_NO_SETUP` 비트(설정·입력 금지)가 켜져 있는지. 모르면 true(fail-closed). QR·설정·삭제 판정에 DO와 함께 쓴다. */
    @Volatile
    var setupBlocked: Boolean = true

    /** 화면을 열어도 되는 상태가 아닌지(DO 또는 설정 금지). */
    val blocked: Boolean get() = distractionOptimized || setupBlocked
}
