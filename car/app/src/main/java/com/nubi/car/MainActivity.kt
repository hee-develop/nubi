package com.nubi.car

import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import com.nubi.car.trip.TripEngine
import com.nubi.car.trip.TripState

/** 글자 위주 상태 화면. 1초마다 한 번만 갱신한다. */
class MainActivity : Activity() {
    private lateinit var engine: TripEngine
    private lateinit var stateText: TextView
    private lateinit var samplesText: TextView
    private lateinit var distanceText: TextView
    private lateinit var uploadText: TextView
    private lateinit var permissionCard: LinearLayout
    private val handler = Handler(Looper.getMainLooper())

    private val refresh = object : Runnable {
        override fun run() {
            render()
            handler.postDelayed(this, 1_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        engine = TripEngine.get(this)
        setContentView(buildUi())
    }

    override fun onResume() {
        super.onResume()
        if (hasLocationPermission()) startService()
        render()
        handler.post(refresh)
    }

    override fun onPause() {
        handler.removeCallbacks(refresh)
        super.onPause()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_CODE) return
        if (hasLocationPermission()) startService()
        render()
    }

    private fun hasLocationPermission() = checkSelfPermission(FUSED_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun startService() {
        try {
            TripRecordingService.start(this)
        } catch (e: Exception) {
            Log.w("NubiMain", "서비스 시작 실패: ${e.message}")
        }
    }

    private fun requestPermissions() {
        // 속도(CAR_SPEED)는 거부돼도 기록은 계속된다. 같이 묻되 필수는 위치뿐이다.
        val wanted = listOf(FUSED_LOCATION, CAR_SPEED).filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        requestPermissions(wanted.toTypedArray(), REQUEST_CODE)
    }

    private fun render() {
        val needsPermission = !hasLocationPermission()
        permissionCard.visibility = if (needsPermission) View.VISIBLE else View.GONE
        val s = engine.status
        stateText.text = when {
            needsPermission -> getString(R.string.state_permission)
            s.state == TripState.IDLE -> getString(R.string.state_idle)
            s.state == TripState.RECORDING -> getString(R.string.state_recording)
            else -> getString(R.string.state_ended)
        }
        samplesText.text = getString(R.string.samples_format, s.sampleCount)
        distanceText.text = getString(R.string.distance_format, s.distanceM)
        uploadText.text = getString(R.string.upload_format, s.lastUpload)
    }

    private fun buildUi(): View {
        fun text(size: Float, bold: Boolean = false) = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
            setTextColor(Color.WHITE)
            if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
            setPadding(0, 12, 0, 12)
        }
        stateText = text(40f, bold = true)
        samplesText = text(24f)
        distanceText = text(24f)
        uploadText = text(18f)
        permissionCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#33FFFFFF"))
            setPadding(32, 24, 32, 24)
            addView(text(20f, bold = true).apply { text = getString(R.string.permission_title) })
            addView(text(18f).apply { text = getString(R.string.permission_body) })
            addView(Button(this@MainActivity).apply {
                text = getString(R.string.permission_confirm)
                setOnClickListener { requestPermissions() }
            })
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#14181F"))
            setPadding(48, 48, 48, 48)
            addView(stateText)
            addView(samplesText)
            addView(distanceText)
            addView(uploadText)
            addView(permissionCard, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 32 })
        }
    }

    private companion object {
        const val REQUEST_CODE = 1
        const val FUSED_LOCATION = "pleos.car.permission.FUSED_LOCATION"
        const val CAR_SPEED = "android.car.permission.CAR_SPEED"
    }
}
