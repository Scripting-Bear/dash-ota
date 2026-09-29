---
sidebar_position: 3
title: Request signing
---

# Request signing

Client requests to `/check` and `/confirm` are authenticated with the device's own key
(ECDSA-P256), not a shared secret. The key is generated in the AndroidKeyStore or the iOS Secure
Enclave; iOS falls back to a software Keychain key when the Secure Enclave is unavailable, unless
`OTA_REQUIRE_HARDWARE_KEY` is set.

## Headers

```
x-ota-install:   <installId>
x-ota-nonce:     <random nonce, base64url, from the platform CSPRNG>
x-ota-timestamp: <ms since epoch>
x-ota-signature: <base64 ECDSA-P256-SHA256 signature (DER)>
```

## Canonical signing string

The signature is over the exact UTF-8 bytes of:

```
METHOD \n path \n installId \n nonce \n timestamp \n sha256Hex(body)
```

…joined by newlines. `path` is the pathname without the query string. Signing the **path** is why
the backend middleware must be mounted at the **root** — if the path the server sees differs from
what the client signed, verification fails.

## Verification (backend)

1. Require the install header and, with request signing on, the other three.
2. Reject if the timestamp is outside the skew window (`timestampSkewMs`, default 5 minutes).
3. Look up the install's **public key** (registered at `/enroll`); reject if there is none.
4. Verify the ECDSA signature over the recomputed canonical string against that key.
5. Only then register the nonce, and reject the request if it was already seen within
   `nonceTtlMs` (default 10 minutes).

Registering the nonce last means a forged request cannot fill the replay cache. Keep `nonceTtlMs` at
least twice `timestampSkewMs`: a nonce forgotten while its timestamp is still inside the window can
be replayed.

## Why ECDSA, not HMAC

A symmetric HMAC secret must be *transmitted* to the device at enrollment — an interception point.
With an asymmetric key, the private half is generated on the device and **never leaves it**; only
the public half is enrolled. There is no secret to sniff or replay at bootstrap.

## On the wire

- **Client:** the native `signWithDeviceKey()` produces the signature and `generateNonce()` the
  nonce; the JS `otaClient` assembles the headers.
- **Server-issued nonce:** `/check` returns a `serverNonce` that `/confirm` must echo. From backend
  0.5.1 it is tied to the install and to the bundles that check covered (the one offered and the
  one the device reported running), and each (bundle, status) report can use it once. Before
  0.5.1, a nonce from a check that offered nothing could be spent on any bundle, so any enrolled
  device could report failures against any release.

→ [Security model](/docs/concepts/security-model) · [Endpoints](/docs/backend/endpoints)
