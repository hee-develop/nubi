package com.nubi.car.trip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class CipherTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun 줄_암호화는_Keystore_래퍼를_부르지_않고_unwrap은_시작_때_한_번이다() {
        val dir = tmp.newFolder()
        val wrapper = SoftwareKeyWrapper()
        val setup = DekCipherFactory(dir, wrapper).setup()
        assertEquals(0, wrapper.unwrapCalls) // 새로 만들 때는 unwrap 없음
        val lines = (0 until 2_000).map { setup.cipher.encrypt("line-$it") }
        assertEquals("line-1999", setup.cipher.decrypt(lines.last()))
        val again = DekCipherFactory(dir, wrapper).setup()
        assertEquals(1, wrapper.unwrapCalls) // 재시작해도 unwrap 1회
        assertEquals("line-0", again.cipher.decrypt(lines.first()))
        again.cipher.encrypt("x")
        again.cipher.encrypt("y")
        assertEquals(1, wrapper.unwrapCalls) // 줄마다 부르지 않는다
        assertTrue(setup.persistent)
        assertEquals(0, again.discardedLines)
    }

    @Test
    fun DEK_파일에는_평문_키가_없다() {
        val dir = tmp.newFolder()
        DekCipherFactory(dir, SoftwareKeyWrapper()).setup()
        val raw = File(dir, "dek.bin").readText().trim()
        assertEquals(60, java.util.Base64.getDecoder().decode(raw).size) // iv 12 + 키 32 + 태그 16
    }

    @Test
    fun 손상된_DEK는_새_키를_만들고_옛_파일의_줄_수를_폐기_개수로_돌려준다() {
        val dir = tmp.newFolder()
        val wrapper = SoftwareKeyWrapper()
        val old = DekCipherFactory(dir, wrapper).setup()
        TripQueue(File(dir, "queue.jsonl"), old.cipher).append(listOf(start("a"), start("b")))
        File(dir, "dek.bin").writeText("not-base64!!")
        val fresh = DekCipherFactory(dir, wrapper).setup()
        assertEquals(2, fresh.discardedLines)
        assertFalse(File(dir, "queue.jsonl").exists())
        assertNull(fresh.cipher.decrypt(old.cipher.encrypt("x")))
        assertEquals(0, DekCipherFactory(dir, wrapper).setup().discardedLines) // 새 DEK가 저장됐다
    }

    @Test
    fun wrap이_실패하면_임시_키로_진행하고_영속하지_않는다() {
        val dir = tmp.newFolder()
        val wrapper = SoftwareKeyWrapper().apply { failWrap = true }
        val setup = DekCipherFactory(dir, wrapper).setup()
        assertFalse(setup.persistent)
        assertFalse(File(dir, "dek.bin").exists())
        assertEquals("ok", setup.cipher.decrypt(setup.cipher.encrypt("ok")))
    }
}
