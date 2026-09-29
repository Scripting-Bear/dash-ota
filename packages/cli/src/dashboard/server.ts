/**
 * `dash-ota dashboard`: a local web UI over the same release operations as the CLI.
 *
 * Listens on 127.0.0.1 only and requires a per-launch session token on every API call. Admin tokens
 * and keys stay in this process; the page only ever sees environment names and release data.
 *
 * @module dashboard/server
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Channel, Platform } from '@dash-ota/shared';
import {
  bundleProject,
  getRelease,
  listReleases,
  loadSigningKey,
  nextBundleVersion,
  type OtaEvent,
  prepareRelease,
  readContentKey,
  registerKey,
  rollbackRelease,
  setNativePolicy,
  setPaused,
  setRollout,
  type Target,
  uploadRelease,
} from '../core.js';
import { assertSecureServer, normalizeServer, readBundleDir, verifyKeyFromPath } from '../util.js';

/** One environment the dashboard operates. Relative paths resolve against the project. */
export interface DashboardEnv {
  server: string;
  /** Without it the environment is listed but cannot be read or changed. */
  adminToken?: string;
  channel: Channel;
  appId: string;
  runtimeVersion: string;
  keyId: string;
  keyPath: string;
  /** Defaults to `<keyId>.content.key` next to the signing key. */
  contentKeyPath?: string;
  /** For an encrypted signing key; falls back to OTA_KEY_PASSPHRASE. */
  passphrase?: string;
  platforms?: Platform[];
  /** Every write needs the environment's name typed to confirm. */
  protected?: boolean;
}

export interface BundleContext {
  platform: Platform;
  out: string;
  project: string;
  env: string;
  log: (message: string) => void;
}

export interface DashboardConfig {
  /** App root, relative to the config file. Defaults to the config file's directory. */
  project?: string;
  environments: Record<string, DashboardEnv>;
  /** Replaces the default build (`react-native bundle` + hermesc). */
  bundle?: (ctx: BundleContext) => Promise<void>;
}

export interface DashboardHandle {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

type JobEvent = ({ type: 'step'; message: string } | OtaEvent) & { platform?: Platform; at: number };

interface Job {
  id: string;
  env: string;
  status: 'running' | 'done' | 'failed';
  events: JobEvent[];
  results: { platform: Platform; bundleId: string; bundleVersion: number; uploaded: number; total: number }[];
  error?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const ALL_PLATFORMS: Platform[] = ['android', 'ios'];
const MAX_BODY = 64 * 1024;
/** Publish jobs kept in memory. Map iteration is insertion-ordered, so the oldest goes first. */
const MAX_RETAINED_JOBS = 20;
const REQUIRED: (keyof DashboardEnv)[] = ['server', 'channel', 'appId', 'runtimeVersion', 'keyId', 'keyPath'];
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
/** Only the page's own script runs: its nonce is new per response, so markup injected into the page cannot carry it. */
const pageCsp = (nonce: string): string =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; ` +
  "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const DOCS_URL = 'https://scripting-bear.github.io/dash-ota/docs/cli/dashboard';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The example config shipped at the package root: one level above dist/, two above src/dashboard/. */
export function exampleConfigPath(): string {
  for (const rel of ['../dash-ota.config.example.mjs', '../../dash-ota.config.example.mjs']) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(candidate)) return candidate;
  }
  return '@dash-ota/cli/dash-ota.config.example.mjs';
}

/**
 * A fixed build folder per project, environment and platform. A custom `bundle` that runs hermesc
 * on an absolute path records it in the bytecode, so a new folder per publish meant new bytes.
 */
function buildDirFor(project: string, env: string, platform: Platform): string {
  const cache =
    process.env.XDG_CACHE_HOME ||
    (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches')
      : process.platform === 'win32'
        ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
        : join(homedir(), '.cache'));
  const projectKey = createHash('sha256').update(project).digest('hex').slice(0, 12);
  return join(cache, 'dash-ota', 'build', projectKey, env.replace(/[^\w-]/g, '_'), platform);
}

/** Load and validate a `dash-ota.config.mjs`. */
export async function loadDashboardConfig(file: string): Promise<{ config: DashboardConfig; project: string }> {
  const abs = resolve(file);
  if (!existsSync(abs)) {
    throw new Error(
      `dashboard config not found: ${abs}\n` + `  start from the example: ${exampleConfigPath()}\n` + `  docs: ${DOCS_URL}`,
    );
  }
  const mod = (await import(pathToFileURL(abs).href)) as { default?: DashboardConfig };
  if (!mod.default) throw new Error(`${abs} must \`export default\` a config object`);
  validateConfig(mod.default);
  return { config: mod.default, project: resolve(dirname(abs), mod.default.project ?? '.') };
}

export function validateConfig(config: DashboardConfig): void {
  const envs = Object.entries(config?.environments ?? {});
  if (envs.length === 0) throw new Error('config.environments is empty');
  for (const [name, env] of envs) {
    const missing = REQUIRED.filter((key) => !env[key]);
    if (missing.length) throw new Error(`environment "${name}" is missing: ${missing.join(', ')}`);
    assertSecureServer(env.server, false);
    for (const p of env.platforms ?? []) {
      if (!ALL_PLATFORMS.includes(p)) throw new Error(`environment "${name}": unknown platform ${p}`);
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendPage(res: ServerResponse, html: string): void {
  const nonce = randomBytes(16).toString('base64');
  res.writeHead(200, { ...HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': pageCsp(nonce) });
  res.end(html.replace('<script>', `<script nonce="${nonce}">`));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'expected application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function tokenMatches(header: string | string[] | undefined, expected: Buffer): boolean {
  if (typeof header !== 'string') return false;
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} must be an integer ${min}–${max}`);
  }
  return value;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `${name} must be text up to ${max} characters`);
  return value;
}

/** Start the dashboard on 127.0.0.1. The returned URL carries the session token in its fragment. */
export async function startDashboard(opts: {
  config: DashboardConfig;
  project: string;
  port?: number;
}): Promise<DashboardHandle> {
  const { config, project } = opts;
  validateConfig(config);
  const token = randomBytes(24).toString('base64url');
  const expected = Buffer.from(token);
  const page = readFileSync(fileURLToPath(new URL('./ui.html', import.meta.url)), 'utf8');
  if (page.split('<script>').length !== 2) throw new Error('ui.html must hold exactly one plain <script> tag for the CSP nonce');
  const jobs = new Map<string, Job>();
  let latest: Job | undefined;
  let port = 0;

  const inProject = (p: string): string => (isAbsolute(p) ? p : join(project, p));
  const platformsOf = (env: DashboardEnv): Platform[] => (env.platforms?.length ? env.platforms : ALL_PLATFORMS);

  function envOf(name: string): DashboardEnv {
    const env = config.environments[name];
    if (!env) throw new HttpError(404, `unknown environment: ${name}`);
    return env;
  }

  function targetOf(name: string, env: DashboardEnv): Target {
    if (!env.adminToken) throw new HttpError(400, `no admin token configured for ${name}`);
    return { server: normalizeServer(env.server), adminToken: env.adminToken };
  }

  function requireConfirm(name: string, env: DashboardEnv, body: Record<string, unknown>): void {
    if (env.protected && body.confirm !== name) throw new HttpError(403, `type "${name}" to confirm`, { needsConfirm: true });
  }

  function describe(name: string, env: DashboardEnv): Record<string, unknown> {
    return {
      name,
      server: env.server,
      channel: env.channel,
      appId: env.appId,
      runtimeVersion: String(env.runtimeVersion),
      keyId: env.keyId,
      platforms: platformsOf(env),
      protected: Boolean(env.protected),
      ready: Boolean(env.adminToken),
      keyPresent: existsSync(inProject(env.keyPath)),
    };
  }

  function signingFor(env: DashboardEnv) {
    const keyPath = inProject(env.keyPath);
    try {
      const privateKeyPem = loadSigningKey(keyPath, env.passphrase ?? process.env.OTA_KEY_PASSPHRASE);
      const contentKey = readContentKey(inProject(env.contentKeyPath ?? join(dirname(env.keyPath), `${env.keyId}.content.key`)));
      return { privateKeyPem, contentKey, verifyKey: verifyKeyFromPath(keyPath, privateKeyPem) };
    } catch (err) {
      throw new HttpError(400, errorText(err));
    }
  }

  // Serving one channel's release from another environment's tab would bypass that tab's confirmation.
  async function releaseIn(target: Target, env: DashboardEnv, bundleId: string): Promise<Record<string, unknown>> {
    const release = await getRelease(target, bundleId);
    if (release.channel !== env.channel) throw new HttpError(404, `${bundleId} is not a ${env.channel} release`);
    return release;
  }

  function startPublish(
    name: string,
    env: DashboardEnv,
    target: Target,
    input: { platforms: Platform[]; rollout: number; mandatory: boolean; releaseNotes?: string; targetAppVersions?: string },
  ): Job {
    const signing = signingFor(env);
    const job: Job = { id: randomBytes(8).toString('hex'), env: name, status: 'running', events: [], results: [] };
    // A job keeps every log line it produced, so an all-day session would grow without a bound.
    // The UI only ever polls the running job and the last few, so drop the oldest beyond that.
    while (jobs.size >= MAX_RETAINED_JOBS) {
      const oldest = jobs.keys().next();
      if (oldest.done) break;
      jobs.delete(oldest.value);
    }
    jobs.set(job.id, job);
    latest = job;
    const push = (event: { type: 'step'; message: string } | OtaEvent, platform: Platform): void => {
      job.events.push({ ...event, platform, at: Date.now() });
    };

    void (async () => {
      try {
        for (const platform of input.platforms) {
          const emit = (event: OtaEvent): void => push(event, platform);
          push({ type: 'step', message: 'resolving the next bundle version' }, platform);
          const bundleVersion = await nextBundleVersion(target, env.channel, platform);
          const out = buildDirFor(project, name, platform);
          // Emptied first: a file left by the previous build would otherwise ship in this release.
          rmSync(out, { recursive: true, force: true });
          mkdirSync(out, { recursive: true });
          try {
            push({ type: 'step', message: `building v${bundleVersion}` }, platform);
            if (config.bundle) {
              await config.bundle({ platform, out, project, env: name, log: (message) => emit({ type: 'log', message }) });
            } else {
              await bundleProject({ project, platform, out, hermes: true }, emit);
            }
            push({ type: 'step', message: 'signing' }, platform);
            const prepared = await prepareRelease(
              {
                files: readBundleDir(out),
                platform,
                channel: env.channel,
                runtimeVersion: String(env.runtimeVersion),
                bundleVersion,
                appId: env.appId,
                mandatory: input.mandatory,
                keyId: env.keyId,
                encrypt: true,
                ...signing,
                ...(input.releaseNotes ? { releaseNotes: input.releaseNotes } : {}),
                ...(input.targetAppVersions ? { targetAppVersions: input.targetAppVersions } : {}),
              },
              emit,
            );
            push({ type: 'step', message: 'uploading' }, platform);
            const uploaded = await uploadRelease(target, prepared, input.rollout, emit);
            job.results.push({
              platform,
              bundleId: prepared.bundleId,
              bundleVersion,
              uploaded: uploaded.uploaded,
              total: uploaded.total,
            });
            push({ type: 'step', message: `published ${prepared.bundleId}` }, platform);
          } finally {
            rmSync(out, { recursive: true, force: true });
          }
        }
        job.status = 'done';
      } catch (err) {
        job.status = 'failed';
        job.error = errorText(err);
      }
    })();
    return job;
  }

  async function handleEnv(method: string, name: string, rest: string[], body: Record<string, unknown>): Promise<unknown> {
    const env = envOf(name);
    const [resource, id, action] = rest;

    if (method === 'GET' && resource === 'releases' && !id) {
      const releases = await listReleases(targetOf(name, env));
      return { releases: releases.filter((r) => r.channel === env.channel) };
    }
    if (method === 'GET' && resource === 'releases' && id && !action) {
      return { release: await releaseIn(targetOf(name, env), env, id) };
    }
    if (method === 'GET' && resource === 'next-version') {
      const target = targetOf(name, env);
      const next: Record<string, number> = {};
      for (const p of platformsOf(env)) next[p] = await nextBundleVersion(target, env.channel, p);
      return { next };
    }
    if (method !== 'POST') throw new HttpError(404, 'not found');

    const target = targetOf(name, env);
    requireConfirm(name, env, body);

    if (resource === 'releases' && id && action) {
      await releaseIn(target, env, id);
      if (action === 'rollout') await setRollout(target, id, integer(body.pct, 'pct', 0, 100));
      else if (action === 'pause') await setPaused(target, id, body.paused !== false);
      else if (action === 'rollback') await rollbackRelease(target, id);
      else throw new HttpError(404, `unknown action: ${action}`);
      return { ok: true };
    }
    if (resource === 'native-policy') {
      const storeUrl = optionalText(body.storeUrl, 'storeUrl', 500);
      if (storeUrl && !/^(https|market|itms-apps):\/\//.test(storeUrl)) {
        throw new HttpError(400, 'storeUrl must be an https://, market:// or itms-apps:// link');
      }
      if (body.severity !== 'soft' && body.severity !== 'hard') throw new HttpError(400, 'severity must be soft or hard');
      await setNativePolicy(target, {
        channel: env.channel,
        minSupportedNativeVersion: integer(body.min, 'min', 0, 2_000_000_000),
        severity: body.severity,
        ...(storeUrl ? { storeUrl } : {}),
      });
      return { ok: true };
    }
    if (resource === 'register-key') {
      const publicPath = inProject(env.keyPath).replace(/\.private\.pem$/, '.public.json');
      if (!publicPath.endsWith('.public.json') || !existsSync(publicPath)) {
        throw new HttpError(400, `public key not found next to the signing key (${env.keyId}.public.json)`);
      }
      const { publicKeyRawB64 } = JSON.parse(readFileSync(publicPath, 'utf8')) as { publicKeyRawB64?: string };
      if (!publicKeyRawB64) throw new HttpError(400, `${publicPath} has no publicKeyRawB64`);
      await registerKey(target, env.keyId, publicKeyRawB64);
      return { ok: true };
    }
    if (resource === 'publish') {
      if (latest?.status === 'running') throw new HttpError(409, `a publish to ${latest.env} is already running`);
      const allowed = platformsOf(env);
      const requested = Array.isArray(body.platforms) ? [...new Set(body.platforms)] : [];
      if (requested.length === 0 || requested.some((p) => !allowed.includes(p as Platform))) {
        throw new HttpError(400, `platforms must be a non-empty subset of: ${allowed.join(', ')}`);
      }
      const releaseNotes = optionalText(body.releaseNotes, 'releaseNotes', 2000);
      const targetAppVersions = optionalText(body.targetAppVersions, 'targetAppVersions', 200);
      const job = startPublish(name, env, target, {
        platforms: requested as Platform[],
        rollout: integer(body.rollout, 'rollout', 0, 100),
        mandatory: body.mandatory === true,
        ...(releaseNotes ? { releaseNotes } : {}),
        ...(targetAppVersions ? { targetAppVersions } : {}),
      });
      return { jobId: job.id };
    }
    throw new HttpError(404, 'not found');
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A page on another origin can resolve its own hostname to 127.0.0.1; its Host header gives it away.
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'forbidden host' });

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return sendPage(res, page);
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (!tokenMatches(req.headers['x-dash-session'], expected)) return send(res, 401, { error: 'invalid session' });

    let parts: string[];
    try {
      parts = url.pathname.slice('/api/'.length).split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return send(res, 400, { error: 'malformed path' });
    }
    const body = method === 'POST' ? await readJson(req) : {};

    if (method === 'GET' && parts.length === 1 && parts[0] === 'envs') {
      return send(res, 200, {
        environments: Object.entries(config.environments).map(([name, env]) => describe(name, env)),
      });
    }
    if (parts[0] === 'envs' && parts[1]) {
      return send(
        res,
        method === 'POST' && parts[2] === 'publish' ? 202 : 200,
        await handleEnv(method, parts[1], parts.slice(2), body),
      );
    }
    if (method === 'GET' && parts[0] === 'jobs' && parts[1] === 'latest') {
      return send(res, 200, { job: latest ? { id: latest.id, env: latest.env, status: latest.status } : null });
    }
    if (method === 'GET' && parts[0] === 'jobs' && parts[1]) {
      const job = jobs.get(parts[1]);
      if (!job) return send(res, 404, { error: 'unknown job' });
      const since = Math.max(0, Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0);
      return send(res, 200, {
        id: job.id,
        env: job.env,
        status: job.status,
        error: job.error,
        results: job.results,
        events: job.events.slice(since),
        next: job.events.length,
      });
    }
    return send(res, 404, { error: 'not found' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = err instanceof HttpError ? err.status : 500;
      send(res, status, { error: errorText(err), ...(err instanceof HttpError ? err.extra : {}) });
    });
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      fail(err.code === 'EADDRINUSE' ? new Error(`port ${opts.port ?? 4460} is in use — pass --port <n>`) : err),
    );
    server.listen(opts.port ?? 4460, '127.0.0.1', () => ok());
  });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/#t=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
