/**
 * Dashboard tests: a real backend in-process with the dashboard in front of it, driven through the
 * same API the page uses — publish, operate, and the local-only security guards.
 * Run: `npm run test:dashboard`.
 *
 * @module dashboard.test
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouter, loadConfig, Store } from '@dash-ota/backend';
import { generateSigningKeyPair } from '@dash-ota/shared';
import { type DashboardConfig, startDashboard } from './dashboard/server.js';

const ADMIN = 'dashboard-test-admin-token';
const CONTENT_KEY = Buffer.alloc(32, 9).toString('base64');

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    },
    bundle: async ({ platform, out }) => {
      await gate;
      builds += 1;
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

  await dash.close();
  await new Promise<void>((r) => backend.close(() => r()));
  console.log(`\n${passed} dashboard checks passed.\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
