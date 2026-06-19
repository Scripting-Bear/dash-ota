---
sidebar_position: 3
title: Request signing
---

# Request signing

Client requests to `/check` and `/confirm` are authenticated with the device's **hardware key**
(ECDSA-P256), not a shared secret.

## Headers

```
x-ota-install:   <installId>
x-ota-nonce:     <random nonce>
x-ota-timestamp: <ms since epoch>
x-ota-signature: <base64 ECDSA-P256-SHA256 signature (DER)>
```

## Canonical signing string

The signature is over the exact UTF-8 bytes of:

```
METHOD \n path \n installId \n nonce \n timestamp \n sha256Hex(body)
```

…joined by newlines. Signing the **path** is why the backend middleware must be mounted at the
**root** — if the path the server sees differs from what the client signed, verification fails.

## Verification (backend)

1. Look up the install's **public key** (registered at `/enroll`).
2. Reject if the timestamp is outside the skew window, or the nonce was already seen.
3. Verify the ECDSA signature over the recomputed canonical string against the public key.

## Why hardware ECDSA, not HMAC

A symmetric HMAC secret must be *transmitted* to the device at enrollment — an interception point.
With an asymmetric **hardware** key, the private half is generated in the Secure Enclave /
AndroidKeyStore and **never leaves the device**; only the public half is enrolled. There is no secret
to sniff or replay at bootstrap.

## On the wire

- **Client:** the native `signWithDeviceKey()` produces the signature; the JS `otaClient` assembles
  the headers.
- **Server-issued nonce:** `/check` returns a one-time `serverNonce` that `/confirm` must echo,
  binding a confirm to a real check.

→ [Security model](/docs/concepts/security-model) · [Endpoints](/docs/backend/endpoints)
