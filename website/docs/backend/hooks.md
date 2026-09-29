---
sidebar_position: 6
title: Hooks
---

# Hooks

Options that connect the backend to your own auth, analytics and logging. All are optional.

```js
dashOtaMiddleware({
  adminToken: process.env.OTA_ADMIN_TOKEN,
  verifyEnrollToken: async (token, principal) => <YOUR_SESSION_CHECK>(token),
  onConfirm: (event) => console.log('ota confirm', event),
  onPublish: (event) => console.log('ota publish', event),
  logger: console,
});
```

`<YOUR_SESSION_CHECK>` stands for your own function. Any object with `info`, `warn` and `error`
methods works as `logger`.

## `verifyEnrollToken`

```ts
verifyEnrollToken?: (
  token: string | undefined,
  principal: {
    installId: string;
    platform: string;
    channel: string;
    appVersion?: string;
    buildNumber?: number;
    attestationToken?: string;   // from the app's IntegrityAttestor, if you set one
    keyHardwareBacked?: boolean; // reported by the device; not proof
  },
) => boolean | Promise<boolean>;
```

Checks the token a device sends when it registers (whatever the app's `getEnrollToken` returns).
Return `true` to let it register its public key. Set this in production so only a signed-in user's
device can register. Without it, `requireEnrollAuth` (on by default) only checks that some token
is present.

Make the token short-lived and good only for enrollment. A device re-enrolls whenever the server
answers `not_enrolled`, so a server that has been broken into can collect the tokens devices send.

## `onConfirm`

```ts
onConfirm?: (event: {
  installId: string;
  bundleId: string;
  status: 'applied' | 'healthy' | 'failed' | 'rolled_back';
  reason?: string;
  autoPaused: boolean;
}) => void;
```

Runs after every accepted `/confirm` report. Use it for adoption dashboards and alerts:
`autoPaused` is `true` on the report that made the backend pause the release.

## `onPublish`

```ts
onPublish?: (event: {
  bundleId: string;
  platform: string;
  channel: string;
  bundleVersion: number;
  runtimeVersion: string;
  rolloutPercentage: number;
}) => void;
```

Runs once a release is finalized and devices can get it. Useful for audit logs and release
announcements.

`onConfirm` and `onPublish` aren't awaited. If one throws or its promise rejects, the error is
logged and the request still succeeds; a hook can't crash the server.

## `logger`

```ts
logger?: { info(message: string): void; warn(message: string): void; error(message: string): void };
```

Where the backend writes its own messages (where it stores data, enrollments, publishes, key
registrations). The middleware and factory log nothing unless you pass one; the standalone server
logs to the console.

→ [Storage providers](/docs/backend/providers)
