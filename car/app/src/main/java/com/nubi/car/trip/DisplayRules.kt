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
