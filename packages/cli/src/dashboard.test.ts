/**
 * Dashboard tests: a real backend in-process with the dashboard in front of it, driven through the
 * same API the page uses — publish, operate, and the local-only security guards.
 * Run: `npm run test:dashboard`.
 *
 * @module dashboard.test
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createRouter, loadConfig, Store } from '@dash-ota/backend';
import { generateSigningKeyPair } from '@dash-ota/shared';
import { prepareRelease } from './core.js';
import { type DashboardConfig, loadDashboardConfig, startDashboard } from './dashboard/server.js';
import { adminPost, verifyKeyFromPath } from './util.js';

const ADMIN = 'dashboard-test-admin-token';
const CONTENT_KEY = Buffer.alloc(32, 9).toString('base64');

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Just enough DOM to run the page's script: every element is a stub, and each innerHTML the page
 * writes is recorded. `fetch` answers from `respond`.
 */
function fakePage(respond: (path: string) => unknown) {
  const writes: string[] = [];
  const handlers = new Map<string, Record<string, (ev: unknown) => void>>();
  const elements = new Map<string, object>();
  const element = (selector: string): object => {
    const existing = elements.get(selector);
    if (existing) return existing;
    const on: Record<string, (ev: unknown) => void> = {};
    handlers.set(selector, on);
    let html = '';
    const el = {
      hidden: true,
      disabled: false,
      value: '',
      checked: false,
      textContent: '',
      className: '',
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      dataset: {},
      get innerHTML(): string {
        return html;
      },
      set innerHTML(value: string) {
        html = value;
        writes.push(value);
      },
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        on[type] = fn;
      },
      showModal: () => undefined,
      close: () => undefined,
      focus: () => undefined,
    };
    elements.set(selector, el);
    return el;
  };
  const storage = { getItem: () => null, setItem: () => undefined };
  const context = {
    document: {
      querySelector: element,
      querySelectorAll: () => [],
      addEventListener: () => undefined,
      visibilityState: 'visible',
    },
    location: { hash: '#t=test', pathname: '/' },
    history: { replaceState: () => undefined },
    sessionStorage: storage,
    localStorage: storage,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    URL,
    fetch: async (path: string) => ({ status: 200, ok: true, json: async () => respond(path) }),
  };
  return {
    context,
    writes,
    fire: (selector: string, type: string, ev: unknown): void => handlers.get(selector)?.[type]?.(ev),
    until: async (done: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !done(); i += 1) await sleep(5);
      assert.ok(done(), 'the page never rendered');
    },
  };
}

interface EnvView {
  name: string;
  ready: boolean;
  protected: boolean;
  keyPresent: boolean;
}
interface ReleaseRow {
  bundleId: string;
  bundleVersion: number;
  rolloutPercentage: number;
  paused: boolean;
  rolledBack: boolean;
  mandatory?: boolean;
}
interface JobView {
  status: string;
  error?: string;
  results: { bundleVersion: number }[];
  events: { type: string; upload?: number; total?: number }[];
}
interface Loose {
  error?: string;
  needsConfirm?: boolean;
  jobId?: string;
}

async function main(): Promise<void> {
  console.log('dash-ota dashboard\n');
  const tmp = mkdtempSync(join(tmpdir(), 'dash-ota-dashboard-'));

  const backendConfig = {
    ...loadConfig(),
    port: 0,
    adminToken: ADMIN,
    storageDir: join(tmp, 'storage'),
    dataDir: join(tmp, 'data'),
  };
  const backend = await createRouter(new Store(backendConfig), backendConfig).listen(0);
  const backendAddress = backend.address();
  const server = `http://localhost:${typeof backendAddress === 'object' && backendAddress ? backendAddress.port : 0}`;

  // Dashboard builds land in the OS cache; keep this run's inside its temp folder.
  process.env.XDG_CACHE_HOME = join(tmp, 'cache');

  const keys = generateSigningKeyPair();
  const keyDir = join(tmp, 'keys');
  mkdirSync(keyDir);
  writeFileSync(join(keyDir, 'key_dash.private.pem'), keys.privateKeyPem);
  writeFileSync(
    join(keyDir, 'key_dash.public.json'),
    JSON.stringify({ keyId: 'key_dash', publicKeyRawB64: keys.publicKeyRawB64 }),
  );
  writeFileSync(join(keyDir, 'key_dash.content.key'), CONTENT_KEY);

  // Builds wait on this gate so a test can hold a publish open.
  let gate: Promise<void> = Promise.resolve();
  let builds = 0;
  const buildDirs: { out: string; emptyAtStart: boolean }[] = [];
  const shared = {
    server,
    adminToken: ADMIN,
    appId: 'com.example.dash',
    runtimeVersion: 'r_dash',
    keyId: 'key_dash',
    keyPath: 'keys/key_dash.private.pem',
  };
  const config: DashboardConfig = {
    environments: {
      dev: { ...shared, channel: 'dev', platforms: ['android'] },
      prod: { ...shared, channel: 'prod', platforms: ['android'], protected: true },
      bare: { ...shared, channel: 'uat', adminToken: undefined },
      slash: { ...shared, server: `${server}/`, channel: 'dev', platforms: ['android'] },
    },
    bundle: async ({ platform, out }) => {
      await gate;
      builds += 1;
      buildDirs.push({ out, emptyAtStart: readdirSync(out).length === 0 });
      writeFileSync(
        join(out, platform === 'android' ? 'index.android.bundle' : 'main.jsbundle'),
        `bundle ${builds} `.padEnd(4096, 'x'),
      );
      mkdirSync(join(out, 'drawable-xxhdpi'), { recursive: true });
      writeFileSync(join(out, 'drawable-xxhdpi', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    },
  };

  const dash = await startDashboard({ config, project: tmp, port: 0 });
  const base = `http://127.0.0.1:${dash.port}`;

  async function api<T = Loose>(
    method: string,
    path: string,
    body?: unknown,
    token: string = dash.token,
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-dash-session': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, data: (await res.json()) as T };
  }

  async function waitForJob(id: string | undefined): Promise<JobView> {
    assert.ok(id, 'no job id');
    for (let i = 0; i < 400; i += 1) {
      const { data } = await api<JobView>('GET', `/api/jobs/${id}?since=0`);
      if (data.status !== 'running') return data;
      await sleep(25);
    }
    throw new Error(`job ${id} did not finish`);
  }

  async function devReleases(): Promise<ReleaseRow[]> {
    return (await api<{ releases: ReleaseRow[] }>('GET', '/api/envs/dev/releases')).data.releases;
  }

  async function release(match: (r: ReleaseRow) => boolean): Promise<ReleaseRow> {
    const found = (await devReleases()).find(match);
    assert.ok(found, 'release not found');
    return found;
  }

  function planOf(job: JobView): { upload?: number; total?: number } {
    const plan = job.events.find((e) => e.type === 'plan');
    assert.ok(plan, 'no upload plan was reported');
    return plan;
  }

  await check('the page is served without a token and contains none', async () => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.ok(html.includes('dash-ota'));
    assert.ok(!html.includes(dash.token));
  });

  await check("only the page's own script may run: a fresh nonce per response, no 'unsafe-inline'", async () => {
    const pages = await Promise.all([fetch(`${base}/`), fetch(`${base}/`)]);
    const nonces = await Promise.all(
      pages.map(async (res) => {
        const csp = res.headers.get('content-security-policy') ?? '';
        const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? '';
        assert.ok(!scriptSrc.includes('unsafe-inline'), csp);
        const nonce = /'nonce-([^']+)'/.exec(scriptSrc)?.[1];
        assert.ok(nonce, csp);
        const html = await res.text();
        assert.ok(html.includes(`<script nonce="${nonce}">`), 'the script tag does not carry the header nonce');
        assert.equal(html.split('<script').length, 2, 'the page must hold exactly one script');
        return nonce;
      }),
    );
    assert.notEqual(nonces[0], nonces[1]);
  });

  await check('backend-supplied release fields render as text, never markup', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
    assert.ok(script, 'no script in the page');
    // A breached backend controls every field of a release, including the adoption map's keys and values.
    const evil = 'x" autofocus onfocus="alert(2)<img src=x onerror=alert(1)>';
    const hostile = {
      bundleId: evil,
      platform: evil,
      channel: 'dev',
      runtimeVersion: 'r1',
      bundleVersion: evil,
      rolloutPercentage: evil,
      paused: false,
      rolledBack: false,
      mandatory: true,
      releaseNotes: evil,
      createdAt: evil,
      totalBytes: evil,
      adoption: { healthy: evil, applied: evil, failed: evil, rolled_back: evil, [evil]: evil },
      signedManifest: {
        manifest: { appId: evil, targetAppVersions: evil, releaseNotes: evil, files: [{ path: evil, size: evil }] },
      },
    };
    const env = { name: 'dev', server, channel: 'dev', appId: 'a', runtimeVersion: 'r1', keyId: 'k', platforms: ['android'] };
    const page = fakePage((path) => {
      if (path === '/api/envs') return { environments: [{ ...env, protected: false, ready: true, keyPresent: true }] };
      if (path === '/api/envs/dev/releases') return { releases: [hostile] };
      if (path.startsWith('/api/envs/dev/releases/')) return { release: hostile };
      return { job: null };
    });
    runInNewContext(script, page.context);
    await page.until(() => page.writes.some((w) => w.includes('data-id=')));
    page.fire('#rows', 'click', { target: { closest: () => ({ dataset: { id: evil } }) } });
    await page.until(() => page.writes.some((w) => w.includes('class="stats"')));

    const rendered = page.writes.join('\n');
    assert.ok(!/<img/i.test(rendered), 'a backend value became an element');
    assert.ok(!rendered.includes('onfocus="'), 'a backend value broke out of an attribute');
    assert.ok(rendered.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the value should still show, as text');
    assert.match(rendered, /<b>0<\/b> healthy/);
    assert.match(rendered, /<b>0<\/b><span>crashed, reverted/);
  });

  await check('the API refuses a missing or wrong session token', async () => {
    assert.equal((await fetch(`${base}/api/envs`)).status, 401);
    assert.equal((await api('GET', '/api/envs', undefined, 'x'.repeat(dash.token.length))).status, 401);
  });

  await check('a foreign Host header is refused', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: dash.port,
          path: '/api/envs',
          headers: { host: 'evil.example', 'x-dash-session': dash.token },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  await check('environments are listed without any secret', async () => {
    const { status, data } = await api<{ environments: EnvView[] }>('GET', '/api/envs');
    assert.equal(status, 200);
    const raw = JSON.stringify(data);
    assert.ok(!raw.includes(ADMIN) && !raw.includes('PRIVATE KEY') && !raw.includes(CONTENT_KEY));
    const byName = new Map(data.environments.map((e) => [e.name, e]));
    assert.equal(byName.get('dev')?.ready, true);
    assert.equal(byName.get('prod')?.protected, true);
    assert.equal(byName.get('bare')?.ready, false);
    assert.equal(byName.get('dev')?.keyPresent, true);
  });

  await check('register-key sends the channel public key to the server', async () => {
    assert.equal((await api('POST', '/api/envs/dev/register-key', {})).status, 200);
  });

  await check('publish builds, signs and uploads a release', async () => {
    const started = await api('POST', '/api/envs/dev/publish', {
      platforms: ['android'],
      rollout: 40,
      mandatory: true,
      releaseNotes: 'first',
    });
    assert.equal(started.status, 202);
    const job = await waitForJob(started.data.jobId);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.results[0]?.bundleVersion, 1);
    const plan = planOf(job);
    assert.deepEqual([plan.upload, plan.total], [2, 2]);
    const first = await release((r) => r.bundleVersion === 1);
    assert.equal(first.rolloutPercentage, 40);
    assert.equal(first.mandatory, true);
  });

  await check('the next publish reuses unchanged files and takes the next version', async () => {
    const started = await api('POST', '/api/envs/dev/publish', { platforms: ['android'], rollout: 100, mandatory: false });
    const job = await waitForJob(started.data.jobId);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.results[0]?.bundleVersion, 2);
    const plan = planOf(job);
    assert.deepEqual([plan.upload, plan.total], [1, 2], 'only the changed bundle should upload');
    assert.deepEqual((await api<{ next: Record<string, number> }>('GET', '/api/envs/dev/next-version')).data.next, {
      android: 3,
    });
  });

  await check('only one publish runs at a time', async () => {
    let release: () => void = () => undefined;
    gate = new Promise((r) => {
      release = r;
    });
    const first = await api('POST', '/api/envs/dev/publish', { platforms: ['android'], rollout: 100 });
    assert.equal(first.status, 202);
    assert.equal((await api('POST', '/api/envs/dev/publish', { platforms: ['android'], rollout: 100 })).status, 409);
    assert.equal((await api<{ job: { status: string } | null }>('GET', '/api/jobs/latest')).data.job?.status, 'running');
    release();
    gate = Promise.resolve();
    assert.equal((await waitForJob(first.data.jobId)).status, 'done');
  });

  await check('rollout, pause, resume and rollback operate a release', async () => {
    const { bundleId: id } = await release((r) => r.bundleVersion === 1);
    const find = () => release((r) => r.bundleId === id);
    assert.equal((await api('POST', `/api/envs/dev/releases/${id}/rollout`, { pct: 75 })).status, 200);
    assert.equal((await find()).rolloutPercentage, 75);
    await api('POST', `/api/envs/dev/releases/${id}/pause`, { paused: true });
    assert.equal((await find()).paused, true);
    await api('POST', `/api/envs/dev/releases/${id}/pause`, { paused: false });
    assert.equal((await find()).paused, false);
    await api('POST', `/api/envs/dev/releases/${id}/rollback`, {});
    assert.equal((await find()).rolledBack, true);
  });

  await check("a release can't be operated from another environment's tab", async () => {
    const { bundleId: id } = await release(() => true);
    const res = await api('POST', `/api/envs/prod/releases/${id}/pause`, { paused: true, confirm: 'prod' });
    assert.equal(res.status, 404);
  });

  await check('a protected environment refuses writes without its typed name', async () => {
    const policy = { min: 5, severity: 'soft' };
    const refused = await api('POST', '/api/envs/prod/native-policy', policy);
    assert.equal(refused.status, 403);
    assert.equal(refused.data.needsConfirm, true);
    assert.equal((await api('POST', '/api/envs/prod/native-policy', { ...policy, confirm: 'prod' })).status, 200);
    assert.equal((await api('POST', '/api/envs/prod/publish', { platforms: ['android'], rollout: 10 })).status, 403);
  });

  await check('an environment without an admin token says so instead of failing', async () => {
    const res = await api('GET', '/api/envs/bare/releases');
    assert.equal(res.status, 400);
    assert.match(res.data.error ?? '', /admin token/);
  });

  await check('bad input is rejected before anything is built', async () => {
    const before = builds;
    const { bundleId: id } = await release(() => true);
    assert.equal((await api('POST', `/api/envs/dev/releases/${id}/rollout`, { pct: 150 })).status, 400);
    assert.equal((await api('POST', '/api/envs/dev/publish', { platforms: ['ios'], rollout: 100 })).status, 400);
    assert.equal((await api('POST', '/api/envs/dev/native-policy', { min: 1, severity: 'loud' })).status, 400);
    const form = await fetch(`${base}/api/envs/dev/register-key`, {
      method: 'POST',
      headers: { 'x-dash-session': dash.token, 'content-type': 'text/plain' },
      body: '{}',
    });
    assert.equal(form.status, 415);
    assert.equal(builds, before);
  });

  await check('every publish builds in the same emptied folder per environment and platform', async () => {
    assert.ok(buildDirs.length >= 3, 'expected several builds');
    assert.ok(
      buildDirs.every((b) => b.out === buildDirs[0]?.out),
      'the build folder moved between publishes',
    );
    assert.ok(buildDirs[0]?.out.startsWith(join(tmp, 'cache', 'dash-ota', 'build')), buildDirs[0]?.out);
    assert.match(buildDirs[0]?.out ?? '', /[/\\]dev[/\\]android$/);
    assert.ok(
      buildDirs.every((b) => b.emptyAtStart),
      "a previous build's files were left in the folder",
    );
    assert.ok(!existsSync(buildDirs[0]?.out ?? ''), 'the build folder is removed after the publish');
  });

  await check('a server configured with a trailing slash still works', async () => {
    const res = await api<{ releases: ReleaseRow[] }>('GET', '/api/envs/slash/releases');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(res.data.releases.length > 0);
  });

  await check('`list` shows an interrupted publish as INCOMPLETE, without a rollout', async () => {
    const prepared = await prepareRelease({
      files: [{ path: 'index.android.bundle', data: Buffer.from('interrupted') }],
      platform: 'android',
      channel: 'dev',
      runtimeVersion: 'r_dash',
      bundleVersion: 99,
      appId: 'com.example.dash',
      mandatory: false,
      keyId: 'key_dash',
      privateKeyPem: keys.privateKeyPem,
      encrypt: true,
      contentKey: Buffer.from(CONTENT_KEY, 'base64'),
      verifyKey: verifyKeyFromPath(join(keyDir, 'key_dash.private.pem'), keys.privateKeyPem),
      bundleId: 'bnd_interrupted',
    });
    // Declared, then never finalized: what a publish killed mid-upload leaves behind.
    await adminPost(server, '/admin/releases', { signedManifest: prepared.signed, rolloutPercentage: 100 }, ADMIN);
    const cli = join(dirname(fileURLToPath(import.meta.url)), 'index.ts');
    // Asynchronous: the backend answering this child runs in this process.
    const res = await new Promise<{ status: number; stdout: string; stderr: string }>((done) => {
      execFile(
        process.execPath,
        [...process.execArgv, cli, 'list', '--server', `${server}/`],
        { env: { ...process.env, OTA_ADMIN_TOKEN: ADMIN }, timeout: 60_000 },
        (err, stdout, stderr) => done({ status: err ? Number(err.code ?? 1) : 0, stdout, stderr }),
      );
    });
    assert.equal(res.status, 0, res.stderr);
    const line = res.stdout.split('\n').find((l) => l.startsWith('bnd_interrupted '));
    assert.ok(line, res.stdout);
    assert.match(line, /\bINCOMPLETE\b/);
    assert.ok(!/\d%/.test(line), line);
    assert.match(res.stdout, /INCOMPLETE: declared but never finalized/);
  });

  await check('a missing config points at the shipped example and the docs', async () => {
    const err = await loadDashboardConfig(join(tmp, 'nope.mjs')).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    assert.ok(err, 'a missing config must fail');
    const example = /start from the example: (.+)/.exec(err.message)?.[1] ?? '';
    assert.ok(existsSync(example), `the example path does not exist: ${example}`);
    assert.match(err.message, /docs: https:\/\/\S+\/docs\/cli\/dashboard/);
    assert.ok(!err.message.includes('dash-ota help'));
  });

  await dash.close();
  await new Promise<void>((r) => backend.close(() => r()));
  console.log(`\n${passed} dashboard checks passed.\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
