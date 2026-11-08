package com.nubi.car

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

/** 누비 차량 앱의 빈 시작 화면. 기능은 아직 없다. */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply { text = getString(R.string.app_name) })
    }
}
