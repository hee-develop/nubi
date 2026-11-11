package com.nubi.car.trip

import java.util.concurrent.atomic.AtomicInteger

/**
 * 차량 토큰(`POST /vehicles/register`의 `vehicleToken`, 서버가 `NUBI_AUTH`≠off일 때만 준다) 보관소. 토큰은 메모리에 두고(디스크 저장은 [VehicleIdResolver]가 암호화해서 한다)
 * 모든 API 호출이 [getText]·[postJson] 등 공용 HTTP 함수에서 `Authorization: Bearer`로 붙인다. 로그에는 남기지 않는다.
 *
 * 401(또는 403 `unauthorized`)을 받으면 [onUnauthorized]가 재등록을 **1회** 시도한다(응답 코드 분류와 업로드 큐는 건드리지 않는다: 큐는 버려지지 않고 백오프 뒤 다시 올라간다).
 * 재등록이 실패했거나 재등록 뒤에도 거절되면 [failed]가 true가 되어 화면이 상태 문구를 보인다. 인증이 필요한 요청이 성공하면 풀린다.
 */
object Auth {
    @Volatile
    var token: String? = null

    /** 재등록까지 해 봤지만 서버가 계속 거절한다. */
    @Volatile
    var failed: Boolean = false

    /** 401·403을 받았을 때(HTTP 호출 스레드에서 불린다. 오래 걸리는 일은 넘겨 받는 쪽이 따로 돌려야 한다). */
    @Volatile
    var onUnauthorized: () -> Unit = {}

    /** 요청이 2xx를 받았다(토큰이 없는 모드 포함). 인증 실패 상태와 재등록 기록을 푼다. */
    fun onAuthorized() {
        failed = false
        reregState.set(IDLE)
    }

    private val reregState = AtomicInteger(IDLE)

    /**
     * 재등록을 시작해도 되는지(원자적). 처음이면 true(진행 중으로 표시), 이미 진행 중이면 false(결과를 기다린다), 이미 한 번 해 봤는데 또 거절됐으면 false이고 [failed]를 켠다.
     * 다음 성공 응답([onAuthorized]) 전까지 두 번째 재등록은 하지 않는다.
     */
    fun beginReregister(): Boolean {
        if (reregState.compareAndSet(IDLE, RUNNING)) return true
        if (reregState.get() == DONE) failed = true
        return false
    }

    /** 재등록이 끝났다. 실패면 [failed]를 켠다(성공해도 새 토큰으로 요청이 성공하기 전까지는 DONE이라 다시 거절되면 실패로 본다). */
    fun finishReregister(ok: Boolean) {
        if (!ok) failed = true
        reregState.set(DONE)
    }

    fun reset() {
        token = null
        failed = false
        reregState.set(IDLE)
    }

    private const val IDLE = 0
    private const val RUNNING = 1
    private const val DONE = 2
}
