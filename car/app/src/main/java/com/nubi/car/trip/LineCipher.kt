package com.nubi.car.trip

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** 파일의 한 줄을 암호화·복호화한다. 줄 하나가 깨져도 다른 줄은 읽을 수 있게 줄마다 독립적으로 처리한다. */
interface LineCipher {
    /** 개행이 없는 한 줄 문자열을 돌려준다. */
    fun encrypt(plain: String): String

    /** 복호화에 실패하면(키 변경·손상·평문 줄) null. */
    fun decrypt(line: String): String?
}

/** AES-256-GCM. 줄마다 새 IV(12바이트)를 만들어 `base64(iv + 암호문+태그)`로 저장한다. */
class AesGcmCipher(private val key: SecretKey) : LineCipher {
    override fun encrypt(plain: String): String {
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.ENCRYPT_MODE, key)
        val iv = c.iv
        val body = c.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.getEncoder().encodeToString(iv + body)
    }

    override fun decrypt(line: String): String? = try {
        val raw = Base64.getDecoder().decode(line.trim())
        if (raw.size <= IV_BYTES) {
            null
        } else {
            val c = Cipher.getInstance(TRANSFORMATION)
            c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, raw, 0, IV_BYTES))
            String(c.doFinal(raw, IV_BYTES, raw.size - IV_BYTES), Charsets.UTF_8)
        }
    } catch (e: Exception) {
        null
    }

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}

/**
 * Android Keystore의 AES-GCM 키로 큐·dead-letter·server-ids 파일을 줄 단위로 암호화한다.
 * Jetpack Security(EncryptedFile)는 deprecated라 Keystore를 직접 쓴다. 키는 기기 밖으로 나오지 않는다.
 */
object KeystoreCipher {
    private const val PROVIDER = "AndroidKeyStore"
    private const val ALIAS = "nubi-trip-queue-v1"

    fun create(): LineCipher = AesGcmCipher(loadOrCreateKey())

    private fun loadOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }
}
