package com.nubi.car.trip

import com.nubi.car.BuildConfig
import java.util.Locale

/** 위경도는 debug 빌드에서만, 소수점 2자리(약 1km)로 뭉개 로그에 남긴다. release에는 좌표를 남기지 않는다. */
fun coordForLog(lat: Double, lon: Double): String =
    if (BuildConfig.DEBUG) String.format(Locale.ROOT, "lat=%.2f lon=%.2f", lat, lon) else "좌표 생략"
