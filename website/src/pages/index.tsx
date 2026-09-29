import { type ReactNode, useState } from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import LifecycleRail from '@site/src/components/landing/LifecycleRail';

/* ------------------------------------------------------------------ primitives */

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">{children}</span>
  );
}

function Section({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`mx-auto max-w-content px-5 sm:px-6 ${className}`}>{children}</section>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
      className={`absolute right-3 top-3 rounded border px-2 py-1 font-mono text-[11px] transition-colors ${
        done
          ? 'border-steel/50 bg-steel/10 text-steel'
          : 'border-line text-muted hover:border-muted hover:text-ink'
      }`}
      aria-label="Copy to clipboard"
    >
      {done ? 'copied' : 'copy'}
    </button>
  );
}

/** A terminal block. `out` lines are rendered as output, `$` lines as commands. */
function Terminal({ lines, copy }: { lines: string[]; copy?: string }) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-panel shadow-panel">
      {copy && <CopyBtn text={copy} />}
      <div className="flex items-center gap-1.5 border-b border-line px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-line" />
        <span className="h-2 w-2 rounded-full bg-line" />
        <span className="h-2 w-2 rounded-full bg-line" />
      </div>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-[1.75]">
        {lines.map((line, i) => {
          if (line.startsWith('$ ')) {
            return (
              <div key={i}>
                <span className="text-muted">$ </span>
                <span className="text-ink">{line.slice(2)}</span>
              </div>
            );
          }
          if (line.startsWith('#')) {
            return (
              <div key={i} className="text-muted">
                {line}
              </div>
            );
          }
          if (line.startsWith('✓')) {
            return (
              <div key={i} className="text-steel">
                {line}
              </div>
            );
          }
          return (
            <div key={i} className="text-ink/60">
              {line || ' '}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------ hero */

const HERO_TERMINAL = [
  '# one release, start to finish',
  '$ npx dash-ota bundle --platform android --out ./out --hermes',
  '✓ compiled Hermes bytecode (HBC): ./out/index.android.bundle',
  '',
  '$ npx dash-ota publish --bundle-dir ./out --channel prod --rollout 10',
  '  ✓ self-verified signature (sibling .public.json)',
  '',
  '  bundleId:        bnd_rt_9f2c1a_7_m1p4x9',
  '  encryption:      aes-256-gcm',
  '  uploading:       4 of 121 blobs (117 already present)   rollout: 10%',
  '✓ published to https://ota.yourapi.com',
];

function Hero() {
  return (
    <Section className="pb-16 pt-16 lg:pb-24 lg:pt-24">
      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14">
        <div>
          <Eyebrow>Over-the-air updates for React Native</Eyebrow>
          <h1 className="mt-4 font-display text-[2.6rem] font-bold leading-[1.05] tracking-tight text-ink sm:text-[3.4rem]">
            Ship JavaScript updates from infrastructure you own.
          </h1>
          <p className="mt-5 max-w-xl text-[16.5px] leading-relaxed text-ink/70">
            No vendor account, no per-seat pricing, and no third party holding the key that signs
            your releases. Run the backend on a container you already pay for.
          </p>

          <div className="mt-7 rounded-lg border border-line bg-panel/60 p-4">
            <div className="flex items-baseline gap-2">
              <span className="h-1.5 w-1.5 shrink-0 translate-y-[-2px] rounded-full bg-amber" />
              <p className="text-[14.5px] leading-relaxed text-ink/85">
                And the part nobody else does: your update server never holds the signing key, so
                even an attacker with root on it{' '}
                <span className="text-ink">cannot ship code to your users.</span>
              </p>
            </div>
          </div>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              to="/docs/getting-started/quickstart"
              className="rounded-md bg-amber px-5 py-2.5 font-display text-[15px] font-bold uppercase tracking-wide text-body transition-opacity hover:opacity-90 hover:text-body"
            >
              Ship your first update
            </Link>
            <Link
              to="/docs/"
              className="rounded-md border border-line px-5 py-2.5 text-[15px] text-ink transition-colors hover:border-muted hover:text-ink"
            >
              How it works
            </Link>
          </div>

          <p className="mt-5 font-mono text-[12px] text-muted">
            MIT · Android + iOS · React Native 0.79+ (New Architecture)
          </p>
        </div>

        <div className="w-full min-w-0">
          <Terminal
            lines={HERO_TERMINAL}
            copy="npx dash-ota bundle --platform android --out ./out --hermes"
          />
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ lifecycle */

function Lifecycle() {
  return (
    <Section className="py-14 lg:py-20">
      <div className="mb-6 max-w-2xl">
        <Eyebrow>What happens after you publish</Eyebrow>
        <h2 className="mt-3 font-display text-[1.9rem] font-bold tracking-tight text-ink">
          Every release is on trial until it proves itself.
        </h2>
        <p className="mt-3 text-[15.5px] leading-relaxed text-ink/70">
          Updates apply on a cold start, never under a running app. A bundle that fails to reach
          JavaScript twice is blocklisted and the last working one comes back, on the device,
          without a deploy.
        </p>
      </div>
      <LifecycleRail />
    </Section>
  );
}

/* ------------------------------------------------------------------ trust */

const CANNOT = [
  ['Forge a release', 'No signing key exists on the server. An edited manifest fails Ed25519 verification in native.'],
  ['Swap a file inside one', 'Every file carries its own SHA-256 in the signed manifest and is re-hashed after decryption.'],
  ['Move a build between channels', '`channel` and `appId` are signed, and checked against the values compiled into the binary.'],
  ['Push you backwards', '`bundleVersion` is monotonic. An older release is refused.'],
];

const CAN = [
  ['Stop serving updates', 'Silence is indistinguishable from "up to date". Alert on a pipeline that goes quiet.'],
  ['Re-serve a release you withdrew', 'Pause and rollback are server-side state, not signed facts.'],
  ['Choose where your update wall points', '`nativePolicy` sits outside the signature. Compile your store URLs into the app.'],
];

function Trust() {
  return (
    <Section className="py-14 lg:py-20">
      <div className="mb-8 max-w-2xl">
        <Eyebrow>Assume the worst case</Eyebrow>
        <h2 className="mt-3 font-display text-[1.9rem] font-bold tracking-tight text-ink">
          Someone has root on your update server.
        </h2>
        <p className="mt-3 text-[15.5px] leading-relaxed text-ink/70">
          This is the question most OTA tooling does not answer. Here is the honest version, in
          both directions.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-line bg-panel p-5 shadow-panel">
          <h3 className="font-display text-[13px] font-bold uppercase tracking-[0.12em] text-steel">
            They cannot
          </h3>
          <ul className="mt-4 space-y-4">
            {CANNOT.map(([title, body]) => (
              <li key={title}>
                <p className="text-[14.5px] font-semibold text-ink">{title}</p>
                <p className="mt-1 text-[13.5px] leading-relaxed text-ink/65">{body}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-alarm/25 bg-panel p-5 shadow-panel">
          <h3 className="font-display text-[13px] font-bold uppercase tracking-[0.12em] text-alarm">
            They still can
          </h3>
          <ul className="mt-4 space-y-4">
            {CAN.map(([title, body]) => (
              <li key={title}>
                <p className="text-[14.5px] font-semibold text-ink">{title}</p>
                <p className="mt-1 text-[13.5px] leading-relaxed text-ink/65">{body}</p>
              </li>
            ))}
          </ul>
          <Link
            to="/docs/security/breach"
            className="mt-5 inline-block font-mono text-[12px] text-amber hover:text-amber"
          >
            Read the full breach walkthrough →
          </Link>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ dashboard */

function Dashboard() {
  return (
    <Section className="py-14 lg:py-20">
      <div className="overflow-hidden rounded-lg border border-line bg-panel shadow-panel">
        <div className="grid gap-0 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="p-6 lg:p-8">
            <Eyebrow>Operate it</Eyebrow>
            <h2 className="mt-3 font-display text-[1.75rem] font-bold tracking-tight text-ink">
              A console that runs on your laptop.
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-ink/70">
              Publish, ramp a rollout, pause, roll back and set the force-update policy from a web
              UI — bound to <code className="font-mono text-[13px] text-steel">127.0.0.1</code>,
              gated by a token minted per launch, holding nothing.
            </p>
            <ul className="mt-5 space-y-2 text-[14px] text-ink/70">
              {[
                'Release table with adoption and rollout state',
                'Live publish log while it builds and uploads',
                'Typed confirmation on protected environments',
                'Read-only for any environment with no admin token',
              ].map((item) => (
                <li key={item} className="flex gap-2.5">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-steel" />
                  {item}
                </li>
              ))}
            </ul>
            <Link
              to="/docs/cli/dashboard"
              className="mt-6 inline-block rounded-md border border-line px-4 py-2 text-[14px] text-ink transition-colors hover:border-muted hover:text-ink"
            >
              Set up the dashboard
            </Link>
          </div>

          <div className="border-t border-line p-6 lg:border-l lg:border-t-0 lg:p-8">
            <Terminal
              lines={[
                '$ npx dash-ota dashboard',
                'dash-ota dashboard → http://127.0.0.1:4460/#t=8Kd2…',
                '  local only (127.0.0.1) · the link carries',
                "  this session's token · Ctrl+C to stop",
                '',
                '$ npx dash-ota list',
                'bnd_rt_9f2c1a_7  [android/prod]  v7  10%',
                '  adoption={"applied":412,"healthy":408,"failed":1}',
              ]}
              copy="npx dash-ota dashboard"
            />
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ install */

const TABS: Record<string, { label: string; lines: string[]; copy: string }> = {
  app: {
    label: 'Your app',
    lines: [
      "import AsyncStorage from '@react-native-async-storage/async-storage';",
      "import { DashOtaProvider } from 'react-native-dash-ota';",
      '',
      'export default function Root() {',
      '  return (',
      '    <DashOtaProvider',
      '      config={{',
      "        appVersion: '1.4.0',",
      '        storage: AsyncStorage,',
      '        getEnrollToken: () => api.otaEnrollToken(),',
      '      }}',
      '    >',
      '      <App />',
      '    </DashOtaProvider>',
      '  );',
      '}',
    ],
    copy: 'npm i react-native-dash-ota',
  },
  backend: {
    label: 'Your backend',
    lines: [
      "import express from 'express';",
      "import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';",
      '',
      'const app = express();',
      'app.use(express.json({ verify: rawBodySaver }));',
      '',
      '// Distributes pre-signed releases. Never holds a signing key.',
      'app.use(dashOtaMiddleware({',
      '  adminToken: process.env.OTA_ADMIN_TOKEN,',
      '  databaseUrl: process.env.OTA_DATABASE_URL,',
      '}));',
      '',
      'app.listen(4455);',
    ],
    copy: 'npm i @dash-ota/backend',
  },
  ci: {
    label: 'Your CI',
    lines: [
      '- name: Publish OTA',
      '  run: |',
      '    npx dash-ota bundle --platform android --out ./out --hermes',
      '    npx dash-ota publish --bundle-dir ./out \\',
      '      --app-id com.your.app --channel prod \\',
      '      --runtime-version auto --bundle-version ${{ github.run_number }} \\',
      '      --rollout 10',
      '  env:',
      '    OTA_ADMIN_TOKEN: ${{ secrets.OTA_ADMIN_TOKEN }}',
      '    OTA_KEY_PASSPHRASE: ${{ secrets.OTA_KEY_PASSPHRASE }}',
    ],
    copy: 'npx dash-ota publish --channel prod --rollout 10',
  },
};

function Install() {
  const [tab, setTab] = useState<keyof typeof TABS>('app');
  return (
    <Section className="py-14 lg:py-20">
      <div className="mb-6 max-w-2xl">
        <Eyebrow>Three pieces</Eyebrow>
        <h2 className="mt-3 font-display text-[1.9rem] font-bold tracking-tight text-ink">
          Drops into what you already have.
        </h2>
        <p className="mt-3 text-[15.5px] leading-relaxed text-ink/70">
          Autolinked on both platforms. One edit each in{' '}
          <code className="font-mono text-[13.5px] text-steel">MainApplication.kt</code> and{' '}
          <code className="font-mono text-[13.5px] text-steel">AppDelegate.swift</code> to point
          React Native at the OTA bundle — no ProGuard rule, no Podfile entry.
        </p>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {(Object.keys(TABS) as (keyof typeof TABS)[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-md border px-3.5 py-1.5 font-display text-[13px] font-bold uppercase tracking-wide transition-colors ${
              tab === key
                ? 'border-amber/50 bg-amber/10 text-amber'
                : 'border-line text-muted hover:border-muted hover:text-ink'
            }`}
          >
            {TABS[key].label}
          </button>
        ))}
      </div>

      <Terminal lines={TABS[tab].lines} copy={TABS[tab].copy} />
    </Section>
  );
}

/* ------------------------------------------------------------------ close */

function Close() {
  return (
    <Section className="pb-24 pt-10">
      <div className="rounded-lg border border-line bg-panel p-8 text-center shadow-panel">
        <h2 className="font-display text-[1.8rem] font-bold tracking-tight text-ink">
          Twenty minutes to your first signed update.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-[15.5px] leading-relaxed text-ink/70">
          Run a backend, make a key, wire the app, publish, and roll it back — with the exact
          output you should see at every step.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            to="/docs/getting-started/quickstart"
            className="rounded-md bg-amber px-5 py-2.5 font-display text-[15px] font-bold uppercase tracking-wide text-body transition-opacity hover:opacity-90 hover:text-body"
          >
            Start here
          </Link>
          <Link
            to="/docs/introduction/comparison"
            className="rounded-md border border-line px-5 py-2.5 text-[15px] text-ink transition-colors hover:border-muted hover:text-ink"
          >
            Compare with hot-updater and EAS
          </Link>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ page */

export default function Home(): ReactNode {
  return (
    <Layout
      title="Self-hosted OTA updates for React Native"
      description="Ship JavaScript updates from infrastructure you own. The CLI signs, the device verifies, and a breached server still cannot ship code to your users."
    >
      <main className="dash-landing dash-home bg-body font-sans text-ink">
        <Hero />
        <Lifecycle />
        <Trust />
        <Dashboard />
        <Install />
        <Close />
      </main>
    </Layout>
  );
}
