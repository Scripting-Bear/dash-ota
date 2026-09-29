import type { ReactNode } from 'react';

/**
 * Premium feature-comparison matrix for the docs (replaces the emoji markdown table).
 * Icon-based cells, a highlighted dash-ota column, and a legend — styled to match the
 * Stitch docs design. Wrapped in `.dash-landing` so the scoped Tailwind utilities apply.
 *
 * Each cell is encoded `status` or `status:note` ('y' yes · 'p' partial · 'n' no).
 * Cells with a note expose it on hover (native title, never clipped by the scroll box);
 * partial cells additionally get a dotted "hover me" underline.
 */

const COLS = ['dash-ota', 'Stallion', 'hot-updater', 'CodePush', 'expo-updates'] as const;

const ROWS: { cap: string; key?: boolean; cells: string[] }[] = [
  {
    cap: 'Self-hosted backend',
    cells: [
      'y:You run it: Express middleware or a standalone server',
      'p:Managed service; on-prem is plan-gated',
      'y:Your own storage and database (Supabase, Cloudflare, AWS, Firebase and others)',
      'p:Only as the standalone code-push-server; App Center retired on 31 Mar 2025 and the server repo was archived in May 2025',
      'p:EAS-hosted; you can proxy requests through your own server or implement the open Expo Updates protocol',
    ],
  },
  {
    cap: 'Open source',
    cells: [
      'y:MIT, all four packages',
      'p:SDK (MIT) and CLI are open source; the service is proprietary',
      'y:MIT',
      'y:MIT; the standalone server repo is archived',
      'y:expo-updates is MIT and the protocol is open; EAS is a paid service',
    ],
  },
  {
    cap: 'Signed bundles, verified on device',
    cells: [
      'y:Ed25519-signed manifest, checked in native against keys compiled into the binary',
      'y:SHA256withRSA, verified by the SDK on device',
      'y:RSA-SHA256 since v0.23.0 (Nov 2025)',
      'y:Code signing since CLI 2.1.0 (--privateKeyPath)',
      'y:X.509 code signing; on EAS it needs a Production or Enterprise plan',
    ],
  },
  {
    cap: 'Signing mandatory (no unsigned mode)',
    key: true,
    cells: [
      'y:Every release is signed by the CLI and verified in native; the backend never has the key',
      'p:Opt-in; the CLI signs locally and uploads the bundle and its signature',
      'p:Opt-in; once a public key is configured, unsigned bundles are rejected',
      'p:Opt-in; the CLI signs with your private key',
      'p:Opt-in; the private key stays with you',
    ],
  },
  {
    cap: 'Payload encryption (AES-256-GCM)',
    cells: [
      'y:Per file. Hides blobs from anyone who can read only your storage; the backend and enrolled devices can decrypt',
      'n',
      'n',
      'n',
      'n',
    ],
  },
  {
    cap: 'Device-key request auth',
    key: true,
    cells: [
      'y:Per-install key in Android Keystore or the Secure Enclave; iOS falls back to a software key unless OTA_REQUIRE_HARDWARE_KEY is set',
      'n',
      'n',
      'n',
      'n',
    ],
  },
  {
    cap: 'Anti-replay (nonce + timestamp)',
    key: true,
    cells: [
      'y:Signed requests carry a timestamp and a random client nonce; the server refuses a nonce it has seen',
      'n',
      'n',
      'n:Update checks send only the deployment key, app version and package hash',
      'n:The Expo Updates protocol defines no request nonce',
    ],
  },
  {
    cap: 'No bucket URL on the client',
    cells: [
      'y:Blobs stream through your API with a download token scoped to one release; no CDN in the path',
      'n',
      'n:Client fetches a signed URL',
      'n',
      'n',
    ],
  },
  {
    cap: 'Native-compatibility gate',
    cells: [
      'y:runtimeVersion, enforced on the backend and in native',
      'p:Target app versions',
      'y:Fingerprint strategy, embedded in the binary',
      'p:targetBinaryVersion (semver range)',
      'y:Runtime version',
    ],
  },
  { cap: 'Channels (dev / uat / prod)', cells: ['y:Per-channel signing key + channel', 'y', 'y', 'y:Deployments', 'y:Branches and channels'] },
  {
    cap: 'Switch channel at runtime (QA)',
    cells: [
      'n:The channel is compiled into the binary',
      'y:In-app testing modal',
      'y:Runtime channel switch',
      'y:deploymentKey option on sync() and checkForUpdate()',
      'y:"Channel surfing"',
    ],
  },
  { cap: 'Staged rollout %', cells: ['y:Deterministic install-id bucketing', 'y', 'y', 'y', 'y:Per-update or per-branch'] },
  {
    cap: 'Binary patches for a changed bundle',
    cells: [
      'n:Unchanged files are not downloaded again, but a changed JS bundle downloads whole',
      'y:"Up to 98% smaller"; Pro plan and up',
      'y:e.g. a 10 MB archive becomes a ~600 KB patch',
      'n:Only files that changed are downloaded',
      'y:Bundle diffing, on by default from SDK 56',
    ],
  },
  {
    cap: 'Automatic rollback on a failed boot',
    cells: [
      'y:Two charged launches without markHealthy() disable the bundle; the device reverts to last-known-good, then the embedded bundle',
      'y:Detects crashes and reverts automatically',
      'y:Recovers to a working bundle if startup fails',
      'y:Automatic rollback in the SDK',
      'y:Error recovery returns to the last update that launched successfully and does not launch the failed one again',
    ],
  },
  {
    cap: 'Server-side auto-pause on failure rate',
    key: true,
    cells: [
      'y:On by default: pauses once 20% of at least 5 device reports are failures',
      'p:Manual pause in the dashboard stops new downloads',
      'p:Manual rollback and a force-update flag in the console',
      'p:Manual, with code-push-standalone rollback or patch; no dashboard since App Center retired',
      'p:Manual, with eas update:rollback',
    ],
  },
  {
    cap: 'Force-update to the app store',
    cells: [
      'y:Server sends soft or hard severity from a minimum native build; your app renders the prompt',
      'p:Not documented as a store gate',
      'p:Force-applies a JS update; not a store gate',
      'n',
      'p:Build it yourself',
    ],
  },
  {
    cap: 'Hosted service with a free tier',
    cells: [
      'n:Self-host only',
      'y:Free up to 10K MAU',
      'n:Self-hosted on your own providers',
      'n:App Center retired on 31 Mar 2025',
      'y:Free up to 1K MAU',
    ],
  },
  {
    cap: 'Release CLI',
    cells: [
      'y:@dash-ota/cli (command: dash-ota)',
      'y:stallion-cli (stallion publish-bundle)',
      'y:npx hot-updater',
      'y:code-push-standalone; the old appcenter codepush CLI no longer works',
      'y:EAS CLI',
    ],
  },
  { cap: 'New Arch + Hermes (RN 0.79+)', cells: ['y', 'y', 'y', 'p:Community forks only', 'y'] },
];

const LICENSE = [
  'MIT, self-hosted',
  'MIT SDK and CLI, proprietary service',
  'MIT',
  'MIT; App Center retired 31 Mar 2025',
  'MIT client; paid EAS service with a free tier',
];

const Sym = ({ name, className }: { name: string; className: string }) => (
  <span className={`material-symbols-outlined ${className}`} style={{ fontSize: 20 }} aria-hidden>
    {name}
  </span>
);

function Cell({ raw, head }: { raw: string; head: boolean }): ReactNode {
  const i = raw.indexOf(':');
  const s = (i === -1 ? raw : raw.slice(0, i)) as 'y' | 'p' | 'n';
  const note = i === -1 ? undefined : raw.slice(i + 1);
  const base = `flex items-center justify-center py-3.5 border-t border-border ${head ? 'bg-accent/[0.06]' : ''} ${
    note ? 'cursor-help' : ''
  }`;
  const icon =
    s === 'y' ? (
      <Sym name="check" className="text-accent" />
    ) : s === 'p' ? (
      <Sym name="remove" className="text-[#F4BF4F]" />
    ) : (
      <Sym name="close" className="text-muted/40" />
    );
  const label = s === 'y' ? 'Yes' : s === 'p' ? 'Partial' : 'No';
  return (
    <div className={base} title={note ? `${label} — ${note}` : undefined}>
      <span className={s === 'p' && note ? 'border-b border-dotted border-[#F4BF4F]/60 leading-none' : 'leading-none'}>
        {icon}
      </span>
      <span className="sr-only">{note ? `${label}: ${note}` : label}</span>
    </div>
  );
}

export default function ComparisonMatrix(): ReactNode {
  return (
    <div className="dash-landing" style={{ background: 'transparent', margin: '1.5rem 0 2rem' }}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <span className="text-xs font-semibold tracking-wider uppercase text-muted">Feature matrix</span>
        <span className="text-[11px] font-mono text-muted px-2 py-1 rounded-md border border-border bg-surface">
          Last verified · September 2026
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <div className="min-w-[720px]">
          <div className="grid items-stretch" style={{ gridTemplateColumns: 'minmax(200px,1.6fr) repeat(5, minmax(104px,1fr))' }}>
            <div className="px-4 py-3 text-[13px] font-semibold text-muted bg-[#09090b]">Capability</div>
            {COLS.map((c, i) => (
              <div
                key={c}
                className={`px-2 py-3 text-[13px] font-bold text-center bg-[#09090b] ${i === 0 ? 'text-accent bg-accent/[0.08]' : 'text-white'}`}
              >
                {c}
              </div>
            ))}

            {ROWS.map((r) => (
              <div key={r.cap} className="contents">
                <div className={`px-4 py-3.5 text-[13.5px] border-t border-border ${r.key ? 'text-white font-semibold' : 'text-[#c4c4cc]'}`}>
                  {r.cap}
                </div>
                {r.cells.map((c, i) => (
                  <Cell key={i} raw={c} head={i === 0} />
                ))}
              </div>
            ))}

            <div className="contents">
              <div className="px-4 py-3.5 text-[13.5px] text-muted border-t border-border">License / ownership</div>
              {LICENSE.map((v, i) => (
                <div
                  key={v}
                  className={`flex items-center justify-center text-center px-2 py-3.5 text-[12px] border-t border-border ${
                    i === 0 ? 'text-accent font-semibold bg-accent/[0.06]' : 'text-muted'
                  }`}
                >
                  {v}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-5 mt-3 flex-wrap text-xs text-muted">
        <span className="flex items-center gap-1.5"><Sym name="check" className="text-accent" /> First-class</span>
        <span className="flex items-center gap-1.5">
          <Sym name="remove" className="text-[#F4BF4F]" /> Partial / manual
          <em className="not-italic opacity-60">— hover for detail</em>
        </span>
        <span className="flex items-center gap-1.5"><Sym name="close" className="text-muted/40" /> Not available</span>
      </div>
    </div>
  );
}
