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
 * - 오디오 포커스는 `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`(USAGE_ASSISTANT·SPEECH)로 받고, 끝나거나 중단되면 반납한다. 포커스를 못 받으면 말하지 않는다.
 * - 선행 묵음(가이드 voice-guidance-preroll-silence): 포커스를 받은 뒤 [PREROLL_MS](200ms) 있다가 TTS를 시작한다. TTS SDK가 오디오 데이터를 주지 않아
 *   데이터 앞에 무음을 붙일 수 없어 **재생 지연 방식**으로 대신한다(가이드는 데이터 레벨을 권장한다. 한계는 사양 05d).
 * - 한 번에 한 문장. 말하는 중에 온 새 요청은 버린다. 상한 [CAP_MS] 안에 안 끝나면 멈추고 포커스를 반납한다.
 * - 초기화 실패·미지원·예외는 모두 삼킨다(아무 일도 하지 않는다). 초기화는 처음 말할 때 하고, 실패하면 [RETRY_INIT_MS] 뒤에야 다시 시도한다.
 * 로그에는 종류와 글자 수만 남긴다(문장은 남기지 않는다).
 */
class VoiceAdapter(context: Context, private val elapsedMs: () -> Long = { android.os.SystemClock.elapsedRealtime() }) : Speaker {
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
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setWillPauseWhenDucked(false)
        .setOnAudioFocusChangeListener(focusListener, main)
        .build()

    @Volatile
    private var tts: TextToSpeech? = null

    @Volatile
    private var ready = false
    private var initializing = false
    private var initFailedAt = Long.MIN_VALUE
    private var speaking = false
    private var token = 0
    private var pending: Pair<String, VoiceKind>? = null

    private val listener = object : EventListener {
        override fun onReady() = Unit
        override fun onStart() {
            Log.i(TAG, "TTS 시작")
        }

        override fun onUpdatedRms(rms: Double) = Unit
        override fun onDone() {
            main.post { finish("TTS 완료", cancel = false) }
        }

        override fun onStop() = Unit
        override fun onError(errorType: TtsErrorType) {
            Log.w(TAG, "TTS 오류 $errorType")
            main.post { finish("TTS 오류", cancel = true) }
        }
    }

    /** 어느 스레드에서 불러도 된다. 실제 일은 메인 스레드에서 한다. 말하기를 받아들였으면 true. */
    override fun speak(text: String, kind: VoiceKind): Boolean {
        if (audioManager == null) return false
        main.post { start(text, kind) }
        return true
    }

    private fun start(text: String, kind: VoiceKind) {
        try {
            if (speaking) {
                Log.i(TAG, "말하는 중이라 ${kind.code} 건너뜀")
                return
            }
            if (!ready) {
                pending = text to kind
                initialize()
                return
            }
            speakNow(text, kind)
        } catch (t: Throwable) {
            Log.w(TAG, "말하기 시작 예외: ${t.javaClass.simpleName}")
            finish("예외", cancel = true)
        }
    }

    private fun initialize() {
        if (initializing) return
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
                        if (tts !== engine) return@post
                        try {
                            engine.addEventListener(listener)
                        } catch (t: Throwable) {
                            Log.w(TAG, "TTS 리스너 등록 실패: ${t.javaClass.simpleName}")
                        }
                        ready = true
                        initializing = false
                        Log.i(TAG, "TTS 준비됨")
                        pending?.let { (t, k) ->
                            pending = null
                            start(t, k)
                        }
                    }
                }

                override fun onFailure(errorType: TtsErrorType) {
                    Log.w(TAG, "TTS 초기화 실패 $errorType")
                    main.post { initFailed() }
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

    private fun speakNow(text: String, kind: VoiceKind) {
        val am = audioManager ?: return
        val result = am.requestAudioFocus(focusRequest)
        Log.i(TAG, "TTS 요청 ${kind.code} 글자=${text.length}")
        if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            Log.i(TAG, "오디오 포커스 거절(MAY_DUCK): 말하지 않음")
            return
        }
        Log.i(TAG, "오디오 포커스 GRANTED(MAY_DUCK)")
        speaking = true
        val my = ++token
        // 선행 묵음 200ms 뒤 시작, 상한 안에 끝나지 않으면 멈춘다
        main.postDelayed({
            if (!speaking || my != token) return@postDelayed
            try {
                tts?.speak(text)
            } catch (t: Throwable) {
                Log.w(TAG, "speak 실패: ${t.javaClass.simpleName}")
                finish("speak 실패", cancel = true)
            }
        }, PREROLL_MS)
        main.postDelayed({
            if (speaking && my == token) finish("상한 시간", cancel = true)
        }, CAP_MS)
    }

    private fun finish(why: String, cancel: Boolean) {
        if (!speaking) return
        speaking = false
        token++
        if (cancel) runCatching { tts?.stop() }
        try {
            audioManager?.abandonAudioFocusRequest(focusRequest)
        } catch (t: Throwable) {
            Log.w(TAG, "포커스 반납 예외: ${t.javaClass.simpleName}")
        }
        Log.i(TAG, "오디오 포커스 반납($why)")
    }

    /** 화면·서비스가 끝날 때. 말하는 중이면 멈추고 SDK를 해제한다. */
    fun release() {
        main.post {
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
