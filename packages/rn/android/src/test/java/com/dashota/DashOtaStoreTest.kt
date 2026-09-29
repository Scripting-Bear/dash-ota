package com.dashota

import androidx.test.core.app.ApplicationProvider
import android.content.Context
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

/**
 * The slot state machine and the crash-loop breaker.
 *
 * This is where the 2026-09-08 production incident lived: the breaker fired on the first boot of
 * every update and deleted the slot directory out from under the running bundle. Every test here
 * exists because something in this file was, or could still be, wrong.
 */
@RunWith(RobolectricTestRunner::class)
class DashOtaStoreTest {
  private lateinit var ctx: Context

  @Before
  fun setUp() {
    ctx = ApplicationProvider.getApplicationContext()
    DashOtaStore.baseDir(ctx).deleteRecursively()
  }

  /** Assemble a bundle in staging and commit it, i.e. what a completed download does. */
  private fun stage(bundleId: String, version: Int) {
    val staging = DashOtaStore.stagingDir(ctx, bundleId)
    File(staging, "index.android.bundle").writeText("// $bundleId")
    DashOtaStore.commitStaged(
      ctx,
      bundleId,
      version,
      DashOtaConfig.runtimeVersion(ctx),
      "sha-of-$bundleId",
      mapOf("index.android.bundle" to "sha-of-$bundleId"),
    )
  }

  /** Stage a bundle and promote it to pending. */
  private fun stagePending(bundleId: String, version: Int) {
    stage(bundleId, version)
    assertTrue("staged bundle should promote to pending", DashOtaStore.promoteStagedToPending(ctx))
  }

  private fun state(): JSONObject = DashOtaStore.loadState(ctx)
  private fun slotId(key: String): String? =
    if (state().isNull(key)) null else state().getJSONObject(key).optString("bundleId")

  @Test
  fun `fresh install resolves to the embedded bundle`() {
    assertNull(DashOtaStore.resolveBundleAtLaunch(ctx))
    assertEquals(2, state().optInt("stateSchema"))
  }

  @Test
  fun `a pending bundle applies on trial and marks healthy`() {
    stagePending("bnd_1", 1)
    assertTrue(DashOtaStore.resolveBundleAtLaunch(ctx)!!.endsWith("bnd_1/index.android.bundle"))
    assertTrue(state().getBoolean("trial"))
    assertEquals(1, state().getInt("bootAttempts"))

    DashOtaStore.markHealthy(ctx)
    assertFalse(state().getBoolean("trial"))
    assertEquals("bnd_1", slotId("lastKnownGood"))
  }

  @Test
  fun `two real crashes disable the bundle and revert to last known good`() {
    stagePending("bnd_good", 1)
    DashOtaStore.resolveBundleAtLaunch(ctx)
    DashOtaStore.markHealthy(ctx)

    stagePending("bnd_bad", 2)
    // Launch 1: applied on trial. Reaches JS, then dies — no pause mark, so it is a crash.
    DashOtaStore.resolveBundleAtLaunch(ctx)
    DashOtaStore.markBeacon(ctx)
    // Launch 2: still on trial, second attempt.
    DashOtaStore.resolveBundleAtLaunch(ctx)
    DashOtaStore.markBeacon(ctx)
    assertEquals("bnd_bad", slotId("current"))
    // Launch 3: the breaker fires.
    val path = DashOtaStore.resolveBundleAtLaunch(ctx)
    assertEquals("bnd_good", slotId("current"))
    assertTrue(path!!.endsWith("bnd_good/index.android.bundle"))
    assertTrue(DashOtaStore.isDisabled(ctx, "bnd_bad"))
    assertEquals("bnd_bad", DashOtaStore.consumeFailedReport(ctx))
  }

  @Test
  fun `a last known good that also crash-loops falls back to the embedded bundle`() {
    stagePending("bnd_good", 1)
    DashOtaStore.resolveBundleAtLaunch(ctx)
    DashOtaStore.markHealthy(ctx)

    stagePending("bnd_bad", 2)
    repeat(2) {
      DashOtaStore.resolveBundleAtLaunch(ctx)
      DashOtaStore.markBeacon(ctx)
    }
    // The breaker reverts to bnd_good, which now runs on trial with only the embedded bundle behind it.
    DashOtaStore.resolveBundleAtLaunch(ctx)
    DashOtaStore.markBeacon(ctx)
    assertEquals("bnd_good", slotId("current"))
    assertTrue(state().getBoolean("trial"))
    assertNull(slotId("lastKnownGood"))

    DashOtaStore.resolveBundleAtLaunch(ctx)
    DashOtaStore.markBeacon(ctx)
    assertNull(DashOtaStore.resolveBundleAtLaunch(ctx))
    assertNull(slotId("current"))
    assertTrue(DashOtaStore.isDisabled(ctx, "bnd_good"))
  }

  @Test
  fun `force killing the app never disables a healthy bundle`() {
    stagePending("bnd_1", 1)
    DashOtaStore.resolveBundleAtLaunch(ctx)

    // The user opens it and swipes it away, ten times, always before it can mark healthy.
    repeat(10) {
      DashOtaStore.markBeacon(ctx)
      DashOtaStore.markPaused(ctx)
      DashOtaStore.resolveBundleAtLaunch(ctx)
      assertEquals("the refund must hold the attempt count still", 1, state().getInt("bootAttempts"))
    }
    assertFalse(DashOtaStore.isDisabled(ctx, "bnd_1"))
    assertEquals("bnd_1", slotId("current"))
  }

  @Test
  fun `a bundle that pauses, resumes and then crashes is still counted`() {
    stagePending("bnd_1", 1)
    DashOtaStore.resolveBundleAtLaunch(ctx)
    // Reached JS, was interrupted, came back — then died. Returning to the foreground clears the
    // pause mark, so this must NOT be forgiven.
    DashOtaStore.markBeacon(ctx)
    DashOtaStore.markPaused(ctx)
    DashOtaStore.clearPaused(ctx)
    DashOtaStore.resolveBundleAtLaunch(ctx)
    assertEquals(2, state().getInt("bootAttempts"))
  }

  @Test
  fun `the breaker never deletes a slot the running process may still be using`() {
    stagePending("bnd_good", 1)
    DashOtaStore.resolveBundleAtLaunch(ctx)
    DashOtaStore.markHealthy(ctx)
    stagePending("bnd_bad", 2)
    DashOtaStore.resolveBundleAtLaunch(ctx)
    DashOtaStore.markBeacon(ctx)
    DashOtaStore.resolveBundleAtLaunch(ctx)
    DashOtaStore.markBeacon(ctx)

    val badDir = File(DashOtaStore.bundlesDir(ctx), "bnd_bad")
    assertTrue(badDir.exists())
    DashOtaStore.resolveBundleAtLaunch(ctx) // the breaker fires here
    // The incident: gc() ran in this same process and deleted the directory whose bytecode was
    // still mapped. It must survive until the NEXT launch sweeps it.
    assertTrue("the demoted slot must outlive the process that demoted it", badDir.exists())
    DashOtaStore.resolveBundleAtLaunch(ctx)
    assertFalse("the next launch may collect it", badDir.exists())
  }

  @Test
  fun `a bundle downloaded inside the health window is not swept away`() {
    stagePending("bnd_1", 1)
    DashOtaStore.resolveBundleAtLaunch(ctx)
    // A second update finishes downloading before the first is marked healthy.
    stage("bnd_2", 2)
    DashOtaStore.markHealthy(ctx) // used to gc() everything that was not current or last-known-good
    assertTrue(File(DashOtaStore.bundlesDir(ctx), "bnd_2").exists())
    assertTrue(DashOtaStore.promoteStagedToPending(ctx))
  }

  @Test
  fun `a committed slot advertises its files for the next update to reuse`() {
    stagePending("bnd_1", 1)
    DashOtaStore.resolveBundleAtLaunch(ctx)
    DashOtaStore.markHealthy(ctx)

    // This map is what makes the next update small: a file whose hash is already here is linked
    // from this slot instead of downloaded again.
    val have = DashOtaStore.haveFiles(ctx)
    assertEquals(1, have.size)
    val reusable = have["sha-of-bnd_1"]
    assertTrue("the previous slot's file should be reusable", reusable != null && reusable.exists())
    assertEquals("// bnd_1", reusable!!.readText())
  }

  @Test
  fun `marking healthy never touches a download in progress`() {
    stage("bnd_1", 1)
    DashOtaStore.promoteStagedToPending(ctx)
    DashOtaStore.resolveBundleAtLaunch(ctx)
    DashOtaStore.markHealthy(ctx)

    // A second update begins: its staging directory exists but nothing references it yet, because
    // `staged` is only written at commit time.
    val staging = DashOtaStore.stagingDir(ctx, "bnd_2")
    File(staging, "drawable-mdpi").mkdirs()
    File(staging, "drawable-mdpi/logo.png").writeText("reused asset bytes")

    // The host app marks healthy while that download is still running — the example app does it on
    // a timer, so this is the normal case, not an exotic one. It used to sweep the slots, which
    // deleted the files already assembled; the update then committed with them missing and every
    // one rendered blank.
    DashOtaStore.markHealthy(ctx)

    assertTrue(
      "marking healthy deleted a staging directory belonging to an in-flight download",
      File(staging, "drawable-mdpi/logo.png").exists(),
    )
  }

  @Test
  fun `a slot is never published while a promised file is missing`() {
    val staging = DashOtaStore.stagingDir(ctx, "bnd_partial")
    File(staging, "index.android.bundle").writeText("// bundle")
    var threw = false
    try {
      DashOtaStore.commitStaged(
        ctx,
        "bnd_partial",
        1,
        "rt1",
        "sha-bundle",
        mapOf("index.android.bundle" to "sha-bundle", "drawable-mdpi/logo.png" to "sha-logo"),
      )
    } catch (_: IllegalStateException) {
      threw = true
    }
    assertTrue("committing an incomplete slot must fail loudly", threw)
    assertNull("a rejected commit must not become the staged slot", DashOtaStore.loadState(ctx).optJSONObject("staged"))
  }

  @Test
  fun `state written by an older schema is discarded rather than trusted`() {
    val legacy = JSONObject()
      .put("current", JSONObject().put("bundleId", "bnd_legacy").put("version", 99))
      .put("trial", false)
    File(DashOtaStore.baseDir(ctx), "state.json").writeText(legacy.toString())
    File(DashOtaStore.bundlesDir(ctx), "bnd_legacy").mkdirs()

    assertNull("a pre-schema-2 slot must never be loaded", DashOtaStore.resolveBundleAtLaunch(ctx))
    assertEquals(2, state().optInt("stateSchema"))
    assertFalse(File(DashOtaStore.bundlesDir(ctx), "bnd_legacy").exists())
  }

@Test
  fun `an apply is reported exactly once, on the launch that performed it`() {
    stage("bnd_1", 1)
    DashOtaStore.promoteStagedToPending(ctx)
    assertEquals("nothing applied yet", "", DashOtaStore.consumeAppliedReport(ctx))

    DashOtaStore.resolveBundleAtLaunch(ctx)
    assertEquals("the launch that applied it must report it", "bnd_1", DashOtaStore.consumeAppliedReport(ctx))
    // Only this launch knows an apply happened; by the next one the bundle is indistinguishable
    // from one that has been running for days, so the report must not repeat.
    assertEquals("reported twice", "", DashOtaStore.consumeAppliedReport(ctx))

    DashOtaStore.resolveBundleAtLaunch(ctx)
    assertEquals("a later launch must not re-report", "", DashOtaStore.consumeAppliedReport(ctx))
  }

  @Test
  fun `a corrupt state file does not brick OTA forever`() {
    File(DashOtaStore.baseDir(ctx), "state.json").writeText("{ this is not json")
    assertNull(DashOtaStore.resolveBundleAtLaunch(ctx))
    stagePending("bnd_1", 1)
    assertTrue(DashOtaStore.resolveBundleAtLaunch(ctx)!!.endsWith("bnd_1/index.android.bundle"))
  }

  @Test
  fun `a user-requested reload does not spend a boot attempt`() {
    stagePending("bnd_1", 1)
    DashOtaStore.resolveBundleAtLaunch(ctx)
    assertEquals(1, state().getInt("bootAttempts"))
    DashOtaStore.markUserReload(ctx)
    DashOtaStore.resolveBundleAtLaunch(ctx)
    assertEquals("an explicit restart is not evidence of a crash", 1, state().getInt("bootAttempts"))
  }
}
