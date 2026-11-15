package com.nubi.car

/**
 * 차량 기능 플래그(계약서 05 4장). 아침에 기능을 빼려면 **기본값만 바꾸면** 된다. 서버 설정이 오면 덮어쓴다(T4가 연결).
 * 값은 앱 시작 때 한 번 정해지고 화면은 그때그때 읽는다.
 */
object FeatureFlags {
    // 아래 var의 초기값이 '빌드 기본값'이다. 서버·사용자 설정은 끌 수만 있고(AND), 빌드 기본값이 false면 켤 수 없다([applyServerDrivingMap]·[applyVoicePref]).

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

    private val drivingMapDefault = drivingMap
    private val voiceDefault = voice

    /** 서버 설정 `drivingMap`이 오면 반영한다. 빌드 기본값이 꺼져 있으면 서버가 켜도 켜지지 않는다. */
    fun applyServerDrivingMap(serverValue: Boolean) {
        drivingMap = drivingMapDefault && serverValue
    }

    /** 사용자가 설정에서 고른 음성 켜기·끄기(기기에 저장). 빌드 기본값이 꺼져 있으면 켜지지 않는다. */
    fun applyVoicePref(userValue: Boolean) {
        voice = voiceDefault && userValue
    }
}
