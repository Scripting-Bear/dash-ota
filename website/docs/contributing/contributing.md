---
sidebar_position: 1
title: Contributing
slug: /contributing
---

# Contributing

dash-ota is MIT and open to contributions. Source:
[github.com/Scripting-Bear/dash-ota](https://github.com/Scripting-Bear/dash-ota).

## Monorepo layout

```
packages/
  rn/        react-native-dash-ota   (client: JS + native Android/iOS + example app)
  cli/       @dash-ota/cli           (signing + release tooling)
  backend/   @dash-ota/backend       (distributor: Express middleware + standalone)
  shared/    @dash-ota/shared        (crypto/protocol core)
website/     this documentation site (Docusaurus)
```

## Dev setup

```bash
npm install
npm run test:core      # crypto/protocol self-test
npm run test:e2e       # backend e2e (publish → check → download → verify+decrypt)
npm run test:express   # Express-adapter smoke test
npm run typecheck
```

The RN package is a separate yarn-4 project under `packages/rn` (`yarn` there for the example app).

## The example app

`packages/rn/example` is a full dev/uat/prod demo. Build a **release** flavour to exercise OTA
(debug uses Metro). `scripts/publish-ota.mjs` runs bundle → hermesc → publish in one step.

## Running the docs site

```bash
cd website
npm install
npm start          # http://localhost:3000/dash-ota/
npm run build      # production build (checks for broken links)
```

## Guidelines

- Keep the **trust split** intact: trust-critical work stays in native; JS only orchestrates.
- Add **TSDoc** (`@param` / `@returns` / `@example`) to exported APIs — it feeds the API reference.
- Run typecheck + the test suites before opening a PR.

→ [Roadmap](/docs/contributing/roadmap)
