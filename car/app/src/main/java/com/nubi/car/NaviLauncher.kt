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

    private inner class Pending(val route: RouteInfo, val onResult: (Boolean) -> Unit) {
        val timeout = Runnable { expire(this) }
    }

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
        var replaced: Pending? = null
        val ready: NaviHelper? = synchronized(lock) {
            if (helper != null && connected) {
                helper
            } else {
                replaced = pending
                val p = Pending(route, onResult)
                pending = p
                main.postDelayed(p.timeout, TIMEOUT_MS)
                null
            }
        }
        replaced?.let { old ->
            main.removeCallbacks(old.timeout)
            main.post { old.onResult(false) } // 새 요청이 앞 요청을 대신한다
        }
        if (ready != null) {
            send(ready, route, onResult)
            return
        }
        connect()
    }

    /** 화면이 멈출 때: 연결을 끊고 대기 중이던 요청은 결과 없이 버린다(멈춘 화면에 실패 문구를 남기지 않는다). */
    fun release() {
        val old = synchronized(lock) {
            val h = helper
            helper = null
            connected = false
            pending?.let { main.removeCallbacks(it.timeout) }
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
                    p?.let {
                        main.removeCallbacks(it.timeout)
                        send(h, it.route, it.onResult)
                    }
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
        p?.let {
            main.removeCallbacks(it.timeout)
            main.post { it.onResult(false) }
        }
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

    /** 제한 시간 안에 연결되지 않았다: 요청을 실패로 알리고, 아직 연결 중인 helper는 정리해 다음 누름에서 새로 연결한다. */
    private fun expire(p: Pending) {
        val stale = synchronized(lock) {
            if (pending !== p) return
            pending = null
            if (connected) {
                null
            } else {
                helper.also {
                    helper = null
                }
            }
        }
        stale?.let { runCatching { it.release() } }
        p.onResult(false)
    }

    private companion object {
        const val TAG = "NubiNavi"
        const val TIMEOUT_MS = 3_000L
    }
}
