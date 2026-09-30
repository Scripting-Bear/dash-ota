# Security policy

dash-ota is update infrastructure: a flaw in it can put code on your users' devices. Reports are
welcome, and they're handled before feature work.

## Reporting a vulnerability

Report privately through GitHub:
[Report a vulnerability](https://github.com/Scripting-Bear/dash-ota/security/advisories/new).
Please don't open a public issue or pull request for a vulnerability until a fixed version is on
npm.

Include what you can of:

- the package and version (`react-native-dash-ota`, `@dash-ota/cli`, `@dash-ota/backend`,
  `@dash-ota/shared`), and the platform for client issues;
- what an attacker needs: control of the backend, a network position, an enrolled device, the
  admin token, or nothing;
- steps or a proof of concept, and what happens versus what should.

You'll get an acknowledgement, updates while it's worked on, and credit in the release notes if you
want it.

## Supported versions

Fixes ship as patch releases of the current line only.

| Package | Supported |
|---|---|
| `react-native-dash-ota` | 0.5.x from 0.5.1 (0.5.0 is deprecated: it crashes on iOS) |
| `@dash-ota/cli` | 0.6.x |
| `@dash-ota/backend` | 0.5.x |
| `@dash-ota/shared` | 0.4.x |

The client is native code, so a client fix reaches users only with your next store build.

## What's in scope

The security model is that the backend distributes releases but can't create one: only the holder
of the Ed25519 private key can ship code. These are vulnerabilities:

- a device installing or running JavaScript that wasn't signed by a key compiled into the app;
- getting past a native check: signature, app id, runtime version, channel, platform, minimum
  native build, bundle version, file hashes, or path validation;
- writing files outside the update's own directories on the device;
- impersonating a device's requests, or replaying them, against the backend;
- using the admin API without the admin token, or getting the token out of the backend;
- reaching or controlling the CLI's local dashboard from another origin or machine;
- crashing or exhausting the backend with requests an unauthenticated client can send.

## Known limits (not vulnerabilities)

These are documented trade-offs. Reports that show a new way to exploit one are still welcome.

- The force-update policy (`severity`, `minSupportedNativeVersion`) isn't signed, so a breached
  backend can show a blocking update prompt in apps that block on it. It can't choose the store
  link (clients 0.5.0 and later ignore the server's).
- The downgrade check compares with the bundle running now. After a store update, a rollback or a
  crash-loop revert, an older release you signed can install again if the server offers it.
- A signing key compiled into an app can't be revoked remotely; only a store update removes it.
- The content key travels in the manifest, so the backend and enrolled devices can read bundles.
  Encryption hides files from someone who can read your storage, nothing more.
- Only file downloads use certificate pinning. `/enroll`, `/check` and `/confirm` are pinned only
  if the app supplies a pinned `fetch`.
- Device facts such as `keyHardwareBacked` are reported by the device, and attestation is an
  optional hook.

The full picture: [If your update server is breached](https://scripting-bear.github.io/dash-ota/docs/security/breach)
and [Limitations](https://scripting-bear.github.io/dash-ota/docs/security/limitations).
