package com.nubi.car

import ai.pleos.playground.navi.constants.RouteOption
import ai.pleos.playground.navi.data.RouteInfo
import ai.pleos.playground.navi.helper.NaviHelper
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * NaviHelper로 길안내(requestRoute)를 **요청만** 한다. 앱은 지도를 그리지 않고 경로는 순정 내비가 안내한다.
 * 버튼을 처음 누를 때 연결하고(연결 전 요청은 대기), [TIMEOUT_MS] 안에 보내지 못하면 실패로 알린다. 결과는 메인 스레드로 알린다.
 * 목적지 이름·좌표는 위치 정보라 로그에 남기지 않는다.
 */
class NaviLauncher(context: Context) {
    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()
    private var helper: NaviHelper? = null
    private var connected = false

    /** 연결 전에 들어온 요청 하나(마지막 것만 유지한다). */
    private var pending: Pending? = null

    private class Pending(val route: RouteInfo, val onResult: (Boolean) -> Unit)

    fun request(name: String, lat: Double, lon: Double, onResult: (Boolean) -> Unit) {
        val route = RouteInfo(
            latitude = lat,
            longitude = lon,
            poiName = name,
            poiId = "",
            address = "",
            poiSubId = "",
            routeOption = RouteOption.RECOMMENDED,
        )
        val ready: NaviHelper? = synchronized(lock) {
            if (helper != null && connected) {
                helper
            } else {
                pending?.let { old -> main.post { old.onResult(false) } } // 새 요청이 앞 요청을 대신한다
                pending = Pending(route, onResult)
                null
            }
        }
        if (ready != null) {
            send(ready, route, onResult)
            return
        }
        connect()
        main.postDelayed({ expire(onResult) }, TIMEOUT_MS)
    }

    fun release() {
        val old = synchronized(lock) {
            val h = helper
            helper = null
            connected = false
            pending?.let { p -> main.post { p.onResult(false) } }
            pending = null
            h
        }
        old?.let { runCatching { it.release() } }
    }

    private fun connect() {
        val h = synchronized(lock) {
            if (helper != null) return
            NaviHelper(appContext).also { helper = it }
        }
        try {
            h.initialize(
                onConnected = {
                    val p = synchronized(lock) {
                        if (helper !== h) return@initialize
                        connected = true
                        pending.also { pending = null }
                    }
                    p?.let { send(h, it.route, it.onResult) }
                },
                onFailed = {
                    Log.w(TAG, "내비 연결 실패: ${it?.javaClass?.simpleName}")
                    fail(h)
                },
            )
        } catch (e: Exception) {
            Log.w(TAG, "내비 초기화 실패: ${e.javaClass.simpleName}")
            fail(h)
        }
    }

    /** 연결에 실패한 helper를 버리고(다음 누름에서 다시 연결) 기다리던 요청을 실패로 알린다. */
    private fun fail(h: NaviHelper) {
        val p = synchronized(lock) {
            if (helper !== h) return
            helper = null
            connected = false
            pending.also { pending = null }
        }
        runCatching { h.release() }
        p?.let { main.post { it.onResult(false) } }
    }

    private fun send(h: NaviHelper, route: RouteInfo, onResult: (Boolean) -> Unit) {
        val ok = try {
            h.requestRoute(route)
            true
        } catch (e: Exception) {
            Log.w(TAG, "requestRoute 실패: ${e.javaClass.simpleName}")
            false
        }
        main.post { onResult(ok) }
    }

    private fun expire(onResult: (Boolean) -> Unit) {
        val hit = synchronized(lock) {
            val p = pending
            if (p != null && p.onResult === onResult) {
                pending = null
                true
            } else {
                false
            }
        }
        if (hit) onResult(false)
    }

    private companion object {
        const val TAG = "NubiNavi"
        const val TIMEOUT_MS = 3_000L
    }
}
