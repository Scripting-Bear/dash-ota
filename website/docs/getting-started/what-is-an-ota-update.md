---
sidebar_position: 1
title: If you've never shipped an OTA update
description: What an over-the-air update is, what it can and cannot change, and the three ideas you need before starting.
---

# If you've never shipped an OTA update

Start here if "OTA" is a new idea. If you have used CodePush, Stallion or EAS Update, skip to
[Before you start](/docs/getting-started/prerequisites).

## The problem it solves

A React Native app is two things bolted together: a **native binary** (Kotlin and Swift, the
libraries you installed, the React Native runtime itself) and a **JavaScript bundle** (your
components, your screens, your business logic).

Normally both ship together through the App Store and Play Store. You fix a typo, you submit a
build, you wait for review, and some of your users update next week and some never do.

But the typo was in the JavaScript. The native binary did not change at all.

An over-the-air update takes advantage of that. It ships a **new JavaScript bundle** to apps that
are already installed, without going through the stores. The app downloads it, and the next time it
starts cold, it runs the new JavaScript inside the same native binary.

## What it can and cannot change

Read this part before anything else.

| Changed in JavaScript only | Needs a store release |
|---|---|
| Screens, components, styles | Adding or upgrading a native library |
| Business logic, API calls | Changing permissions or entitlements |
| Copy, translations, images bundled with JS | Anything in Kotlin, Swift, Gradle or the Podfile |
| Feature flags, config | Upgrading React Native itself |

If you `npm install` something with native code, an OTA cannot deliver it. The JavaScript that
expects it would be talking to a native module that is not in the binary, and the app would crash.

dash-ota guards against that with a **runtime version**: a name for each native build, compiled
into the app and stamped on every update. A device only installs an update whose runtime version
matches its own exactly. It works as long as the runtime version changes whenever native code does:
change it by hand, or let the CLI compute one from your project. When a fix needs a new binary, the
[force-update gate](/docs/concepts/force-update) tells older binaries to go to the store.

## The three ideas

Everything else builds on these.

**A release is a signed bundle.** When you publish, the CLI on your machine bundles your
JavaScript, encrypts it, and signs it with a private key that only you hold. The app trusts the
signature, whichever server the update came through.

**The server only carries bytes.** dash-ota's backend stores releases and hands them out. It never
has the signing key, so it cannot create a release. If someone takes over your update server,
they still can't ship their code to your users. (They can hold updates back or show an update
prompt; [the breach page](/docs/security/breach) lists everything.)

**Updates apply on a cold start.** A downloaded update does not swap in while someone is using the
app. It is staged on disk and applied the next time the app starts from scratch. If the new bundle
crashes on two cold starts before your app marks it healthy, dash-ota goes back to the last one
that worked and reports it. You don't have to build that safety net yourself.

## How a single update actually goes

1. You change some JavaScript and run `npx dash-ota bundle`, then `npx dash-ota publish`.
2. The CLI bundles it, compresses and encrypts each file, signs the description of the release,
   and uploads it. Files that have not changed since the last release are not uploaded again.
3. An app starts, asks the server whether there is anything new, and is offered the release.
4. The app downloads only the files it does not already have, checks the signature **in native
   code** against a key compiled into the binary, verifies every file's hash, and stages it.
5. On the next cold start, the app runs the new bundle. Once your first screen works, your app
   calls `markHealthy()` and the update is confirmed. If it crashes on two cold starts first, the
   app puts the old bundle back.

You can ship to 10% of installs first, watch the failure rate, then ramp up or pull it.

## What you need

A React Native app with the New Architecture on, Node 20.19 or newer, and somewhere to run a small
Node service. That service can be a single container to start with; you do not need Postgres or
object storage until you have more than one instance.

→ [Before you start](/docs/getting-started/prerequisites) ·
[Ship your first update](/docs/getting-started/quickstart) ·
[The vocabulary](/docs/getting-started/concepts)
