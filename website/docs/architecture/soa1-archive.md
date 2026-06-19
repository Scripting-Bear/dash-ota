---
sidebar_position: 2
title: SOA1 archive format
---

# SOA1 archive format

An OTA payload is **multi-file** — the JS bundle *plus* an assets directory. dash-ota packs them
into a single simple archive ("SOA1"), AES-256-GCM-encrypts it, and ships that.

## Layout

```
magic(4)  = "SOA1"
headerLen = uint32 BE
header    = JSON array: [{ "path": "...", "size": N }, ...]
blobs     = concatenated file bytes, in header order
```

It's deliberately minimal — no compression cleverness, no external dependency — so the native
unpacker (Kotlin/Swift) is small and auditable.

## Lifecycle

1. **CLI:** read the bundle dir → build the SOA1 archive → AES-256-GCM encrypt → record each file's
   `{ path, size, sha256 }` in the signed manifest.
2. **Native:** decrypt → parse the SOA1 header → for each entry, slice the blob, verify `size` and
   `sha256` against the manifest, and write it to the staged slot.

## Why an archive, not just `.js`

`react-native bundle --assets-dest` emits a JS bundle **plus** assets (new images/fonts an OTA
introduces won't exist in the binary). Shipping only the `.js` would break those assets. The archive
carries everything, native unpacks it to the slot, and asset URLs resolve from there (the CodePush
approach).

→ [Manifest schema](/docs/architecture/manifest-schema) · [Slot model](/docs/architecture/slot-model)
