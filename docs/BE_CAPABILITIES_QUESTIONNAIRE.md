# dash-ota — Backend Capabilities Questionnaire (for the gotradeIndia BE team)

**Purpose.** Before we design the app-side OTA integration, we need to know what your backend
environment can actually run. Your answers to the questions below decide **which integration path**
we take (drop-in our Node service vs. you re-implement a small JSON spec in your existing stack) and
**which infrastructure providers** we wire. Please answer inline — "we can't" / "we'd rather not" is
a perfectly good answer; it just changes the path we pick, not whether this works.

**One paragraph of context.** dash-ota ships JavaScript-bundle updates over the air (no app-store
round trip) for our React Native app. The security-critical part — verifying a bundle is genuine —
happens **inside the app, natively, against a key baked into the binary at build time**. That means
**your backend never holds any signing key and can never forge a bundle**; it is a *distributor*. It
stores pre-signed bundles our CI produces, decides which device is eligible for which update, and
streams the encrypted bytes. The full wire contract is `PROTOCOL.md` (13 endpoints, JSON over HTTPS).
This questionnaire is only about *what you can host*, not about the crypto (that's already done and
on the device/CI side).

**Posture for this rollout.** We are replacing the app's current hosted OTA (react-native-stallion)
and we want the **maximally-hardened, fully-controllable** configuration — not the minimal one:
device-attestation-gated enrollment (works for logged-in **and** guest users), per-environment
signing keys and channel isolation, TLS pinning available, and full rollout control (staged rollout %,
pause, rollback, auto-pause on failure spikes, force-update policy). The questions below establish
what your infrastructure can support so we turn on exactly this, tuned to your stack.

---

## 0. TL;DR — the five answers that decide everything

If you only answer five things, answer these:

1. **Can you run a long-lived Node.js 18+ service?** (Yes → we hand you a package to deploy. No → you
   re-implement a ~13-endpoint JSON spec in your stack; we hand you `PROTOCOL.md` + a conformance test.)
2. **What database can this service use?** (Postgres / MySQL / SQLite-on-a-disk / other.)
3. **Is there a Redis (or equiv. shared cache) available?** (Needed *only* if the service runs on more
   than one instance behind a load balancer — see Q3.)
4. **Where can we put the encrypted bundle files, and how are they served to phones?** (S3/R2/GCS + a
   CDN? A disk on the box? Your existing file/CDN pipeline?)
5. **Can your backend verify a Play Integrity / App Attest token server-side, and validate the app's
   own session token?** OTA must serve **both logged-in and guest (not-logged-in) users**, so
   enrollment is gated by **device attestation** (works for guests) plus the session token when the
   user is logged in. This is the single security-critical integration point — see Q5.

Everything else below refines these.

---

## 1. Integration path — run our service, or re-implement the spec?

We support two paths; your infra decides which is less work **for you**.

- **Path A — Drop-in (recommended if you can run Node).** You deploy `@dash-ota/backend`, an Express
  middleware. You write essentially **one function** (`verifyEnrollToken`, Q5) and point it at a
  database + blob store. All eligibility/rollout/anti-replay/rate-limiting logic is ours, already
  tested.
- **Path B — Re-implement.** If Node isn't an option, you implement the `PROTOCOL.md` spec in your
  language/framework (Java/Kotlin/Go/Python/Node — any). It's small and fully specified: signature
  verification (ECDSA-P256 + Ed25519, both standard-library in every stack), a deterministic
  eligibility function, and one-time download tokens. We give you a conformance checklist and can
  provide test vectors.

**Q1.1** Can you run a persistent Node.js **18+** service (container / VM / PaaS)? → **Yes / No**
**Q1.2** If **No** to Node: what's your primary backend language + framework? (e.g. Spring Boot,
Django, Go/Gin, Laravel, NestJS.) ______
**Q1.3** Any hard constraint that rules out a *new* standalone service entirely — i.e. this must live
inside your existing monolith/API? → **Yes / No** — if Yes, describe: ______

> **What your answer decides:** Yes to Node + a new service ⇒ Path A, fastest. No to Node ⇒ Path B.
> "Must live in the monolith" is fine for either (Path A mounts as middleware on an existing Express
> app; Path B is native to your stack).

---

## 2. Database (release + install metadata)

The service stores small JSON-ish records: published releases (with rollout %, pause/rollback flags,
adoption counters), enrolled installs (device public key + channel), and trusted signing-key
fingerprints. Low write volume; the hot path is reads on `/check`.

**Q2.1** Which of these can this service use? (tick all that apply)
- [ ] **Postgres** (we have a first-class adapter — `jsonb`, atomic upserts, auto-creates its tables)
- [ ] **MySQL / MariaDB** (no built-in adapter yet — we'd write a thin one to the same interface, ~1 day)
- [ ] **SQLite on a persistent disk** (zero-server, ACID; great for a single node)
- [ ] **A disk directory only** (our default; fine for a single node, JSON files)
- [ ] Something else: ______

**Q2.2** If Postgres/MySQL: can we **create a few tables** (or a dedicated schema/database) for OTA, or
must we fit an existing one? → **Own tables OK / Must fit existing / Separate DB entirely**
**Q2.3** Rough scale: how many **active devices** will hit `/check`, and how often? (e.g. 50k DAU,
check on cold start.) ______

> **What your answer decides:** Postgres ⇒ we set `databaseUrl` and you're done. SQLite/disk ⇒
> single-node only (see Q3). MySQL ⇒ small adapter task on our side. Scale informs Q3 (do you need
> multiple instances at all?).

---

## 3. Shared cache (Redis) — only if you run more than one instance

The service keeps short-lived, TTL'd state: per-request anti-replay nonces, one-time download tokens,
server nonces, and rate-limit counters. On a **single instance** this lives in memory — nothing to
run. The moment the service runs on **two or more instances behind a load balancer**, that state must
be shared or the anti-replay/rate-limit guarantees weaken. That's what Redis is for.

**Q3.1** Will this service run on **one** instance or **multiple** (autoscaled / HA / multi-AZ)? →
**One / Multiple / Not sure yet**
**Q3.2** If Multiple (or likely to be): is a **Redis 6.2+** (or compatible: ElastiCache, Upstash,
Memorystore, KeyDB) available to it? → **Yes / No** — endpoint style: ______

> **What your answer decides:** One instance ⇒ **no Redis needed**, skip this. Multiple ⇒ Redis is
> required; we set `redisUrl` and it's handled. "Not sure" ⇒ we default to assuming multiple and ask
> for Redis, since it's cheap insurance.

---

## 4. Blob storage + delivery (the encrypted bundle bytes)

Each release is one encrypted archive (typically a few hundred KB to a few MB — the JS bundle +
changed assets, not the whole app). The service streams it to the device **only** via a one-time,
2-minute token — the phone never sees a storage URL. These bytes are already AES-256-GCM encrypted
**and** Ed25519-signed, so the storage layer is untrusted; it just needs to hold and serve bytes.

**Q4.1** Where can the encrypted bundles live? (tick all that apply)
- [ ] **S3** (built-in adapter)
- [ ] **Cloudflare R2 / MinIO / other S3-compatible** (same adapter, set an endpoint)
- [ ] **Google Cloud Storage / Azure Blob** (no built-in adapter — thin one to the same interface)
- [ ] **A persistent disk on the service host** (our default)
- [ ] Your existing artifact/CDN pipeline: ______

**Q4.2** Is there a **CDN** in front of your services we should/could serve downloads through, or do
downloads hit the service origin directly? → **CDN: ____ / Origin direct**
**Q4.3** Any max object size / bandwidth constraints we should design the bundle cap around? ______

> **What your answer decides:** S3-family ⇒ set `s3Bucket` (+ endpoint for R2/MinIO), streamed
> downloads, done. GCS/Azure ⇒ small adapter task. Disk ⇒ single-node, fine to start. CDN answer
> tells us whether to cache the download path or keep it strictly one-time-token at origin.

---

## 5. Auth — the one security-critical integration point ⚠️

This is the question that matters most. **OTA must serve both logged-in and guest (not-logged-in)
users** — a fresh install needs bundle updates before anyone signs in (the login screen itself lives
in the JS bundle). So enrollment **cannot** rely on a user session for everyone.

When a device enrolls it sends a freshly generated public key and an `installId`. We must stop an
attacker who knows a victim's `installId` from re-enrolling it (which would deny that device updates,
and let them poison rollout health metrics). Note: **nobody can ever forge a bundle** regardless — that
is guaranteed by native Ed25519 verification against a baked-in key. Enrollment gating only defends
those two abuse vectors. Our design, which needs your backend's help in **one hook**
(`verifyEnrollment`):

- **Guest (not logged in):** gate on **device attestation** — **Play Integrity** (Android) / **App
  Attest** (iOS). Proves a genuine, unmodified app on a real device, no account needed.
- **Logged in:** the app's **session token** is validated *in addition* (attestation still applies).
- **Anti-hijack (both):** first-enrollment-wins; rotating an install's key requires a signature from
  the prior key (or a matching session). The client uses a high-entropy, device-generated `installId`
  so it can't be pre-squatted.

Everything *after* enrollment is authenticated by the device's hardware key (no shared secret) — so
this hook is the only place your auth/attestation systems plug in.

**Q5.1 — Attestation (required for the guest path).** Can your backend **verify a Play Integrity
token (Android) and an App Attest / DeviceCheck assertion (iOS) server-side**? → **Yes / No / Only one
of them:** ______ (Do you already do this anywhere today? ______)
**Q5.2 — Session token (for the logged-in path).** How does the app authenticate a normal API request
today? → **JWT (bearer) / opaque session token / cookie / mTLS / other:** ______
**Q5.3** Given that session token, can your backend **synchronously validate it** (verify signature
*or* look it up) inside a function and return a stable **user id**? → **Yes / No** — how (JWKS, shared
JWT secret, introspection endpoint, session-table lookup)? ______
**Q5.4** For Path A (our Node service): can it reach what it needs — your **JWKS/introspection URL**
(session) and the **Play Integrity / App Attest verification** (Google Play Integrity API + Apple
App Attest, or your own wrapper)? → **Yes / details:** ______
**Q5.5** Policy per environment: is attestation-gated guest enrollment acceptable in **prod**, or do
you want prod locked to logged-in-only while dev/uat allow guests? → **Guests in all / Guests in
dev-uat only / Recommend for us**

> **What your answer decides:** This wires `verifyEnrollment` to your real auth **and** attestation.
> The guest path *depends* on server-side attestation verification (Q5.1) — if you can't verify
> Play Integrity / App Attest at all, guests can only be gated by weaker signals (rate-limit +
> first-write-wins) and we should discuss the residual risk explicitly. Session validation (Q5.2–5.4)
> via JWKS or a shared secret is the cleanest (stateless, no per-enroll network hop).

---

## 6. Environments & channels (dev / uat / prod)

The app builds in three flavours — **dev / uat / prod** — and an OTA update for one must **never**
reach another. In the protocol this is the `channel` field, enforced on eligibility.

**Q6.1** Do you want **one backend deployment** that serves all three channels (isolated by the
`channel` field + separate signing keys per env), or **separate deployments/DBs per environment**? →
**Single / Per-env / Recommend for us**
**Q6.2** Are dev/uat/prod already separate infra (DB, storage, hostnames) on your side today? ______

> **What your answer decides:** Whether we hand you one config with a channel dimension or three
> parallel configs. Financial-grade convention leans toward at least prod being fully isolated
> infra + its own signing key; we'll recommend based on your answer.

---

## 7. Signing keys, secrets & CI (whose CI signs releases)

Bundles are signed by our **release CI**, not the backend. The backend only stores the matching
**public** keys (via an admin call) and an **admin token** to authorize publishes. So you need a place
for two non-signing secrets: the admin token, and (for Path A) whatever `verifyEnrollToken` needs.

**Q7.1** What secret store backs this service? (env vars / Vault / AWS Secrets Manager / GCP Secret
Manager / K8s secrets / other) ______
**Q7.2** Which CI runs the app's release builds today (where we'd add the bundle-sign+publish step)?
(GitHub Actions / GitLab CI / Bitrise / Jenkins / Codemagic / other) ______
**Q7.3** Do you have a **KMS/HSM** we could optionally hold the *signing* key in later? (Not required
for v1 — CI holds a passphrase-encrypted key by default.) → **Yes: ____ / No**

> **What your answer decides:** Where the admin token + enroll-validation secrets live, and which CI
> we add the sign-and-publish step to. KMS is a nice-to-have for later hardening, not a blocker.

---

## 8. Deployment, TLS & networking

**Q8.1** How would this service be deployed? (Kubernetes / ECS/Fargate / plain VM / Render/Railway/Fly
/ serverless functions / other) ______
**Q8.2** TLS: terminated at a load balancer / API gateway in front, or by the service itself? →
**LB/gateway / self** (protocol is **HTTPS-only**; plain HTTP is refused outside dev)
**Q8.3** Health checks: can your orchestrator hit `GET /health` (liveness) and `GET /ready`
(readiness)? → **Yes / constraints:** ______
**Q8.4** Any egress restrictions the service will face (e.g. can it call your auth JWKS/introspection
endpoint, reach S3/Redis)? ______

> **What your answer decides:** Serverless/functions change the "single vs multiple instance" and cold
> cache story (⇒ almost certainly Redis, Q3). LB-terminated TLS is the norm and fine.

---

## 9. Observability & ops

**Q9.1** Logging/metrics/alerting stack the service should emit into? (Datadog / Grafana+Prometheus /
CloudWatch / ELK / other) ______
**Q9.2** Who operates rollouts day-to-day — set rollout %, pause a bad release, roll back? Do you want
an **admin API only**, or a small **web console** UI for it? → **API only / Console** (console exists
but is optional)
**Q9.3** Alerting: should a rollout **auto-pause** on a failure-rate spike (built in), and where should
that alert go? ______

> **What your answer decides:** How we surface adoption/health metrics and whether we stand up the
> optional admin console for your ops team.

---

## 10. Migration from the current OTA (react-native-stallion)

The app ships OTA **today via react-native-stallion** (a hosted service). Moving to dash-ota is a
client-library swap + your new backend; there's no data to migrate (device keys are minted fresh on
first enroll), but the cutover needs sequencing so live users aren't stranded mid-release.

**Q10.1** Are there constraints on running **both** briefly during cutover, or do we hard-switch per
env (dev → uat → prod)? ______
**Q10.2** Any contractual/timeline constraint on decommissioning Stallion we should plan around? ______

> **What your answer decides:** The rollout order and whether we build a dual-run shim. Our default
> plan: stand up backend → ship dev-channel client → validate → promote uat → prod, then retire
> Stallion per env.

---

## Appendix — the exact backend surface (for reference)

If it helps your team scope Path B (re-implement), the full backend is **13 HTTP endpoints**:

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health`, `GET /ready` | none | liveness / readiness |
| `POST /ota/v1/enroll` | **your session token → `verifyEnrollToken`** | register device public key |
| `POST /ota/v1/check` | device key (ECDSA-P256) | return the eligible update (or none) |
| `GET /ota/v1/download` | one-time token | stream the encrypted bundle |
| `POST /ota/v1/confirm` | device key | report apply outcome (drives auto-pause) |
| `POST /admin/keys` | admin token | register a trusted signing **public** key |
| `POST /admin/publish` | admin token | verify sig + hash, store a pre-signed release |
| `GET /admin/releases` | admin token | list releases + rollout/adoption state |
| `POST /admin/rollout` \| `/pause` \| `/rollback` \| `/native-policy` | admin token | ops controls |

The server enforces a **deterministic eligibility function** (exact `runtimeVersion` match → downgrade
guard → targeting → rollout bucket) and **holds no signing key**. That's the whole contract; full
detail in `PROTOCOL.md`.

---

*Return this with answers (even partial) and we'll produce the tailored implementation doc + the
app-side integration plan shaped to exactly what you can run.*
