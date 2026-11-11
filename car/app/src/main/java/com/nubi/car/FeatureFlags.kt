package com.nubi.car

/**
 * 차량 기능 플래그(계약서 05 4장). 아침에 기능을 빼려면 **기본값만 바꾸면** 된다. 서버 설정이 오면 덮어쓴다(T4가 연결).
 * 값은 앱 시작 때 한 번 정해지고 화면은 그때그때 읽는다.
 */
object FeatureFlags {
    /** 주행 중 지도 화면(D·R·N)과 정차 지도+패널. false면 기존 03·03b 화면. */
    @Volatile
    var drivingMap: Boolean = true

    /** 주행 중 잠정 새 도로 색칠(서버 `/trips/:id/live` 폴링과 업로드 주기 20초). false면 로컬 궤적만 그린다. */
    @Volatile
    var liveColoring: Boolean = true

    /** 음성 안내(T4). */
    @Volatile
    var voice: Boolean = true

    /** 정차 메뉴(T4). */
    @Volatile
    var parkedMenu: Boolean = true

    /** 게스트 모드(T4). */
    @Volatile
    var guest: Boolean = true

    /** 공유 카드(T4). */
    @Volatile
    var share: Boolean = true

    /** 지역 소개 카드(T4). */
    @Volatile
    var intro: Boolean = true
}
