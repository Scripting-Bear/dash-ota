import type { ReactNode } from 'react';

/**
 * Hand-built architecture / trust-flow diagram for the docs (replaces the auto-laid-out
 * Mermaid chart). A clean vertical flow of four trust zones with role accents, trust
 * badges, and labelled connectors. Wrapped in `.dash-landing` for the scoped Tailwind.
 */

type Zone = {
  icon: string;
  role: string;
  trust: string;
  pkg: string;
  desc: string;
  accent: string;
  tint: string;
};

const ZONES: Zone[] = [
  {
    icon: 'key',
    role: 'CI / Release machine',
    trust: 'Holds the private key',
    pkg: '@dash-ota/cli',
    desc: 'Bundles JS, compiles Hermes HBC, AES-256-GCM-encrypts, and Ed25519-signs the manifest. The signing key lives only here.',
    accent: '#f4bf4f',
    tint: 'rgba(244,191,79,0.1)',
  },
  {
    icon: 'dns',
    role: 'Your backend',
    trust: 'Never holds the key',
    pkg: '@dash-ota/backend',
    desc: 'Verifies device-key (ECDSA) requests, applies targeting + rollout, and serves the pre-signed manifest + ciphertext. It can store and serve, but never forge.',
    accent: '#5e6ad2',
    tint: 'rgba(94,106,210,0.12)',
  },
  {
    icon: 'code',
    role: 'react-native-dash-ota · JS',
    trust: 'Untrusted',
    pkg: 'JS orchestration',
    desc: 'Drives check → download → apply and handles retries. Treated as untrusted for security: a tampered bundle cannot disable its own verification.',
    accent: '#8f8f99',
    tint: 'rgba(143,143,153,0.12)',
  },
  {
    icon: 'verified_user',
    role: 'Native · Kotlin / Swift',
    trust: 'Trust-critical',
    pkg: 'verify · decrypt · stage · apply',
    desc: 'Before any JS runs: verifies the Ed25519 signature against the embedded key, AES-GCM-decrypts, checks every file hash, stages atomically, and rolls back on crash-loop.',
    accent: '#45d09e',
    tint: 'rgba(69,208,158,0.12)',
  },
];

const LINKS = [
  'POST /admin/publish · pre-signed manifest + ciphertext',
  'check (device-key signed) → signed manifest + one-time token → download → ciphertext',
  'hands the encrypted bytes to native — before anything is trusted',
];

const Icon = ({ name, className = '', style }: { name: string; className?: string; style?: React.CSSProperties }) => (
  <span className={`material-symbols-outlined ${className}`} style={style} aria-hidden>
    {name}
  </span>
);

function Connector({ label }: { label: string }): ReactNode {
  return (
    <div className="flex flex-col items-center py-1.5" aria-hidden>
      <div className="w-px h-4 bg-border" />
      <div className="text-[11px] font-mono text-muted px-3 py-1.5 rounded-md border border-border bg-[#0e0e12] text-center max-w-[460px] leading-snug">
        {label}
      </div>
      <Icon name="arrow_downward" className="text-muted/70" style={{ fontSize: 18, marginTop: 2 }} />
    </div>
  );
}

function ZoneCard({ z }: { z: Zone }): ReactNode {
  return (
    <div className="relative rounded-xl border border-border bg-surface overflow-hidden">
      <div className="absolute left-0 top-0 bottom-0 w-1" style={{ background: z.accent }} />
      <div className="p-5 pl-6 flex gap-4 items-start">
        <div
          className="shrink-0 size-11 rounded-lg grid place-items-center border"
          style={{ background: z.tint, borderColor: `${z.accent}40`, color: z.accent }}
        >
          <Icon name={z.icon} style={{ fontSize: 22 }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold uppercase tracking-wider text-white">{z.role}</span>
            <span
              className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border"
              style={{ color: z.accent, borderColor: `${z.accent}55`, background: z.tint }}
            >
              {z.trust}
            </span>
          </div>
          <div className="font-mono text-[13px] text-[#c4c4cc] mt-1.5">{z.pkg}</div>
          <p className="text-[13px] text-muted mt-1.5 leading-relaxed">{z.desc}</p>
        </div>
      </div>
    </div>
  );
}

export default function ArchitectureDiagram(): ReactNode {
  return (
    <div className="dash-landing" style={{ background: 'transparent', margin: '1.5rem 0 2rem' }}>
      <div className="rounded-2xl border border-border bg-[#0b0b0e] p-5 sm:p-7">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
          <span className="text-xs font-semibold tracking-wider uppercase text-muted">Divided trust · top to bottom</span>
          <span className="text-[11px] font-mono text-muted">sign → serve → orchestrate → verify</span>
        </div>
        {ZONES.map((z, i) => (
          <div key={z.role}>
            <ZoneCard z={z} />
            {i < LINKS.length && <Connector label={LINKS[i]} />}
          </div>
        ))}
      </div>
      <p className="text-[12px] text-muted mt-3 leading-relaxed">
        A compromised backend, a broken TLS channel, or a tampered JS bundle each <strong>independently fail</strong> to
        forge or apply an update — signing happens only in CI, and verification happens only in native.
      </p>
    </div>
  );
}
