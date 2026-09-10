# Upgrading to dash-ota 0.4

0.4 changes the wire format. **Old and new clients cannot share a release**, so the app and the
backend move together, and the app change is native — it needs a store build, not an OTA.

For backend operators the upgrade is small: bump one dependency, redeploy, and check three proxy
settings. There is no schema migration and no data to convert.

---

## What changed

An update used to be **one encrypted archive**. Every release re-sent the whole payload, however
small the change.

0.4 splits a release into **one blob per distinct file**, each named by a hash of its contents. A
device downloads only the files it does not already hold, and the server stores a file that several
releases share exactly once.

Measured on a real 121-file React Native app:

| | 0.3 | 0.4 |
|---|---|---|
| first install of a release | 27.9 MB | **9.4 MB** |
| a release changing a few screens | 27.9 MB | **a few hundred KB** |
| two releases differing by one asset | two full payloads | **one copy of each distinct file** |

## Backend

```bash
npm i @dash-ota/backend@^0.4.0
```

Redeploy. That is the whole change if you mounted the middleware as documented.

Then check three things, because the download path changed shape:

1. **Do not buffer the blob route.** `GET /ota/v2/releases/:bundleId/blobs/:sha` streams and serves
   `Range` so an interrupted download resumes. Nginx: `proxy_buffering off;` for that location.
2. **Uploads are streamed `PUT`s, not JSON.** Mount the OTA middleware **before** any global
   `express.json()`, or the body is consumed before it reaches the handler.
3. **Blobs are immutable — cache them.** They are content-addressed and already carry `ETag` and
   `Cache-Control: immutable`. A CDN in front of that route is the biggest available win and needs
   no invalidation strategy.

### The one operational rule

Blobs are keyed **globally by content hash**, not per release.

> **Never delete blobs by release prefix.** The store handles retention itself and only removes a
> blob no other release still references. A prefix delete corrupts live releases.

## CLI

`publish` now requires `--app-id` — the package name or bundle id. The device refuses a manifest
built for a different app, which is what stops a staging bundle from applying to a production
install.

It also needs a **content key per channel**, written by `keygen` next to the signing key and reused
for every release on that channel. Convergent encryption is what lets the store keep one copy of a
shared file; a fresh key per release still produces a valid release while silently re-uploading
everything, so a missing key is a hard error rather than a generated one.

```bash
dash-ota keygen --key-id key_prod_1      # now also writes key_prod_1.content.key — keep it
dash-ota publish --app-id com.example.app --bundle-dir ./out …
```

Publishing is three requests instead of one: declare, upload what is missing, finalize. A release is
invisible to devices until finalize, so an interrupted publish is safe to re-run. A finalized
release is **immutable** — re-publishing the same `bundleId` returns `409`.

## App

```bash
npm i react-native-dash-ota@^0.4.0
```

Then rebuild natively: `pod install` on iOS, a Gradle sync on Android. **This cannot ship as an
OTA** — the client change is native code.

- **Android** pulls in `zstd-jni` (pinned 1.5.7-4, 16 KB page aligned on all four ABIs).
- **iOS** compiles a vendored, decompress-only zstd, because Apple's Compression framework has none.
  Its symbols are renamed so it cannot collide with a libzstd your app already links. Nothing to
  configure.

Nothing in the JavaScript API changed.

## Monitoring

Auto-pause is unchanged and still compares failures against all reported outcomes.

All four adoption counters are now populated. The client reports **`applied`** on the launch that
promotes a bundle, **`healthy`** once it survives its trial, **`failed`** when the crash-loop breaker
reverts one, and **`rolled_back`** when a user reverts by hand.

Before 0.4 only `healthy` and `failed` were ever sent, so `applied` sat at `0` however many devices
took a release — a release that applied everywhere and then crashed everywhere showed no adoption at
all rather than a cliff. If you built a dashboard around that, it will start reporting real numbers.
`rolled_back` also counts toward the auto-pause failure rate now, so a release people actively back
out of no longer looks healthy.

## Rolling out

Deploying the 0.4 backend makes `/ota/v1/*` return a tombstone: installed 0.3 apps stop receiving
updates and are told to update from the store. They keep running whatever bundle they already have,
so nothing breaks — but they are frozen until a store build reaches them. Those requests are counted
per channel and platform so you can watch that population drain:

```sql
select * from ota_retired_clients;
```

The usual order is: ship the 0.4 store build, wait for adoption, then deploy the 0.4 backend. If you
deploy the backend first, plan for the gap.
