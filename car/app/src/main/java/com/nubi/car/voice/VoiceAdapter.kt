package com.nubi.car.voice

import ai.pleos.playground.tts.TextToSpeech
import ai.pleos.playground.tts.listener.EventListener
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import ai.pleos.playground.tts.constant.ErrorType as TtsErrorType
import ai.pleos.playground.tts.constant.Mode as TtsMode
import ai.pleos.playground.tts.listener.OnInitializeListener as TtsInitializeListener

/**
 * Pleos TextToSpeech SDK로 한 문장을 말한다(차곡 VoiceAdapter를 따름).
 * - 오디오 포커스는 `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`으로 받고(usage는 `USAGE_ASSISTANCE_NAVIGATION_GUIDANCE`, 근거는 사양 05d), 끝·오류·상한·중단 때 반납한다. 포커스를 못 받으면 말하지 않는다.
 * - 선행 묵음(가이드 voice-guidance-preroll-silence): 포커스를 받은 뒤 [PREROLL_MS](200ms) 있다가 TTS를 시작한다. TTS SDK가 오디오 데이터를 주지 않아 데이터 앞에 무음을 붙일 수 없어 **재생 지연 방식**으로 대신한다.
 * - **재생 직전과 재생 중에 상황을 다시 확인한다**: 호출자가 준 `stillAllowed`(기어·플래그)가 false가 되면 즉시 멈추고 포커스를 반납한다([recheck]는 기어가 바뀔 때 부른다).
 * - 한 번에 한 문장([SpeechTurns]): 말하는 중에 온 새 요청은 버리고, 취소한 발화의 늦은 완료·오류 콜백은 새 발화를 끝내지 못한다. 상한 [CAP_MS] 안에 안 끝나면 멈춘다.
 * - [release]는 재생을 멈추고 포커스를 반납하고 SDK를 해제하며, [open] 전까지 새 재생과 포커스 요청을 막는다(서비스 onDestroy·onTaskRemoved).
 * - 초기화 실패·미지원·예외는 모두 삼킨다(아무 일도 하지 않는다). 초기화 실패 뒤 [RETRY_INIT_MS] 동안은 다시 시도하지 않는다. 로그에는 종류와 글자 수만 남긴다.
 */
class VoiceAdapter(context: Context, private val elapsedMs: () -> Long = { android.os.SystemClock.elapsedRealtime() }) : Speaker {
    private class Request(val text: String, val kind: VoiceKind, val stillAllowed: () -> Boolean, val onStarted: () -> Unit)

    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val audioManager: AudioManager? = try {
        appContext.getSystemService(AudioManager::class.java)
    } catch (t: Throwable) {
        null
    }

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                Log.i(TAG, "오디오 포커스 상실($change): 중단")
                finish("포커스 상실", cancel = true)
            }
            else -> Log.i(TAG, "오디오 포커스 변화($change)")
        }
    }

    private val focusRequest: AudioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setWillPauseWhenDucked(false)
        .setOnAudioFocusChangeListener(focusListener, main)
        .build()

    @Volatile
    private var tts: TextToSpeech? = null

    @Volatile
    private var closed = false
    private var ready = false
    private var initializing = false
    private var initFailedAt = Long.MIN_VALUE
    private val turns = SpeechTurns()
    private var current: Request? = null
    private var pending: Request? = null
    private var timerToken = 0

    private val listener = object : EventListener {
        override fun onReady() = Unit

        override fun onStart() {
            main.post {
                if (turns.onStarted()) Log.i(TAG, "TTS 시작")
            }
        }

        override fun onUpdatedRms(rms: Double) = Unit

        override fun onDone() {
            main.post {
                if (turns.onDone()) finish("TTS 완료", cancel = false) else Log.i(TAG, "지난 발화의 완료 콜백 무시")
            }
        }

        override fun onStop() = Unit

        override fun onError(errorType: TtsErrorType) {
            Log.w(TAG, "TTS 오류 $errorType")
            main.post {
                if (turns.onError()) finish("TTS 오류", cancel = true)
            }
        }
    }

    /** 어느 스레드에서 불러도 된다. 실제 일은 메인 스레드에서 한다. 받아들였으면 true(닫혔거나 오디오를 못 쓰면 false). */
    override fun speak(text: String, kind: VoiceKind, stillAllowed: () -> Boolean, onStarted: () -> Unit): Boolean {
        if (audioManager == null || closed) return false
        val r = Request(text, kind, stillAllowed, onStarted)
        main.post { start(r) }
        return true
    }

    /** 서비스가 (다시) 시작됐다: 새 재생을 받는다. */
    fun open() {
        main.post { closed = false }
    }

    /** 기어 등 상황이 바뀌었다: 말하는 중이고 더는 허용되지 않으면 즉시 멈춘다. */
    fun recheck() {
        main.post {
            val c = current ?: return@post
            if (turns.isActive && !safeAllowed(c)) finish("상황 변화", cancel = true)
        }
    }

    private fun safeAllowed(r: Request): Boolean = try {
        r.stillAllowed()
    } catch (t: Throwable) {
        false
    }

    private fun start(r: Request) {
        try {
            if (closed) return
            if (turns.isActive) {
                Log.i(TAG, "말하는 중이라 ${r.kind.code} 건너뜀")
                return
            }
            if (!ready) {
                pending = r
                initialize()
                return
            }
            speakNow(r)
        } catch (t: Throwable) {
            Log.w(TAG, "말하기 시작 예외: ${t.javaClass.simpleName}")
            finish("예외", cancel = true)
        }
    }

    private fun initialize() {
        if (initializing || closed) return
        val now = elapsedMs()
        if (initFailedAt != Long.MIN_VALUE && now - initFailedAt < RETRY_INIT_MS) {
            pending = null
            Log.i(TAG, "TTS 초기화 실패 직후라 건너뜀")
            return
        }
        initializing = true
        val engine = try {
            TextToSpeech(appContext, TtsMode.ON_DEVICE)
        } catch (t: Throwable) {
            Log.w(TAG, "TTS 생성 실패: ${t.javaClass.simpleName}")
            initFailed()
            return
        }
        tts = engine
        try {
            engine.initialize(object : TtsInitializeListener {
                override fun onSuccess() {
                    main.post {
                        if (tts !== engine || closed) return@post
                        try {
                            engine.addEventListener(listener)
                        } catch (t: Throwable) {
                            Log.w(TAG, "TTS 리스너 등록 실패: ${t.javaClass.simpleName}")
                        }
                        ready = true
                        initializing = false
                        Log.i(TAG, "TTS 준비됨")
                        pending?.let {
                            pending = null
                            start(it)
                        }
                    }
                }

                override fun onFailure(errorType: TtsErrorType) {
                    Log.w(TAG, "TTS 초기화 실패 $errorType")
                    main.post { if (tts === engine) initFailed() }
                }
            })
        } catch (t: Throwable) {
            Log.w(TAG, "TTS 초기화 예외: ${t.javaClass.simpleName}")
            initFailed()
        }
    }

    private fun initFailed() {
        initializing = false
        ready = false
        pending = null
        initFailedAt = elapsedMs()
        runCatching { tts?.release() }
        tts = null
    }

    private fun speakNow(r: Request) {
        val am = audioManager ?: return
        // 요청한 뒤 초기화를 기다리는 사이 상황이 바뀌었을 수 있다: 포커스를 잡기 전에 다시 확인한다
        if (!safeAllowed(r)) {
            Log.i(TAG, "${r.kind.code} 상황이 바뀌어 말하지 않음")
            return
        }
        val result = am.requestAudioFocus(focusRequest)
        Log.i(TAG, "TTS 요청 ${r.kind.code} 글자=${r.text.length}")
        if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            Log.i(TAG, "오디오 포커스 거절(MAY_DUCK): 말하지 않음")
            return
        }
        Log.i(TAG, "오디오 포커스 GRANTED(MAY_DUCK)")
        turns.begin()
        current = r
        val my = ++timerToken
        // 선행 묵음 200ms 뒤 시작(그 직전에 상황을 다시 확인), 상한 안에 끝나지 않으면 멈춘다
        main.postDelayed({
            if (!turns.isActive || my != timerToken) return@postDelayed
            if (!safeAllowed(r)) {
                finish("재생 직전 상황 변화", cancel = true)
                return@postDelayed
            }
            try {
                tts?.speak(r.text)
                r.onStarted()
            } catch (t: Throwable) {
                Log.w(TAG, "speak 실패: ${t.javaClass.simpleName}")
                finish("speak 실패", cancel = true)
            }
        }, PREROLL_MS)
        main.postDelayed({
            if (turns.isActive && my == timerToken) finish("상한 시간", cancel = true)
        }, CAP_MS)
    }

    private fun finish(why: String, cancel: Boolean) {
        if (!turns.end()) return
        timerToken++
        current = null
        if (cancel) runCatching { tts?.stop() }
        try {
            audioManager?.abandonAudioFocusRequest(focusRequest)
        } catch (t: Throwable) {
            Log.w(TAG, "포커스 반납 예외: ${t.javaClass.simpleName}")
        }
        Log.i(TAG, "오디오 포커스 반납($why)")
    }

    /**
     * 서비스 onDestroy·onTaskRemoved: 재생 중단 → 포커스 반납 → SDK 해제 순서로 정리하고, [open] 전까지 새 재생·포커스 요청을 막는다.
     * 어느 스레드에서 불러도 된다(닫힘 표시는 즉시, 정리는 메인 스레드).
     */
    fun release() {
        closed = true
        main.post {
            pending = null
            finish("해제", cancel = true)
            runCatching { tts?.removeEventListener(listener) }
            runCatching { tts?.release() }
            tts = null
            ready = false
            initializing = false
        }
    }

    private companion object {
        const val TAG = "NubiVoice"
        const val PREROLL_MS = 200L
        const val CAP_MS = 8_000L
        const val RETRY_INIT_MS = 5 * 60_000L
    }
}
