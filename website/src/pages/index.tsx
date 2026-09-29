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

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[0.92em] text-steel">{children}</code>;
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
  '# in your app, with a dash-ota backend on localhost:4455 and',
  '# OTA_ADMIN_TOKEN and OTA_KEY_PASSPHRASE set in your shell',
  '$ npm i -D @dash-ota/cli',
  '$ npx dash-ota keygen --register',
  '✓ wrote keypair to .keys/key_dev_1.*',
  '✓ registered key_dev_1 with http://localhost:4455',
  '',
  '$ npx dash-ota bundle --platform android --out ./out --hermes',
  '',
  '$ npx dash-ota publish --bundle-dir ./out --app-id com.example.app --runtime-version rt1 --bundle-version 2',
  '  ✓ self-verified signature (.keys/key_dev_1.public.json)',
  '  bundleId:        bnd_rt1_2_mumketyh',
  '  uploading:       1 of 1 blobs (0 already present)   rollout: 100%',
  '✓ published to http://localhost:4455: {"ok":true,"bundleId":"bnd_rt1_2_mumketyh","rolloutPercentage":100,"already":false}',
];

/** The commands a terminal shows, one per line, for its copy button. */
function commandsIn(lines: string[]): string {
  return lines
    .filter((line) => line.startsWith('$ '))
    .map((line) => line.slice(2))
    .join('\n');
}

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
            The backend runs on a server you already pay for, and no vendor service sits between
            your CI and your users’ devices.
          </p>

          <div className="mt-7 rounded-lg border border-line bg-panel/60 p-4">
            <div className="flex items-baseline gap-2">
              <span className="h-1.5 w-1.5 shrink-0 translate-y-[-2px] rounded-full bg-amber" />
              <p className="text-[14.5px] leading-relaxed text-ink/85">
                Signing can’t be switched off: every release is signed in your CI and checked by
                native code in the app. The update server never holds the signing key, so an
                attacker with root on it{' '}
                <span className="text-ink">cannot ship their own code to your users.</span>
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

          <p className="mt-5 text-[13.5px] leading-relaxed text-ink/60">
            New to OTA updates? Start with{' '}
            <Link to="/docs/getting-started/what-is-an-ota-update" className="text-amber hover:text-amber">
              what an OTA update is
            </Link>
            , then check the{' '}
            <Link to="/docs/getting-started/prerequisites" className="text-amber hover:text-amber">
              prerequisites
            </Link>
            .
          </p>

          <p className="mt-4 font-mono text-[12px] text-muted">
            MIT · Android + iOS · React Native 0.79+ (New Architecture)
          </p>
        </div>

        <div className="w-full min-w-0">
          <Terminal
            lines={HERO_TERMINAL}
            copy={commandsIn(HERO_TERMINAL)}
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
          An update applies on the next cold start, or when your app asks for a restart. It stays
          on trial until your app calls <Code>markHealthy()</Code>. A launch that crashes counts
          against it; a session that reached JavaScript and went to the background doesn’t. If
          it is still on trial at its third launch, the device disables it and goes back to the
          last working bundle, without a deploy.
        </p>
      </div>
      <LifecycleRail />
    </Section>
  );
}

/* ------------------------------------------------------------------ trust */

const CANNOT: [string, ReactNode][] = [
  [
    'Forge a release',
    'The server has no signing key. A manifest it edits fails Ed25519 verification in native code, before anything is written.',
  ],
  [
    'Swap a file inside one',
    'Every file’s SHA-256 is in the signed manifest, and native code re-hashes each file after decrypting it.',
  ],
  [
    'Move a build to another app or channel',
    <>
      <Code>appId</Code> and <Code>channel</Code> are signed. The device checks <Code>appId</Code>{' '}
      against its own package or bundle id and, from 0.5.1, <Code>channel</Code> against the value
      compiled into the binary.
    </>,
  ],
  [
    'Install an older bundle over a newer one',
    <>
      Native code refuses a <Code>bundleVersion</Code> that isn’t higher than the bundle running now.
    </>,
  ],
];

const CAN: [string, ReactNode][] = [
  [
    'Stop serving updates',
    'A device can’t tell silence from “up to date”. Alert when your release pipeline goes quiet.',
  ],
  [
    'Re-serve an older or withdrawn release',
    <>
      Anything you signed stays valid, and pause and rollback are server state. The downgrade check
      compares only with what runs now, so after a store update, a <Code>rollback()</Code> or a
      crash-loop revert, an older signed release can install again.
    </>,
  ],
  [
    'Force a hard update prompt',
    <>
      <Code>nativePolicy</Code> isn’t signed. A breached server can send severity{' '}
      <Code>hard</Code> to every install, and if your app shows that as a blocking screen, users are
      locked out while it lasts. From 0.5.0 the store link comes from your app’s config, not the server.
    </>,
  ],
  [
    'Read your bundles',
    'The content key is in the manifest the server stores and returns to enrolled devices, so encryption doesn’t hide bundles from whoever runs the server.',
  ],
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
          What root on your server does and doesn’t allow:
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
              UI bound to <code className="font-mono text-[13px] text-steel">127.0.0.1</code> and
              gated by a token minted per launch. It talks only to the backends in its config file,
              and that file holds your key paths and admin tokens.
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
                '# with dash-ota.config.mjs in the project and OTA_ADMIN_TOKEN set',
                '$ npx dash-ota dashboard',
                'dash-ota dashboard → http://127.0.0.1:4460/#t=…',
                "  local only (127.0.0.1) · the link carries this session's token · Ctrl+C to stop",
                '',
                '$ npx dash-ota list',
                'bnd_rt1_2_mumketyh  [android/dev]  rt=rt1 v2  100%  adoption={"applied":1,"healthy":1,"failed":0,"rolled_back":0}',
                '$ npx dash-ota rollback --bundle-id bnd_rt1_2_mumketyh',
                '✓ release rolled back (paused + flagged)',
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

const TABS: Record<string, { label: string; lines: string[] }> = {
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
      '        // your own API: a session token the backend checks in verifyEnrollToken',
      '        getEnrollToken: () => api.otaEnrollToken(),',
      '      }}',
      '    >',
      '      <App />',
      '    </DashOtaProvider>',
      '  );',
      '}',
    ],
  },
  backend: {
    label: 'Your backend',
    lines: [
      "import express from 'express';",
      "import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';",
      '',
      'const app = express();',
      '// Request signatures cover the raw body, and a release manifest can',
      '// be larger than express.json\'s default 100 kB limit.',
      "app.use(express.json({ limit: '1mb', verify: rawBodySaver }));",
      '',
      '// Distributes pre-signed releases. Never holds a signing key.',
      'app.use(dashOtaMiddleware({',
      '  adminToken: process.env.OTA_ADMIN_TOKEN,',
      '  databaseUrl: process.env.OTA_DATABASE_URL,',
      '  // your own session check; by default any non-empty token enrolls',
      '  verifyEnrollToken: (token) => sessions.isValid(token),',
      '}));',
      '',
      'app.listen(4455);',
    ],
  },
  ci: {
    label: 'Your CI',
    lines: [
      '# after checkout and npm ci, with @dash-ota/cli in devDependencies',
      '- name: Publish OTA',
      '  run: |',
      '    mkdir -p .keys',
      '    echo "$OTA_SIGNING_KEY" > .keys/key_prod.private.pem',
      '    npx dash-ota bundle --platform android --out ./out --hermes',
      '    npx dash-ota publish --bundle-dir ./out \\',
      '      --app-id com.your.app --channel prod --key-id key_prod \\',
      '      --runtime-version rt1 --bundle-version ${{ github.run_number }} \\',
      '      --rollout 10',
      '  env:',
      '    OTA_SERVER: ${{ secrets.OTA_SERVER }}',
      '    OTA_ADMIN_TOKEN: ${{ secrets.OTA_ADMIN_TOKEN }}',
      '    OTA_SIGNING_KEY: ${{ secrets.OTA_SIGNING_KEY }}',
      '    OTA_CONTENT_KEY: ${{ secrets.OTA_CONTENT_KEY }}',
      '    OTA_KEY_PASSPHRASE: ${{ secrets.OTA_KEY_PASSPHRASE }}',
    ],
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
          <code className="font-mono text-[13.5px] text-steel">AppDelegate.swift</code> points
          React Native at the OTA bundle, and the channel, server URL, public key and runtime
          version go in string resources on Android and <Code>Info.plist</Code> on iOS. The
          library ships its own ProGuard rules and needs no Podfile entry.
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

      <Terminal lines={TABS[tab].lines} copy={TABS[tab].lines.join('\n')} />
    </Section>
  );
}

/* ------------------------------------------------------------------ close */

function Close() {
  return (
    <Section className="pb-24 pt-10">
      <div className="rounded-lg border border-line bg-panel p-8 text-center shadow-panel">
        <h2 className="font-display text-[1.8rem] font-bold tracking-tight text-ink">
          Your first signed update, end to end.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-[15.5px] leading-relaxed text-ink/70">
          The quickstart runs a backend, makes a key, wires the app, publishes and rolls back, and
          shows the output to expect at each step. New to OTA updates? Read{' '}
          <Link to="/docs/getting-started/what-is-an-ota-update" className="text-amber hover:text-amber">
            what an OTA update is
          </Link>{' '}
          and the{' '}
          <Link to="/docs/getting-started/prerequisites" className="text-amber hover:text-amber">
            prerequisites
          </Link>{' '}
          first.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            to="/docs/getting-started/quickstart"
            className="rounded-md bg-amber px-5 py-2.5 font-display text-[15px] font-bold uppercase tracking-wide text-body transition-opacity hover:opacity-90 hover:text-body"
          >
            Start the quickstart
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
      description="Self-hosted OTA updates for React Native. Every release is signed in your CI and verified on the device, so a breached update server cannot ship its own code to your users."
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
