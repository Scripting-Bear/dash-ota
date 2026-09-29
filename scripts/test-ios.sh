#!/bin/sh
# Swift tests for the iOS client. There is no Xcode test target — the sources are compiled into a
# host app by CocoaPods — so the store is built for the host platform and driven directly.
#
# HOME points at a throwaway directory so `Application Support` (where the store keeps its state)
# is isolated per run. That is why no test-only hook exists in the production source.
set -e

# Needs the Swift toolchain, so it is macOS-only. Skip cleanly elsewhere rather than failing the
# run, the same way the Redis/Postgres/S3 adapter tests skip without their service.
if ! command -v swiftc >/dev/null 2>&1; then
  echo "iOS store tests skipped (no swiftc — macOS with Xcode only)"
  exit 0
fi

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

swiftc -Onone \
  "$ROOT/packages/rn/ios/DashOtaStore.swift" \
  "$ROOT/packages/rn/ios/DashOtaConfig.swift" \
  "$ROOT/packages/rn/ios/DashOtaError.swift" \
  "$ROOT/packages/rn/ios/__tests__/main.swift" \
  -o "$WORK/store-tests" 2>&1 | grep -vE "^$" || true

if [ ! -x "$WORK/store-tests" ]; then
  echo "iOS store tests failed to build" >&2
  exit 1
fi

HOME="$WORK/home" "$WORK/store-tests"
