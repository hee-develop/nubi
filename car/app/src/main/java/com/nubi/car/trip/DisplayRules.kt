package com.nubi.car.trip

/**
 * 주행 규제(DO) 중 문자열 제한. [maxLength]가 0 이하이거나 DO가 아니면 그대로.
 * 상태 문구([statusLine]=true)는 항상 보여야 하므로 제한 길이로 자른다. 그 밖의 줄은 숫자·이름이 중간에서 잘려 오해를 부르므로 **줄 전체를 숨긴다**(null).
 */
fun limitText(text: String, distractionOptimized: Boolean, maxLength: Int, statusLine: Boolean): String? {
    if (!distractionOptimized || maxLength <= 0 || text.length <= maxLength) return text
    return if (statusLine) text.take(maxLength) else null
}

/**
 * 줄 높이 [heights](우선순위 높은 순, 보이지 않을 줄은 0)의 합이 [available]을 넘으면 **뒤 순위부터** 접는다.
 * 우선순위: 상태 > 집계(새 도로) > 시군구 > 처음 지난 곳·이벤트 > 전국 > 샘플·거리. 첫 [pinned]줄(상태 문구)은 넘쳐도 접지 않는다.
 * 반환: 각 줄을 보일지.
 */
fun foldLines(heights: List<Int>, available: Int, pinned: Int = 0): List<Boolean> {
    val show = heights.map { it > 0 }.toMutableList()
    var total = heights.sum()
    var i = heights.lastIndex
    while (total > available && i >= pinned) {
        if (show[i]) {
            show[i] = false
            total -= heights[i]
        }
        i--
    }
    return show
}

/** 줄 안에서 강조색으로 칠할 구간([accentStart] 이상 [accentEnd] 미만). 없으면 둘 다 0. */
data class AccentText(val text: String, val accentStart: Int = 0, val accentEnd: Int = 0) {
    val hasAccent: Boolean get() = accentEnd > accentStart
}

/**
 * strings.xml 문구의 `{...}` 구간을 강조 구간으로 바꾼다(괄호는 화면 글자에서 빠진다). 짝이 안 맞으면 괄호를 건드리지 않는다.
 * 예: `새 도로 {12.4km}` → 글자 `새 도로 12.4km`, 강조 `12.4km`.
 */
fun parseAccent(marked: String): AccentText {
    val open = marked.indexOf('{')
    val close = marked.indexOf('}', open + 1)
    if (open < 0 || close < 0) return AccentText(marked)
    val text = marked.substring(0, open) + marked.substring(open + 1, close) + marked.substring(close + 1)
    return AccentText(text, open, close - 1)
}

/** 단계 점 표시: 안 감 ○○○ / 통과 ●○○ / 방문 ●●○ / 숙박 ●●●. 범위 밖 값은 0~3으로 맞춘다. */
fun stageDots(level: Int): String {
    val n = level.coerceIn(0, 3)
    return "●".repeat(n) + "○".repeat(3 - n)
}

/**
 * 정차 화면(03) 레이아웃을 쓸지. 숫자를 보여도 되는 기어 P(또는 기어 미지원+기록 중 아님)이거나,
 * 주행 규제가 없는 동안 사용자가 눌러야 하는 것(권한 요청·기록 재시작)이 있을 때다. 그 밖에는 주행 중(03b) 화면이다.
 */
fun usesParkedLayout(showNumbers: Boolean, distractionOptimized: Boolean, needsPermission: Boolean, serviceFailed: Boolean): Boolean =
    showNumbers || (!distractionOptimized && (needsPermission || serviceFailed))

/** 게스트 QR·이웃 카드·길안내 버튼 같은 부가 요소를 보일지: 숫자를 보여도 되고(기어 P) 주행 규제(DO)가 없을 때만. */
fun extrasVisible(showNumbers: Boolean, distractionOptimized: Boolean): Boolean = showNumbers && !distractionOptimized

/** 이웃 카드의 모습: 숨김 / 전체(예시 항목 카드 2개 + 길안내 2개) / 축약(이웃 이름 + 인구감소 태그 + 길안내 1개). */
enum class NeighborLayout { HIDDEN, FULL, COMPACT }

/**
 * 이웃 카드의 모습. 부가 요소가 허용되지 않으면([extrasVisible]=false) 숨기고, 앱 영역이 [fullMinWidthDp]보다 좁으면
 * (사용자가 두 앱을 나란히 열어 각 앱에 좁은 영역이 주어진 경우 등) 축약형으로 보인다. 너비를 모르면(0 이하) 전체로 본다.
 */
fun neighborLayout(extrasVisible: Boolean, widthDp: Int, fullMinWidthDp: Int): NeighborLayout = when {
    !extrasVisible -> NeighborLayout.HIDDEN
    widthDp in 1 until fullMinWidthDp -> NeighborLayout.COMPACT
    else -> NeighborLayout.FULL
}

/** 앱 영역이 좁아 세로로 쌓는 배치를 쓸지(이웃 카드가 없어도 왼쪽 열을 화면 너비에 맞춘다). 너비를 모르면 쓰지 않는다. */
fun narrowAppArea(widthDp: Int, fullMinWidthDp: Int): Boolean = widthDp in 1 until fullMinWidthDp

/**
 * 정차 지도 화면(오른쪽 패널·좁으면 아래 패널)의 이웃 카드 모습. 부가 요소가 허용되지 않으면 숨기고, 좁은 앱 영역이면 패널을 줄이려고 축약형,
 * 넓은 영역에서는 패널 너비가 카드 전체형이 들어갈 만큼([fullMinCardWidthDp])이면 전체형이다. 패널 너비를 모르면(0 이하) 전체로 본다.
 */
fun neighborLayoutInMap(extrasVisible: Boolean, narrow: Boolean, panelWidthDp: Int, fullMinCardWidthDp: Int): NeighborLayout = when {
    !extrasVisible -> NeighborLayout.HIDDEN
    narrow -> NeighborLayout.COMPACT
    panelWidthDp in 1 until fullMinCardWidthDp -> NeighborLayout.COMPACT
    else -> NeighborLayout.FULL
}

/** 정차 지도 화면에서 패널 글자를 줄이는 비율(패널이 앱 영역의 40%라 03 요소를 다 담으려고. 더 줄이면 글자가 작아 읽기 어렵다). */
const val PANEL_TEXT_SCALE = 0.85f
