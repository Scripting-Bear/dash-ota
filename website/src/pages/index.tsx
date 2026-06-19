import { type ReactNode, useState } from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';

const Icon = ({ name, className = '', fill = false }: { name: string; className?: string; fill?: boolean }) => (
  <span
    className={`material-symbols-outlined ${className}`}
    style={fill ? { fontVariationSettings: "'FILL' 1" } : undefined}
    aria-hidden
  >
    {name}
  </span>
);

/* ---- token-coloured code (mirrors Stitch's .token-* classes) ---- */
const TERMINAL = `<span class="token-comment"># Install &amp; inspect the dash-ota CLI</span>
<span class="token-keyword">npx</span> dash-ota --help

<span class="token-comment"># Generate the Ed25519 signing key (CI only)</span>
<span class="token-keyword">npx</span> dash-ota keys generate --key-id key_prod_1

<span class="token-comment"># Bundle, sign &amp; publish a staged rollout</span>
<span class="token-keyword">npx</span> dash-ota publish \\
  --bundle-dir ./out --platform android \\
  --channel prod --rollout <span class="token-string">10</span>`;

const TABS: Record<string, { label: string; html: string; plain: string }> = {
  client: {
    label: 'Client SDK',
    html: `<span class="token-keyword">import</span> { DashOtaProvider } <span class="token-keyword">from</span> <span class="token-string">'react-native-dash-ota'</span>;

<span class="token-comment">// Wrap your root — verify natively before applying.</span>
<span class="token-keyword">export default function</span> <span class="token-function">Root</span>() {
  <span class="token-keyword">return</span> (
    &lt;DashOtaProvider config={{ appVersion: <span class="token-string">'1.4.0'</span> }}&gt;
      &lt;App /&gt;
    &lt;/DashOtaProvider&gt;
  );
}`,
    plain: "import { DashOtaProvider } from 'react-native-dash-ota';",
  },
  backend: {
    label: 'Backend',
    html: `<span class="token-keyword">import</span> express <span class="token-keyword">from</span> <span class="token-string">'express'</span>;
<span class="token-keyword">import</span> { dashOtaMiddleware } <span class="token-keyword">from</span> <span class="token-string">'@dash-ota/backend'</span>;

<span class="token-keyword">const</span> app = <span class="token-function">express</span>();
<span class="token-comment">// Mount the distributor — it never holds the signing key.</span>
app.<span class="token-function">use</span>(<span class="token-function">dashOtaMiddleware</span>({ adminToken: process.env.OTA_ADMIN_TOKEN }));
app.<span class="token-function">listen</span>(<span class="token-string">4455</span>);`,
    plain: "import { dashOtaMiddleware } from '@dash-ota/backend';",
  },
  cicd: {
    label: 'CI/CD',
    html: `<span class="token-comment"># .github/workflows/ota.yml</span>
<span class="token-keyword">name</span>: Ship OTA
<span class="token-keyword">on</span>:
  push:
    branches: [ main ]

<span class="token-keyword">jobs</span>:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci &amp;&amp; npm run bundle:android
      - run: <span class="token-keyword">npx</span> dash-ota publish --channel prod --rollout 10
        env:
          DASH_OTA_SIGNING_KEY: \${{ secrets.DASH_OTA_SIGNING_KEY }}`,
    plain: 'npx dash-ota publish --channel prod --rollout 10',
  },
};

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 2000);
      }}
      className={`absolute top-4 right-4 p-1.5 rounded-md bg-[#09090b] border transition-all ${
        done ? 'border-accent bg-accent/10 text-accent' : 'border-border hover:border-muted text-muted hover:text-white'
      }`}
      aria-label="Copy"
    >
      <Icon name={done ? 'check' : 'content_copy'} className="text-[16px]" />
    </button>
  );
}

/* ----------------------------------------------------------- hero */
function Hero() {
  return (
    <section className="max-w-content mx-auto px-6 pt-24 pb-20 lg:pt-28 lg:pb-28 flex flex-col lg:flex-row items-center gap-12 lg:gap-8">
      <div className="flex-1 flex flex-col items-start gap-6 w-full max-w-2xl lg:max-w-none">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-border bg-surface">
          <span className="flex h-2 w-2 rounded-full bg-accent" />
          <span className="text-xs font-medium text-muted uppercase tracking-wider">
            Trusted, native-verified OTA
          </span>
        </div>
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight text-white leading-[1.1]">
          Ship instantly with <br className="hidden sm:block" />
          <span className="grad-text">OTA updates</span>
        </h1>
        <p className="text-base sm:text-lg text-muted max-w-lg leading-relaxed">
          A self-hosted, security-hardened over-the-air update system for React Native that bypasses
          app-store delays without compromising cryptographic integrity. Client, release CLI, and
          backend — all yours.
        </p>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 mt-2 w-full sm:w-auto">
          <Link
            to="/docs/getting-started/quickstart"
            className="h-10 px-5 inline-flex items-center justify-center bg-white text-background-dark text-[13px] font-semibold rounded-md hover:bg-gray-200 transition-colors"
          >
            Get started
          </Link>
          <Link
            to="/docs/"
            className="h-10 px-5 inline-flex items-center justify-center gap-2 bg-surface text-white text-[13px] font-medium rounded-md border border-border hover:border-muted transition-colors group"
          >
            <Icon name="terminal" className="text-[18px] text-muted group-hover:text-white transition-colors" />
            Read the docs
          </Link>
        </div>
        <div className="hidden sm:flex items-center gap-3 mt-4 flex-wrap">
          {[
            { i: 'lock', t: 'Ed25519 signed' },
            { i: 'verified_user', t: 'Verified in native' },
            { i: 'history', t: 'Fail-closed rollback' },
          ].map((c) => (
            <div
              key={c.t}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-surface border border-border text-xs text-muted font-mono"
            >
              <Icon name={c.i} className="text-[14px]" />
              {c.t}
            </div>
          ))}
        </div>
      </div>

      {/* terminal */}
      <div className="flex-1 w-full max-w-2xl lg:max-w-none relative group">
        <div className="absolute -inset-1 bg-gradient-to-r from-primary/30 to-purple-500/30 rounded-xl blur-2xl opacity-50 group-hover:opacity-75 transition-opacity duration-500" />
        <div className="relative rounded-lg border border-border bg-surface shadow-2xl overflow-hidden flex flex-col lg:min-h-[340px]">
          <div className="h-10 border-b border-border bg-[#0e0e10] flex items-center px-4 justify-between">
            <div className="flex items-center gap-2">
              <div className="size-3 rounded-full bg-[#ED6A5E]" />
              <div className="size-3 rounded-full bg-[#F4BF4F]" />
              <div className="size-3 rounded-full bg-[#61C554]" />
            </div>
            <div className="text-[11px] font-mono text-muted flex items-center gap-2">
              <Icon name="folder" className="text-[14px]" />
              ~/project/release.sh
            </div>
            <div className="w-12" />
          </div>
          <div className="p-6 font-mono text-[13px] leading-[1.6] overflow-x-auto text-muted relative flex-1">
            <CopyBtn text="npx dash-ota publish --bundle-dir ./out --platform android --channel prod --rollout 10" />
            <pre className="bg-transparent p-0 m-0 border-0">
              <code dangerouslySetInnerHTML={{ __html: TERMINAL }} />
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

const FEATURES = [
  {
    icon: 'verified_user',
    title: 'Native verification',
    body: 'Ed25519 signatures are verified natively on-device before a bundle runs. Tampered or downgraded bundles are rejected instantly — it holds even if TLS is broken.',
  },
  {
    icon: 'key',
    title: 'Hardware device-key auth',
    body: 'Each install enrolls a non-exportable key from the AndroidKeyStore / Secure Enclave. No shared secret is ever transmitted at enrollment.',
  },
  {
    icon: 'commit',
    title: 'Atomic rollbacks',
    body: 'If an update crashes on launch, the SDK reverts to the last-known-good bundle, then the embedded one — and disables the bad release. Your app always boots.',
  },
];

function Features() {
  return (
    <section className="border-y border-border bg-background-dark py-24">
      <div className="max-w-content mx-auto px-6">
        <div className="mb-16">
          <h2 className="text-3xl font-semibold tracking-tight text-white mb-4">
            Architected for scale and security
          </h2>
          <p className="text-muted text-lg max-w-2xl">
            Trust is split across the CLI, backend, and native runtime — so no single compromise
            (server, network, or bundle) can forge or apply an update.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 border border-border rounded-lg overflow-hidden bg-surface">
          {FEATURES.map((f, i) => (
            <div
              key={f.title}
              className={`p-8 bg-background-dark hover:bg-surface transition-colors duration-150 group relative ${
                i < 2 ? 'border-b md:border-b-0 md:border-r border-border' : ''
              } ${i === 0 ? 'lg:border-r' : ''}`}
            >
              <div className="size-10 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center mb-6 text-primary">
                <Icon name={f.icon} />
              </div>
              <h3 className="text-lg font-medium text-white mb-2">{f.title}</h3>
              <p className="text-sm text-muted leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Pipeline() {
  const Node = ({ icon, label, tag, tagClass, big }: { icon: string; label: string; tag?: string; tagClass?: string; big?: boolean }) => (
    <div className="flex flex-col items-center gap-4 text-center">
      <div
        className={`${big ? 'size-20 border-primary/30 bg-primary/5 shadow-[0_0_30px_rgba(66,84,240,0.2)]' : 'size-16 border-border bg-surface shadow-lg'} rounded-md border flex items-center justify-center relative`}
      >
        <Icon name={icon} className={big ? 'text-primary text-3xl' : 'text-muted text-2xl'} />
      </div>
      <div className={`text-xs font-mono ${big ? 'text-white font-medium' : 'text-muted'}`}>{label}</div>
      {tag && <div className={`text-[10px] px-2 py-1 rounded border ${tagClass}`}>{tag}</div>}
    </div>
  );
  const Arrow = ({ label }: { label: string }) => (
    <div className="flex-1 h-0.5 bg-gradient-to-r from-border via-primary to-border relative min-w-[64px] rounded-full">
      <Icon
        name="chevron_right"
        className="absolute -right-1.5 top-1/2 -translate-y-1/2 text-primary text-base leading-none"
      />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 px-2 bg-background-dark text-[10px] font-mono text-muted whitespace-nowrap">
        {label}
      </div>
    </div>
  );
  return (
    <section className="py-32 bg-surface relative overflow-hidden border-b border-border">
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-[800px] h-[400px] bg-primary/15 blur-[100px] rounded-full" />
      </div>
      <div className="max-w-content mx-auto px-6 relative z-10 flex flex-col items-center text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-white mb-6">Trust-less update pipeline</h2>
        <p className="text-muted text-lg max-w-2xl mb-16">
          We never hold your signing key. Sign bundles in CI, store the artifact in your own backend,
          and let the device verify integrity against an embedded key.
        </p>
        <div className="w-full max-w-4xl h-[400px] border border-border rounded-lg bg-background-dark p-1 flex items-center justify-center relative overflow-hidden">
          <div className="absolute inset-0 pipeline-grid" />
          <div className="flex items-center justify-between w-full px-6 sm:px-12 z-10">
            <Node icon="developer_mode" label="Release CLI" tag="Sign · private key" tagClass="text-primary/80 bg-primary/10 border-primary/20" />
            <Arrow label="Upload artifact" />
            <Node icon="cloud" label="Your backend" big />
            <Arrow label="Download" />
            <Node icon="smartphone" label="Client device" tag="Verify · embedded key" tagClass="text-accent/80 bg-accent/10 border-accent/20" />
          </div>
        </div>
      </div>
    </section>
  );
}

const ROWS = [
  'Native Ed25519 verification',
  'Safe if the backend is breached',
  'Self-hosted, no vendor lock-in',
  'Bring your own CI/CD',
];

function Switch() {
  const [tab, setTab] = useState<keyof typeof TABS>('client');
  return (
    <section className="py-24 max-w-content mx-auto px-6 grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-8 items-start">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-white mb-6">Why switch?</h2>
        <div className="border border-border rounded-lg overflow-hidden bg-surface">
          <table className="w-full text-left text-sm" style={{ display: 'table' }}>
            <thead>
              <tr className="border-b border-border bg-[#09090b]">
                <th className="p-4 font-medium text-muted w-1/2">Capability</th>
                <th className="p-4 font-medium text-white border-l border-border w-1/4 text-center">dash-ota</th>
                <th className="p-4 font-medium text-muted border-l border-border w-1/4 text-center">Alternatives</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r} className="border-b border-border last:border-b-0">
                  <td className="p-4 text-muted">{r}</td>
                  <td className="p-4 border-l border-border text-center">
                    <Icon name="check" className="text-accent text-lg" />
                  </td>
                  <td className="p-4 border-l border-border text-center">
                    <Icon name="close" className="text-muted/50 text-lg" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-white mb-6">Drop-in integration</h2>
        <div className="border border-border rounded-lg bg-surface overflow-hidden">
          <div className="flex items-center border-b border-border bg-[#09090b] px-2 pt-2 gap-1">
            {(Object.keys(TABS) as (keyof typeof TABS)[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`px-3 py-2 text-[13px] font-medium border-b-2 transition-colors ${
                  k === tab ? 'text-white border-primary' : 'text-muted border-transparent hover:text-white'
                }`}
              >
                {TABS[k].label}
              </button>
            ))}
          </div>
          <div className="p-6 relative font-mono text-[13px] leading-[1.6] text-muted overflow-x-auto min-h-[240px]">
            <CopyBtn text={TABS[tab].plain} />
            <pre className="bg-transparent p-0 m-0 border-0">
              <code dangerouslySetInnerHTML={{ __html: TABS[tab].html }} />
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title={`${siteConfig.title} — secure OTA for React Native`} description={siteConfig.tagline}>
      <div className="dash-landing dash-home">
        <Hero />
        <main>
          <Features />
          <Pipeline />
          <Switch />
        </main>
      </div>
    </Layout>
  );
}
