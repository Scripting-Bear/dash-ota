package com.dashota

import com.github.luben.zstd.Zstd
import com.github.luben.zstd.ZstdDecompressCtx
import java.io.File
import kotlin.random.Random
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Decode spike for bytecode deltas (spec §6, gate a).
 *
 * The publisher generates patches with the `zstd` CLI's `--patch-from`, because no Node binding
 * exposes dictionaries. The device has to apply them with zstd-jni, which offers `loadDict` (a
 * raw-content dictionary) rather than `refPrefix`. Those are the same thing for raw bytes, but
 * "should be" is not evidence, so this applies a real `--patch-from` frame and compares the result.
 *
 * It also pins the window assumption: `--patch-from` frames declare a large window, and the decoder
 * only accepts up to its own `windowLogMax`. If a future zstd changes either default, this fails
 * here rather than on someone's phone.
 */
class DashOtaPatchSpikeTest {
  @get:Rule val temp = TemporaryFolder()

  /** Build a base and a target that differ the way one release differs from the next. */
  private fun corpus(bytes: Int, seed: Int): ByteArray {
    val rnd = Random(seed)
    val words = listOf("function", "return", "const", "render", "props", "state", "dispatch", "useEffect")
    val out = StringBuilder()
    while (out.length < bytes) out.append(words[rnd.nextInt(words.size)]).append(rnd.nextInt(1000)).append(' ')
    return out.toString().toByteArray().copyOf(bytes)
  }

  @Test
  fun `a zstd --patch-from frame applies with loadDict and reproduces the target exactly`() {
    val base = corpus(2_000_000, 1)
    // A target that is mostly the base, with an edit in the middle — the shape of a JS change.
    val target = base.copyOf().also { t ->
      val edit = "THIS REGION CHANGED IN THE NEW RELEASE ".repeat(200).toByteArray()
      edit.copyInto(t, 900_000)
    }

    val baseFile = temp.newFile("base.bin").also { it.writeBytes(base) }
    val targetFile = temp.newFile("target.bin").also { it.writeBytes(target) }
    val patchFile = File(temp.root, "patch.zst")

    val zstd = listOf("/opt/homebrew/bin/zstd", "/usr/local/bin/zstd", "/usr/bin/zstd").firstOrNull { File(it).canExecute() }
    org.junit.Assume.assumeTrue("no zstd CLI on this machine", zstd != null)

    val proc = ProcessBuilder(
      zstd, "-19", "--patch-from=${baseFile.absolutePath}", targetFile.absolutePath,
      "-o", patchFile.absolutePath, "-f", "-q",
    ).redirectErrorStream(true).start()
    val log = proc.inputStream.bufferedReader().readText()
    assertTrue("zstd --patch-from failed: $log", proc.waitFor() == 0)

    val patch = patchFile.readBytes()
    assertTrue("patch should be far smaller than the target", patch.size < target.size / 20)

    // What the device will do: load the base it already holds as a raw dictionary, then decode.
    val declared = Zstd.getFrameContentSize(patch, 0, patch.size)
    assertTrue("frame must declare its size so the device can bound the output", declared > 0)

    val applied = ZstdDecompressCtx().use { ctx ->
      ctx.loadDict(base)
      val out = ByteArray(declared.toInt())
      val n = ctx.decompressByteArray(out, 0, out.size, patch, 0, patch.size)
      out.copyOf(n)
    }

    assertArrayEquals("applying the patch must reproduce the target byte for byte", target, applied)
    println(
      "patch spike: base=${base.size / 1024}K target=${target.size / 1024}K " +
        "patch=${patch.size / 1024}K (${"%.2f".format(100.0 * patch.size / target.size)}% of target)",
    )
  }

  @Test
  fun `applying a patch against the wrong base does not silently produce the target`() {
    val base = corpus(500_000, 2)
    val wrongBase = corpus(500_000, 3)
    val target = base.copyOf().also { "CHANGED".toByteArray().copyInto(it, 250_000) }

    val baseFile = temp.newFile("b.bin").also { it.writeBytes(base) }
    val targetFile = temp.newFile("t.bin").also { it.writeBytes(target) }
    val patchFile = File(temp.root, "p.zst")
    val zstd = listOf("/opt/homebrew/bin/zstd", "/usr/local/bin/zstd", "/usr/bin/zstd").firstOrNull { File(it).canExecute() }
    org.junit.Assume.assumeTrue("no zstd CLI on this machine", zstd != null)
    ProcessBuilder(zstd, "-19", "--patch-from=${baseFile.absolutePath}", targetFile.absolutePath, "-o", patchFile.absolutePath, "-f", "-q")
      .start().waitFor()

    val patch = patchFile.readBytes()
    val applied = try {
      ZstdDecompressCtx().use { ctx ->
        ctx.loadDict(wrongBase)
        val out = ByteArray(target.size)
        val n = ctx.decompressByteArray(out, 0, out.size, patch, 0, patch.size)
        out.copyOf(n)
      }
    } catch (_: Exception) {
      ByteArray(0) // refused outright, which is also an acceptable outcome
    }

    assertTrue(
      "a patch applied to the wrong base must not yield the target — the hash check is the backstop",
      !applied.contentEquals(target),
    )
  }
}
