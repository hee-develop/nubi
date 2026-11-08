package com.nubi.car

import android.app.Activity
import android.os.Bundle
import android.util.Log

/**
 * 화면 없이 신호만 주입하고 바로 닫힌다. 주소의 쿼리(`nubi-debug://signal?gear=D`)나 intent extra로 값을 준다.
 * 처리 순서와 키는 [DebugSignals]에 있다.
 */
class SignalInjectActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent.data
        try {
            DebugSignals.apply(applicationContext) { key -> uri?.getQueryParameter(key) ?: intent.getStringExtra(key) }
        } catch (e: RuntimeException) {
            Log.w("NubiDebug", "신호 주입 실패: $uri", e)
        }
        finish()
    }
}
