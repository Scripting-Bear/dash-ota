import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';

const FEATURES: { icon: string; title: string; body: string }[] = [
  { icon: '🛡️', title: 'Integrity verified in native', body: 'Every bundle is Ed25519-signed in the CLI and verified in native against a key baked into the binary — it holds even if TLS is fully broken.' },
  { icon: '🔑', title: 'Hardware device-key auth', body: 'Each install enrolls a non-exportable key from the AndroidKeyStore / Secure Enclave. No shared secret is ever transmitted at enrollment.' },
  { icon: '🧩', title: 'Plug-and-play backend', body: 'Mount the distributor into any Express/Connect app with one middleware, or run it standalone. It never holds the signing key.' },
  { icon: '⚡', title: 'npx-executable CLI', body: 'keygen → fingerprint → bundle → sign → publish → rollout, all from npx dash-ota. The Ed25519 private key lives only in CI.' },
  { icon: '🔄', title: 'Crash-loop rollback', body: 'A bad bundle auto-reverts to the last-known-good, then the embedded bundle — and is disabled and reported. Your app always boots.' },
  { icon: '🌱', title: 'Per-env flavours', body: 'dev / uat / prod each embed their own channel, signing key, and runtimeVersion — an OTA can only reach the flavour it was built for.' },
];

const CMP = [
  { big: 'Ed25519', p: 'Signed in CI, verified in native. A breached backend can’t forge an update.' },
  { big: 'AES-256-GCM', p: 'Authenticated, encrypted payloads — not a signed S3 URL on the client.' },
  { big: 'ECDSA P-256', p: 'Hardware device-key request auth. No secret to intercept at enrollment.' },
  { big: '0 → boot', p: 'Crash-loop breaker + server auto-pause. Fail-closed to the last working bundle.' },
];

function Hero() {
  const bear = useBaseUrl('/img/scripting-bear.png');
  return (
    <header className="hero">
      <span className="heroBadge">
        <img src={bear} alt="Scripting Bear" /> by Scripting Bear
      </span>
      <h1 className="heroTitle">
        Own your React&nbsp;Native <span className="heroGrad">OTA updates</span>
      </h1>
      <p className="heroSub">
        A self-hosted, security-hardened over-the-air update system for React Native — client,
        release CLI, and backend, all yours. Bank-grade by design: a breached server still can’t
        push code to your users.
      </p>
      <div className="heroBtns">
        <Link className="button button--primary button--lg" to="/docs/getting-started/quickstart">Get started →</Link>
        <Link className="button button--secondary button--lg" to="/docs/introduction/comparison">vs Stallion / hot-updater</Link>
        <Link className="button button--outline button--lg" href="https://github.com/Scripting-Bear/dash-ota">GitHub</Link>
      </div>

      <div className="codeWindow">
        <div className="winBar">
          <span className="dot r" /><span className="dot y" /><span className="dot g" />
          <span className="winTitle">release a signed OTA from CI</span>
        </div>
        <CodeBlock language="bash">{`npx dash-ota keygen --key-id key_prod_1
npx dash-ota publish --bundle-dir ./out --platform android \\
  --channel prod --runtime-version auto --bundle-version 7 --rollout 10`}</CodeBlock>
      </div>

      <div className="heroPills">
        <span className="heroPill">RN 0.79+ · New Arch · Hermes</span>
        <span className="heroPill">Android · iOS</span>
        <span className="heroPill">MIT</span>
      </div>
    </header>
  );
}

function Features() {
  return (
    <section className="section">
      <div className="container">
        <p className="sectionEyebrow">Why dash-ota</p>
        <h2 className="sectionTitle">The riskiest part of OTA, done conservatively</h2>
        <p className="sectionSub">Trust is divided so no single compromise — backend, network, or bundle — can forge or apply an update.</p>
        <div className="row">
          {FEATURES.map((f) => (
            <div className="col col--4" key={f.title} style={{ marginBottom: '1.6rem' }}>
              <div className="fCard">
                <div className="fIcon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Guarantee() {
  return (
    <section className="section sectionAlt">
      <div className="container">
        <div className="guarantee">
          <h2>A breached backend still can’t push malicious code.</h2>
          <p>
            Manifests are signed in the CLI and verified in native against an embedded key — even
            a fully-compromised server can only serve a validly-signed <em>older</em> bundle, which
            the downgrade guard rejects.
          </p>
        </div>
      </div>
    </section>
  );
}

function Compare() {
  return (
    <section className="section">
      <div className="container">
        <p className="sectionEyebrow">Built different</p>
        <h2 className="sectionTitle">Security most OTA tools skip</h2>
        <p className="sectionSub">Stallion and hot-updater secure the transport. dash-ota secures the <em>bundle</em>.</p>
        <div className="cmpGrid">
          {CMP.map((c) => (
            <div className="cmpCard" key={c.big}>
              <div className="big">{c.big}</div>
              <p>{c.p}</p>
            </div>
          ))}
        </div>
        <div style={{ textAlign: 'center', marginTop: '2rem' }}>
          <Link className="button button--primary button--lg" to="/docs/introduction/comparison">See the full comparison →</Link>
        </div>
      </div>
    </section>
  );
}

function Quickstart() {
  return (
    <section className="section sectionAlt">
      <div className="container">
        <p className="sectionEyebrow">Quickstart</p>
        <h2 className="sectionTitle">Three packages, one workflow</h2>
        <p className="sectionSub">Backend you mount, a client you wrap, a CLI you publish from.</p>
        <div className="codeWindow" style={{ marginTop: 0 }}>
          <div className="winBar">
            <span className="dot r" /><span className="dot y" /><span className="dot g" />
            <span className="winTitle">install</span>
          </div>
          <CodeBlock language="bash">{`npm i @dash-ota/backend       # distributor → one Express middleware
npm i react-native-dash-ota   # client → one <DashOtaProvider>
npx dash-ota --help           # release tooling (signs in CI)`}</CodeBlock>
        </div>
        <div style={{ textAlign: 'center', marginTop: '1.8rem' }}>
          <Link className="button button--primary button--lg" to="/docs/getting-started/quickstart">Full quickstart →</Link>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title={`${siteConfig.title} — secure OTA for React Native`} description={siteConfig.tagline}>
      <Hero />
      <main>
        <Features />
        <Guarantee />
        <Compare />
        <Quickstart />
      </main>
    </Layout>
  );
}
