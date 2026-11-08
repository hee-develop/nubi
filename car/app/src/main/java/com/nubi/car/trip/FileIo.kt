package com.nubi.car.trip

import java.io.File
import java.io.FileOutputStream
import java.nio.channels.FileChannel
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

/** 파일을 안전하게 바꾸는 도구. 임시 파일에 쓰고 fsync한 뒤 rename한다(전원이 나가도 옛 파일이나 새 파일 중 하나는 온전하다). */
object FileIo {
    fun tmpOf(target: File) = File(target.parentFile, target.name + ".tmp")

    /** [tmp]를 새로 만들어 [bytes]를 쓰고 fsync한다. rename은 [commit]이 한다. */
    fun writeSynced(tmp: File, bytes: ByteArray) {
        FileOutputStream(tmp, false).use {
            it.write(bytes)
            it.flush()
            it.fd.sync()
        }
    }

    /** [tmp] 끝에 덧붙이고 fsync한다. */
    fun appendSynced(tmp: File, bytes: ByteArray) {
        FileOutputStream(tmp, true).use {
            it.write(bytes)
            it.flush()
            it.fd.sync()
        }
    }

    fun append(file: File, bytes: ByteArray) {
        FileOutputStream(file, true).use { it.write(bytes) }
    }

    /** [tmp]를 [target] 자리로 옮긴다. 원자적 이동이 안 되는 파일시스템이면 일반 교체로 대신한다. */
    fun commit(tmp: File, target: File) {
        try {
            Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (e: AtomicMoveNotSupportedException) {
            Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
        syncDir(target.parentFile)
    }

    fun writeAtomically(target: File, bytes: ByteArray) {
        val tmp = tmpOf(target)
        try {
            writeSynced(tmp, bytes)
            commit(tmp, target)
        } catch (e: Exception) {
            tmp.delete()
            throw e
        }
    }

    /** rename을 디스크에 남긴다. 디렉터리를 열 수 없는 환경에서는 건너뛴다. */
    private fun syncDir(dir: File?) {
        if (dir == null) return
        try {
            FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) }
        } catch (e: Exception) {
            // 일부 파일시스템은 디렉터리 fsync를 지원하지 않는다
        }
    }

    /** 파일이 비어 있지 않은데 개행으로 끝나지 않으면(쓰다 죽은 줄) 개행을 붙여 다음 append가 그 줄에 붙지 않게 한다. */
    fun terminateLastLine(file: File) {
        if (!file.exists() || file.length() == 0L) return
        java.io.RandomAccessFile(file, "r").use { raf ->
            raf.seek(raf.length() - 1)
            if (raf.read() == '\n'.code) return
        }
        append(file, "\n".toByteArray())
    }
}
