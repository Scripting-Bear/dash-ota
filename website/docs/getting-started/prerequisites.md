---
sidebar_position: 2
title: Before you start
---

# Before you start

What you need for each of the three pieces.

## Your app

- React Native 0.79 or later with the New Architecture, which is the default from 0.76. Verified
  on 0.79 and 0.87.
- Hermes, the default engine. Updates ship as Hermes bytecode; an app on JSC can ship plain
  JavaScript instead.
- Android: minSdk 24 or higher. iOS: whatever your React Native version requires (15.1 for 0.79
  to 0.87).
- A place to keep a small install id between launches: AsyncStorage, MMKV or a secure store. Any
  object with `getItem` and `setItem` works.
- A way to run a release build on an emulator, simulator or device. Updates never apply to debug
  builds, because those load JavaScript from Metro.

## The CLI

- Node 20.19 or later. The zstd module the CLI compresses with requires it.
- It runs from your app's folder, because it uses your app's own `react-native` and `hermesc` to
  build update bundles. That's what keeps an update's bytecode in step with the Hermes inside your
  binary.

## The backend

- Node 20.19 or later. Express is optional: the middleware also works with Connect, Fastify and Koa,
  or on its own with `node:http`.
- Somewhere to keep releases. A directory on disk is enough to start; Postgres or SQLite, Redis and
  S3-compatible storage are built in for later.
- For real users: HTTPS, and a way for the backend to check that a device registering belongs to
  a signed-in user (your existing session tokens).

## What you need to know

Nothing about cryptography: the CLI signs and the app verifies without you writing any of it. The
one idea worth understanding first is the runtime version, which decides which builds an update
can reach. [Concepts & glossary](/docs/getting-started/concepts) covers it in a paragraph.

Next: [Ship your first update](/docs/getting-started/quickstart)
