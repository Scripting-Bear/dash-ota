# react-native-dash-ota

## 0.3.2

Fixes a bug that made every OTA update appear to apply, lose all of its bundled images, and then
revert on the next launch.

- **fix:** resolve the OTA bundle **once per process**. React Native re-reads the bundle path five
  or six times per launch, and each read used to spend a crash-loop boot attempt — so the breaker
  disabled every bundle on its first boot and deleted its slot directory underneath the running,
  memory-mapped bytecode. Every `require()`d asset then failed with ENOENT.
- **fix:** boot attempts are **refunded** when the previous process reached JS and was then paused
  by the user, so force-killing the app can no longer blocklist a healthy bundle. Real crashes,
  before or after JS starts, still count. Returning to the foreground clears the pause mark, so a
  bundle that pauses, resumes and then crashes is not forgiven.
- **fix:** GC keeps every slot the state references, including `pending` and `staged`. A bundle
  downloaded inside the health window used to be deleted before it could be applied.
- **fix:** the crash-loop branch no longer deletes slot directories from a live process.
- **new:** the launch decision is logged natively, one line per cold start (Android `adb logcat -s
  DashOta:W`, iOS subsystem `dash-ota`). Release builds strip the JS console trail, so this is the
  only way to see why an update did or did not apply on a real device. No tokens, keys or user data.
- **breaking (on-disk state):** `state.json` gains `stateSchema: 2`; older state is discarded on
  load. The embedded bundle runs and the next check re-downloads.
