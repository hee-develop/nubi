package com.nubi.car.screens

/**
 * 주행 규제(DO) 상태를 화면 밖(컨트롤러)이 읽도록 공유한다. 화면(MainActivity)이 규제 값을 받으면 갱신하고, 화면이 멈추면(onPause) true로 되돌린다.
 * 값을 모르면 DO로 본다(fail-closed).
 */
object UxState {
    @Volatile
    var distractionOptimized: Boolean = true
}
