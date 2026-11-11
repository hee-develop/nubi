package com.nubi.car.trip

/**
 * 차량 토큰(`POST /vehicles/register`의 `vehicleToken`, 서버가 `NUBI_AUTH`≠off일 때만 준다) 보관소. 토큰은 메모리에 두고(디스크 저장은 [VehicleIdResolver]가 암호화해서 한다)
 * 모든 API 호출이 [getText]·[postJson] 등 공용 HTTP 함수에서 `Authorization: Bearer`로 붙인다. 로그에는 남기지 않는다.
 *
 * 401·403을 받으면 [onUnauthorized]가 재등록을 **1회** 시도한다(응답 코드 분류와 업로드 큐는 건드리지 않는다: 큐는 버려지지 않고 백오프 뒤 다시 올라간다).
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

    /** 토큰을 실은 요청이 2xx를 받았다. */
    fun onAuthorized() {
        failed = false
        reregistered = false
    }

    /** 재등록을 이미 한 번 해 봤는지(다음 성공 응답 전까지 다시 하지 않는다). */
    @Volatile
    var reregistered = false

    fun reset() {
        token = null
        failed = false
        reregistered = false
    }
}
