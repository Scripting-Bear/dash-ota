# @dash-ota/shared

The crypto + protocol core shared by [dash-ota](https://github.com/Scripting-Bear/dash-ota)'s
[`@dash-ota/cli`](https://github.com/Scripting-Bear/dash-ota/tree/main/packages/cli) (signer) and
[`@dash-ota/backend`](https://github.com/Scripting-Bear/dash-ota/tree/main/packages/backend)
(distributor). Pure Node `crypto` — **no external crypto dependencies**.

> This is an internal building block. App developers integrate
> [`react-native-dash-ota`](https://github.com/Scripting-Bear/dash-ota/blob/main/docs/react-native.md)
> (client) and [`@dash-ota/backend`](https://github.com/Scripting-Bear/dash-ota/blob/main/docs/backend.md)
> (server); you rarely depend on this package directly.

## What's inside

- **Ed25519** manifest signing + verification (`signManifest`, `verifyManifest`)
- **Per-file content-addressed blobs**: zstd compression plus convergent AES-256-GCM sealing, so an
  unchanged file produces identical bytes and is stored and downloaded once (`buildReleaseV2`,
  `verifyReleaseV2`)
- **ECDSA P-256** request verification for the hardware device-key auth (`verifyRequestEcdsa`)
- Canonical JSON, the manifest schema, and **targeting** (exact `runtimeVersion` gate,
  `targetAppVersions` semver subset, deterministic rollout bucketing)
- `runtimeVersion` **fingerprinting** of native inputs

## Installation

```sh
npm install @dash-ota/shared
```

## Design

The trust split — signing only in the CLI, verification in native, a compromise-tolerant
backend — is described in
[DESIGN.md](https://github.com/Scripting-Bear/dash-ota/blob/main/DESIGN.md).

## License

MIT
