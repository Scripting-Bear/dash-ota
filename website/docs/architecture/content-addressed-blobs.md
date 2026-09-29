---
sidebar_position: 2
title: Content-addressed blobs
---

# Content-addressed blobs

An OTA payload is **multi-file** — the JS bundle *plus* every asset it references. dash-ota ships
each distinct file as its own **blob**, named by a hash of its contents. Nothing is packed into a
single archive, which is what lets a device download only the files it does not already have.

## One blob per distinct file

Every file in a release is compressed, optionally encrypted, and stored under the hash of the
result. The signed manifest records both hashes for each file:

```json
{
  "path": "drawable-xxhdpi/logo.png",
  "sha256": "<hash of the file's real bytes>",
  "size": 45123,
  "blob": {
    "sha256": "<hash of the stored bytes>",
    "size": 45140,
    "compression": "none",
    "ivB64": "…",
    "tagB64": "…"
  }
}
```

`sha256` is the file's identity. `blob.sha256` is the identity of the bytes on the wire. The device
checks both: the blob hash before it decrypts anything, the file hash after it decompresses.

Two files with identical contents collapse to one blob, so an asset duplicated across densities or
a file that was merely renamed costs nothing extra.

## Why a device downloads so little

A device keeps the plaintext hash of every file it holds. On an update it fetches only the blobs
whose `sha256` it cannot already produce, and copies the rest out of its existing slot.

Measured on a real release where a single asset changed: **1 of 6 files downloaded — 30.3 KB
instead of 1000.3 KB.** The JS bundle changes on every release, so in practice an update costs the
bundle plus whatever assets actually changed.

## Compression

Blobs are compressed with **zstd**: level 19 for the JS bundle, which dominates the payload, and
level 3 for everything else. Formats that are already compressed (`png`, `jpg`, `webp`, `mp4`,
`woff2`, …) are skipped, and so is any file where compression saves less than 2%. Those blobs are
stored as-is and marked `"compression": "none"`.

On a real 25.8 MB Hermes bundle, zstd level 19 produces 7.3 MB.

## Storage is shared

The server stores blobs in one global namespace keyed by `blob.sha256`, so a file shared by several
releases is stored **once**. Publishing tells you what that saved:

```
uploading:       1 of 6 blobs (5 already present)
```

This works because encryption is convergent — see
[one content key per channel](/docs/architecture/manifest-schema#one-content-key-per-channel).
Sharing extends across platforms too: an iOS release signed with the same key as an Android one,
whose assets match, uploads only its bundle.

## Why not a single archive

Earlier versions shipped one encrypted archive containing everything. It was simple, but every
update re-downloaded every byte — a one-line JS change cost the full payload, assets included.
Splitting into content-addressed blobs is what makes reuse possible at all. It does not make a
changed JS bundle smaller: the bundle still downloads whole, because nothing generates binary
patches yet.

→ [Manifest schema](/docs/architecture/manifest-schema) · [Slot model](/docs/architecture/slot-model)
