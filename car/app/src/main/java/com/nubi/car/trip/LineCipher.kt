package com.nubi.car.trip

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** 파일의 한 줄을 암호화·복호화한다. 줄 하나가 깨져도 다른 줄은 읽을 수 있게 줄마다 독립적으로 처리한다. */
interface LineCipher {
    /** 개행이 없는 한 줄 문자열을 돌려준다. */
    fun encrypt(plain: String): String

    /** 복호화에 실패하면(키 변경·손상·평문 줄) null. */
    fun decrypt(line: String): String?
}

/**
 * AES-256-GCM. 줄마다 새 IV(12바이트)를 만들어 `base64(iv + 암호문+태그)`로 저장한다.
 * 키는 앱 프로세스 메모리에 있는 데이터 키(DEK)라 암호화에 IPC가 없다. DEK 자체는 [KeyWrapper]로 감싸 파일에 둔다.
 */
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

    companion object {
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128

        fun fromBytes(dek: ByteArray) = AesGcmCipher(SecretKeySpec(dek, "AES"))
    }
}

/** 데이터 키(DEK)를 감싸고 푼다. 실제 구현은 Android Keystore 키([KeystoreKeyWrapper]), 테스트는 소프트웨어 키. */
interface KeyWrapper {
    fun wrap(dek: ByteArray): ByteArray
    fun unwrap(blob: ByteArray): ByteArray
}

/**
 * [cipher]와, 그 키를 새로 만들어 옛 데이터를 읽을 수 없게 된 경우 폐기한 줄 수.
 * [persistent]가 false면 DEK를 파일에 못 남겨 이번 실행 동안만 쓰는 임시 키다(재시작 뒤에는 이번 실행의 큐를 읽을 수 없다).
 */
class CipherSetup(val cipher: LineCipher, val discardedLines: Int = 0, val persistent: Boolean = true)

/**
 * DEK 한 개를 [wrapper]로 감싸 [dir]/dek.bin에 둔다. 시작 때 unwrap 1회만 하고 이후 줄 암호화는 프로세스 안에서 한다.
 * unwrap이 실패하면(Keystore 키 소실·파일 손상) 새 DEK를 만들고, 옛 DEK로만 읽을 수 있던 데이터 파일은 폐기하며 그 줄 수를 돌려준다. 예외를 밖으로 내지 않는다.
 */
class DekCipherFactory(
    private val dir: File,
    private val wrapper: KeyWrapper,
    private val dataFiles: List<String> = listOf("queue.jsonl", "server-ids.jsonl", "dead-letter.jsonl", "vehicle-id.enc"),
) {
    fun setup(): CipherSetup {
        val dekFile = File(dir, DEK_FILE)
        readDek(dekFile)?.let { return CipherSetup(AesGcmCipher.fromBytes(it)) }
        Log.w(TAG, "DEK를 읽지 못해 새로 만든다(파일 있음=${dekFile.exists()})")
        val dek = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val cipher = AesGcmCipher.fromBytes(dek)
        val persisted = try {
            FileIo.writeAtomically(dekFile, Base64.getEncoder().encode(wrapper.wrap(dek)))
            true
        } catch (e: Throwable) {
            Log.w(TAG, "DEK 저장 실패, 이번 실행에만 쓰는 임시 키로 진행: ${e.javaClass.simpleName}")
            false
        }
        // 옛 DEK로 쓴 파일은 새 키로 읽을 수 없다. 줄 수만 세어 기록하고 지운다.
        var discarded = 0
        for (name in dataFiles) {
            val f = File(dir, name)
            if (!f.exists()) continue
            discarded += try {
                f.readLines().count { it.isNotBlank() }
            } catch (e: Exception) {
                0
            }
            f.delete()
        }
        if (discarded > 0) Log.w(TAG, "복호화할 수 없는 저장 데이터 폐기: ${discarded}줄")
        return CipherSetup(cipher, discarded, persisted)
    }

    private fun readDek(file: File): ByteArray? {
        if (!file.exists()) return null
        repeat(2) { attempt ->
            try {
                val dek = wrapper.unwrap(Base64.getDecoder().decode(file.readText().trim()))
                if (dek.size == 32) return dek
                return null
            } catch (e: Throwable) {
                Log.w(TAG, "DEK unwrap 실패(${attempt + 1}/2): ${e.javaClass.simpleName}")
            }
        }
        return null
    }

    private companion object {
        const val TAG = "NubiCipher"
        const val DEK_FILE = "dek.bin"
    }
}

/** Android Keystore의 AES-GCM 키(내보낼 수 없음)로 DEK를 감싼다. 줄마다 Keystore를 부르지 않고 시작 때 한 번만 쓴다. */
object KeystoreKeyWrapper : KeyWrapper {
    private const val PROVIDER = "AndroidKeyStore"
    private const val ALIAS = "nubi-trip-dek-wrap-v1"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12

    override fun wrap(dek: ByteArray): ByteArray {
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.ENCRYPT_MODE, loadOrCreateKey())
        return c.iv + c.doFinal(dek)
    }

    override fun unwrap(blob: ByteArray): ByteArray {
        val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
        val key = ks.getKey(ALIAS, null) as? SecretKey ?: throw IllegalStateException("wrap 키 없음")
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, blob, 0, IV_BYTES))
        return c.doFinal(blob, IV_BYTES, blob.size - IV_BYTES)
    }

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

/** 실제 앱의 암호화 준비. 워커 스레드에서 부른다(Keystore IPC가 한 번 일어난다). */
object KeystoreCipher {
    fun create(dir: File): CipherSetup = DekCipherFactory(dir, KeystoreKeyWrapper).setup()
}
