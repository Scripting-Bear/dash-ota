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
    cells: ['y:You run it — Express middleware or standalone', 'n:Managed SaaS only', 'y:Your S3 / Supabase / Cloudflare', 'n:App Center retiring 2025', 'p:EAS-hosted, or self-host the updates server'],
  },
  {
    cap: 'Signed bundles, verified in native',
    key: true,
    cells: ['y:Ed25519 manifest, key embedded in the binary', 'n', 'n', 'n', 'y:Code signing, opt-in'],
  },
  {
    cap: 'Safe if the backend is breached',
    key: true,
    cells: ["y:Backend never holds the signing key — can't forge", 'n', 'n', 'n', 'y:Only if code signing is enabled'],
  },
  { cap: 'Payload encryption (AES-256-GCM)', cells: ['y:AES-256-GCM authenticated payloads', 'n', 'n', 'n', 'n'] },
  {
    cap: 'Hardware device-key request auth',
    key: true,
    cells: ['y:Non-exportable key from AndroidKeyStore / Secure Enclave', 'n', 'n', 'n', 'n'],
  },
  {
    cap: 'Anti-replay (nonce + timestamp)',
    cells: ['y:Server-issued nonce + timestamp', 'n', 'n', 'p:Limited / not documented', 'p:Limited / not documented'],
  },
  { cap: 'No S3 URL on the client', cells: ['y:API-only delivery + one-time download token', 'n', 'n:Client fetches a signed URL', 'n', 'n'] },
  {
    cap: 'runtimeVersion / native-compat gate',
    cells: ['y:Enforced on the backend AND in native', 'p:Manual / by convention', 'y', 'p:targetBinaryVersion (semver range)', 'y'],
  },
  { cap: 'Channels (dev / uat / prod)', cells: ['y:Per-flavour signing key + channel', 'y', 'y', 'y:Deployments', 'y'] },
  { cap: 'Staged rollout %', cells: ['y:Deterministic install-id bucketing', 'y', 'y', 'y', 'y'] },
  {
    cap: 'Crash-loop auto-rollback',
    key: true,
    cells: ['y:→ last-known-good → embedded, then disables the bundle', 'p:Manual rollback', 'p:Manual rollback', 'y', 'y'],
  },
  {
    cap: 'Server-side auto-pause on failures',
    cells: ['y:Auto-pauses when the failure rate crosses a threshold', 'n', 'n', 'p:Manual via the dashboard', 'p:Manual'],
  },
  { cap: 'Force-update ("go to store") gate', cells: ['y:Built-in min-native-version gate', 'n', 'n', 'n', 'p:Build it yourself'] },
  { cap: 'npx release CLI', cells: ['y', 'y', 'y', 'y', 'y:EAS CLI'] },
  { cap: 'New Arch + Hermes (RN 0.79+)', cells: ['y', 'y', 'y', 'p:Limited / community support', 'y'] },
];

const LICENSE = ['MIT — all yours', 'Proprietary', 'MIT', 'Retiring 2025', 'Mixed'];

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
          Last verified · Jun 2025
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
