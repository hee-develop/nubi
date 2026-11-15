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

    @Test
    fun 일시_Keystore_오류는_1_3_5초_간격으로_재시도하고_끝내_실패해도_파일을_지우지_않고_메모리_모드가_된다() {
        val dir = tmp.newFolder()
        val wrapper = SoftwareKeyWrapper()
        val old = DekCipherFactory(dir, wrapper).setup()
        TripQueue(File(dir, "queue.jsonl"), old.cipher).append(listOf(start("a"), start("b")))
        val dekBefore = File(dir, "dek.bin").readText()
        val queueBefore = File(dir, "queue.jsonl").readText()
        wrapper.failUnwrap = true // IllegalStateException = KeyStoreException 같은 일시 오류
        wrapper.unwrapCalls = 0
        val sleeps = ArrayList<Long>()
        val setup = DekCipherFactory(dir, wrapper, sleep = { sleeps.add(it) }).setup()
        assertEquals(listOf(1_000L, 3_000L, 5_000L), sleeps)
        assertEquals(4, wrapper.unwrapCalls)
        assertFalse(setup.persistent)
        assertTrue(setup.keyError)
        assertEquals(0, setup.discardedLines)
        assertEquals(dekBefore, File(dir, "dek.bin").readText())
        assertEquals(queueBefore, File(dir, "queue.jsonl").readText())
        assertFalse(File(dir, "dek.bin.stale").exists())
        // 다음 실행에서 키가 돌아오면 옛 데이터를 그대로 읽는다
        wrapper.failUnwrap = false
        val next = DekCipherFactory(dir, wrapper).setup()
        assertTrue(next.persistent)
        assertEquals(2, TripQueue(File(dir, "queue.jsonl"), next.cipher).load().entries.size)
    }

    @Test
    fun 일시_오류가_재시도_안에_풀리면_정상_동작한다() {
        val dir = tmp.newFolder()
        val wrapper = SoftwareKeyWrapper()
        val old = DekCipherFactory(dir, wrapper).setup()
        val line = old.cipher.encrypt("x")
        var calls = 0
        val flaky = object : KeyWrapper {
            override fun wrap(dek: ByteArray) = wrapper.wrap(dek)
            override fun unwrap(blob: ByteArray) = if (++calls < 3) throw java.security.ProviderException("busy") else wrapper.unwrap(blob)
        }
        val sleeps = ArrayList<Long>()
        val setup = DekCipherFactory(dir, flaky, sleep = { sleeps.add(it) }).setup()
        assertEquals(listOf(1_000L, 3_000L), sleeps)
        assertTrue(setup.persistent)
        assertEquals("x", setup.cipher.decrypt(line))
    }

    @Test
    fun 영구_손실은_재시도_없이_재생성하고_옛_데이터를_폐기한다() {
        val lost = listOf<Throwable>(
            KeyPermanentlyLostException("getKey null"),
            javax.crypto.AEADBadTagException("tag"),
            RuntimeException("wrapped", javax.crypto.AEADBadTagException("tag")),
        )
        for (e in lost) {
            val dir = tmp.newFolder()
            val wrapper = SoftwareKeyWrapper()
            val old = DekCipherFactory(dir, wrapper).setup()
            TripQueue(File(dir, "queue.jsonl"), old.cipher).append(listOf(start("a")))
            wrapper.failUnwrapLost = e
            val sleeps = ArrayList<Long>()
            val fresh = DekCipherFactory(dir, wrapper, sleep = { sleeps.add(it) }).setup()
            assertTrue(sleeps.isEmpty())
            assertEquals(1, fresh.discardedLines)
            assertTrue(fresh.persistent)
            assertFalse(File(dir, "queue.jsonl").exists())
            wrapper.failUnwrapLost = null
            assertEquals(0, DekCipherFactory(dir, wrapper).setup().discardedLines)
        }
    }

    @Test
    fun dek_bin이_없거나_형식이_손상됐으면_영구_손실로_본다() {
        val dir = tmp.newFolder()
        val wrapper = SoftwareKeyWrapper()
        val old = DekCipherFactory(dir, wrapper).setup()
        TripQueue(File(dir, "queue.jsonl"), old.cipher).append(listOf(start("a")))
        File(dir, "dek.bin").delete()
        assertEquals(1, DekCipherFactory(dir, wrapper).setup().discardedLines)
        // wrap 결과가 짧아 형식이 깨진 경우
        File(dir, "dek.bin").writeText(java.util.Base64.getEncoder().encodeToString(ByteArray(5)))
        wrapper.failUnwrapLost = KeyPermanentlyLostException("형식 손상")
        assertEquals(0, DekCipherFactory(dir, wrapper, sleep = { throw AssertionError("재시도 금지") }).setup().discardedLines)
    }

    @Test
    fun 영구_손실_뒤_wrap_저장도_실패하면_옛_dek_bin을_stale로_옮긴다() {
        val dir = tmp.newFolder()
        val wrapper = SoftwareKeyWrapper()
        DekCipherFactory(dir, wrapper).setup()
        wrapper.failUnwrapLost = KeyPermanentlyLostException("키 없음")
        wrapper.failWrap = true
        val setup = DekCipherFactory(dir, wrapper).setup()
        assertFalse(setup.persistent)
        assertFalse(setup.keyError)
        assertFalse(File(dir, "dek.bin").exists())
        assertTrue(File(dir, "dek.bin.stale").exists())
    }
}
