---
sidebar_position: 12
title: Troubleshooting
---

# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `enroll failed: 400` / no `devicePublicKeyB64` | native module not wired (stale build) or `getEnrollToken` returns nothing while `requireEnrollAuth` is on | Clean rebuild (regenerate codegen + native); supply `getEnrollToken`, or set `OTA_REQUIRE_ENROLL_AUTH=false` for local dev |
| `enroll failed: 401` | enroll token rejected | Implement `verifyEnrollToken` on the backend; pass a valid session token from `getEnrollToken` |
| `manifest signature did not verify` | the OTA was signed with a key the app doesn't embed | Embed the matching `ota_public_keys`; ensure the channel/key line up |
| "no update" when you expect one | `runtimeVersion`/`channel` mismatch, rollout bucket, or `bundleVersion` not greater | Confirm the published OTA's `runtimeVersion` equals the binary's; check `dash-ota list` |
| OTA never applies | applied on **cold start** only; debug build uses Metro | Use a **release** build; relaunch twice |
| Bundle won't load / crashes | Hermes bytecode mismatch | Compile the OTA with the **binary's** `hermesc`; the `runtimeVersion` must encode the Hermes ABI |
| Reverts every release | `markHealthy()` never called | Call it from your first usable screen, or set `autoMarkHealthyMs` |

## Reading logs

The provider logs through `config.logger` (defaults to `console`). In release builds, **`console.log`
is stripped** — only `console.error` and native logs surface. Watch logcat / Console for
`[dash-ota]` lines and native `DashOta` errors.

## When in doubt

- Verify the **installed** binary actually contains your latest JS + native (a clean reinstall
  beats `install -r`).
- Confirm the device's reported `runtimeVersion` matches the OTA's exactly.
- Check `dash-ota list` for the release's rollout %, paused state, and adoption.
