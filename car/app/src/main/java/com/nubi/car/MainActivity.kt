package com.nubi.car

import android.app.Activity
import android.car.Car
import android.car.drivingstate.CarUxRestrictions
import android.car.drivingstate.CarUxRestrictionsManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import com.nubi.car.trip.TripEngine
import com.nubi.car.trip.TripEngineProvider
import com.nubi.car.trip.TripState
import com.nubi.car.trip.UploadKind

/**
 * 글자 위주 상태 화면. 1초마다 한 번만 갱신한다.
 * 주행 규제(DO)가 걸리면 권한 카드·버튼을 숨기고 문자열을 규제 길이로 자른다.
 */
class MainActivity : Activity() {
    private lateinit var engine: TripEngine
    private lateinit var stateText: TextView
    private lateinit var samplesText: TextView
    private lateinit var distanceText: TextView
    private lateinit var uploadText: TextView
    private lateinit var permissionCard: LinearLayout
    private lateinit var permissionConfirm: Button
    private lateinit var permissionSettings: Button
    private val handler = Handler(Looper.getMainLooper())

    private var car: Car? = null
    private var uxManager: CarUxRestrictionsManager? = null

    /** DO가 요구되는 동안 true. 이때 권한 카드·버튼은 숨기고 문자열은 [maxStringLength]로 자른다. */
    private var distractionOptimized = false
    private var maxStringLength = 0

    /** 요청 뒤에도 거부됐고 시스템이 더는 묻지 않는 상태(영구 거부). 이때 '설정 열기'를 보인다. */
    private var permanentlyDenied = false

    private val uxListener = CarUxRestrictionsManager.OnUxRestrictionsChangedListener { restrictions ->
        handler.post {
            applyRestrictions(restrictions)
            render()
        }
    }

    private val refresh = object : Runnable {
        override fun run() {
            render()
            handler.postDelayed(this, 1_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        engine = TripEngineProvider.get(this)
        setContentView(buildUi())
    }

    override fun onResume() {
        super.onResume()
        registerUxRestrictions()
        if (hasLocationPermission()) startService()
        render()
        handler.post(refresh)
    }

    override fun onPause() {
        handler.removeCallbacks(refresh)
        unregisterUxRestrictions()
        super.onPause()
    }

    /** 최상위 화면에서 Back은 앱을 닫지 않고 뒤로 보낸다(포그라운드 서비스는 계속 돈다). */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        moveTaskToBack(true)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_CODE) return
        if (hasLocationPermission()) {
            permanentlyDenied = false
            startService()
        } else {
            // 시스템 다이얼로그가 안 뜨고 거부됐고 설명 UI도 안 보여 주는 상태면 영구 거부로 본다.
            permanentlyDenied = REQUIRED.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
                .none { shouldShowRequestPermissionRationale(it) }
        }
        render()
    }

    private fun hasLocationPermission() = REQUIRED.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    private fun startService() {
        try {
            TripRecordingService.start(this)
        } catch (e: Exception) {
            Log.w("NubiMain", "서비스 시작 실패: ${e.message}")
        }
    }

    private fun requestPermissions() {
        val wanted = REQUIRED.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        requestPermissions(wanted.toTypedArray(), REQUEST_CODE)
    }

    private fun openAppSettings() {
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            Log.w("NubiMain", "설정 화면 열기 실패: ${e.message}")
        }
    }

    // 주행 규제 ---------------------------------------------------------------

    private fun registerUxRestrictions() {
        try {
            val c = Car.createCar(this) ?: return
            car = c
            val manager = c.getCarManager(Car.CAR_UX_RESTRICTION_SERVICE) as? CarUxRestrictionsManager ?: return
            uxManager = manager
            manager.registerListener(uxListener)
            manager.currentCarUxRestrictions?.let { applyRestrictions(it) }
        } catch (e: Throwable) {
            Log.w("NubiMain", "주행 규제 등록 실패: ${e.javaClass.simpleName} ${e.message}")
        }
    }

    private fun unregisterUxRestrictions() {
        try {
            uxManager?.unregisterListener()
            car?.disconnect()
        } catch (e: Throwable) {
            Log.w("NubiMain", "주행 규제 해제 실패: ${e.javaClass.simpleName} ${e.message}")
        }
        uxManager = null
        car = null
    }

    private fun applyRestrictions(r: CarUxRestrictions) {
        distractionOptimized = r.isRequiresDistractionOptimization
        maxStringLength = r.maxRestrictedStringLength
    }

    /** DO 중에는 규제 길이를 넘는 문자열을 자른다. */
    private fun limited(text: String): String =
        if (distractionOptimized && maxStringLength > 0 && text.length > maxStringLength) text.take(maxStringLength) else text

    // 그리기 ------------------------------------------------------------------

    private fun render() {
        val needsPermission = !hasLocationPermission()
        permissionCard.visibility = if (needsPermission && !distractionOptimized) View.VISIBLE else View.GONE
        permissionConfirm.visibility = if (permanentlyDenied) View.GONE else View.VISIBLE
        permissionSettings.visibility = if (permanentlyDenied) View.VISIBLE else View.GONE
        val s = engine.status
        stateText.text = limited(
            when {
                needsPermission -> getString(R.string.state_permission)
                s.state == TripState.IDLE -> getString(R.string.state_idle)
                s.state == TripState.RECORDING -> getString(R.string.state_recording)
                else -> getString(R.string.state_ended)
            },
        )
        samplesText.text = limited(getString(R.string.samples_format, s.sampleCount))
        distanceText.text = limited(getString(R.string.distance_format, s.distanceM))
        val upload = when (s.upload.kind) {
            UploadKind.NONE -> getString(R.string.upload_none)
            UploadKind.OK -> getString(R.string.upload_ok, s.upload.points)
            UploadKind.FAILED -> getString(R.string.upload_failed)
            UploadKind.HELD -> getString(R.string.upload_held)
        }
        // 보류는 사용자가 알아야 하므로 '마지막 업로드:' 접두 없이 그대로 보인다.
        uploadText.text = limited(if (s.upload.kind == UploadKind.HELD) upload else getString(R.string.upload_format, upload))
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
        permissionConfirm = Button(this).apply {
            text = getString(R.string.permission_confirm)
            setOnClickListener { requestPermissions() }
        }
        permissionSettings = Button(this).apply {
            text = getString(R.string.permission_open_settings)
            setOnClickListener { openAppSettings() }
        }
        permissionCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#33FFFFFF"))
            setPadding(32, 24, 32, 24)
            addView(text(20f, bold = true).apply { text = getString(R.string.permission_title) })
            addView(text(18f).apply { text = getString(R.string.permission_body) })
            addView(permissionConfirm)
            addView(permissionSettings)
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
        const val COARSE = "android.permission.ACCESS_COARSE_LOCATION"
        val REQUIRED = listOf(FUSED_LOCATION, COARSE)
    }
}
