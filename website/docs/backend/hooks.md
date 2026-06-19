---
sidebar_position: 6
title: Hooks
---

# Hooks

The config-driven extension points — wire your own auth, analytics, and logging without forking
the core. All are optional.

```ts
dashOtaMiddleware({
  verifyEnrollToken: async (token, principal) => auth.verifySession(token),
  onConfirm: (e) => metrics.track('ota_confirm', e),
  onPublish: (e) => audit.log('ota_publish', e),
  logger: { info, warn, error },
});
```

## `verifyEnrollToken`

```ts
verifyEnrollToken?: (
  token: string | undefined,
  principal: { installId; platform; channel; appVersion?; buildNumber? }
) => boolean | Promise<boolean>;
```

Validate the device's enroll session token against your IdP. Return `true` to allow the device to
register its public key. **In production, always provide this** so a device key can only be
registered by an authenticated user session. If omitted, enrollment falls back to a presence-only
check gated by `requireEnrollAuth`.

## `onConfirm`

```ts
onConfirm?: (event: {
  installId; bundleId; status; reason?; autoPaused: boolean;
}) => void;
```

Fires after every `/confirm` — feed adoption/health into your analytics or alerting. `autoPaused`
tells you when a confirm tripped the server-side auto-pause.

## `onPublish`

```ts
onPublish?: (event: {
  bundleId; platform; channel; bundleVersion; runtimeVersion; rolloutPercentage;
}) => void;
```

Fires after a successful `/admin/publish` — useful for audit logs and release notifications.

## `logger`

```ts
logger?: { info(m: string): void; warn(m: string): void; error(m: string): void };
```

Where the backend emits its own logs (enroll, publish, key registration). Defaults to no logging in
the middleware; pass `console` (or your structured logger) to see activity.

→ [Bring-your-own store](/docs/backend/store)
