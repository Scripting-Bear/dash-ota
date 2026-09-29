/**
 * Release operations shared by the CLI commands and the dashboard, so both run one implementation.
 *
 * @module core
 */

import { spawn } from 'node:child_process';
import type { KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ArchiveFile,
  buildReleaseV2,
  type Channel,
  type Platform,
  type SignedManifest,
  signManifest,
  verifyManifest,
} from '@dash-ota/shared';
import { adminGet, adminPost, adminPutBytes, decryptPrivateKeyPem, formatBytes, isEncryptedPem } from './util.js';

/** Where admin calls go. */
export interface Target {
  server: string;
  adminToken: string;
}

/** Progress from long-running operations. `plan` is how many blobs the server still needs. */
export type OtaEvent =
  | { type: 'log'; message: string }
  | { type: 'plan'; upload: number; total: number }
  | { type: 'upload'; done: number; total: number };

export type OnEvent = (event: OtaEvent) => void;

const silent: OnEvent = () => undefined;

/** A release as listed by `GET /admin/releases`. */
export interface ReleaseSummary {
  bundleId: string;
  channel: string;
  platform: string;
  runtimeVersion: string;
  bundleVersion: number;
  rolloutPercentage: number;
  paused: boolean;
  rolledBack: boolean;
  mandatory?: boolean;
  releaseNotes?: string;
  createdAt?: string;
  adoption: Record<string, number>;
}

/** Locate the RN-bundled `hermesc` binary for the current OS, or null if absent. */
export function resolveHermesc(project: string): string | null {
  const base = join(project, 'node_modules', 'react-native', 'sdks', 'hermesc');
  const rel =
    process.platform === 'darwin'
      ? 'osx-bin/hermesc'
      : process.platform === 'win32'
        ? 'win64-bin/hermesc.exe'
        : 'linux64-bin/hermesc';
  const p = join(base, rel);
  return existsSync(p) ? p : null;
}

function lineSink(onEvent: OnEvent): { write: (chunk: Buffer) => void; end: () => void } {
  let rest = '';
  const emit = (line: string): void => {
    if (line.trim()) onEvent({ type: 'log', message: line });
  };
  return {
    write: (chunk) => {
      const parts = (rest + chunk.toString('utf8')).split(/\r?\n|\r/);
      rest = parts.pop() ?? '';
      parts.forEach(emit);
    },
    end: () => {
      emit(rest);
      rest = '';
    },
  };
}

/** Run a command, forwarding its output line by line; rejects on a non-zero exit. */
export function runStreaming(label: string, command: string, args: string[], cwd: string, onEvent: OnEvent): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
    const out = lineSink(onEvent);
    const err = lineSink(onEvent);
    child.stdout.on('data', out.write);
    child.stderr.on('data', err.write);
    child.on('error', reject);
    child.on('close', (code) => {
      out.end();
      err.end();
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (exit ${code ?? 'signal'})`));
    });
  });
}

export interface BundleOptions {
  project: string;
  platform: Platform;
  out: string;
  entry?: string;
  dev?: boolean;
  hermes?: boolean;
}

/** `react-native bundle` into `out`, optionally compiled to Hermes bytecode in place. Returns the bundle path. */
export async function bundleProject(opts: BundleOptions, onEvent: OnEvent = silent): Promise<string> {
  mkdirSync(opts.out, { recursive: true });
  const bundle = join(opts.out, opts.platform === 'android' ? 'index.android.bundle' : 'main.jsbundle');
  const args = [
    'react-native',
    'bundle',
    `--platform=${opts.platform}`,
    `--dev=${Boolean(opts.dev)}`,
    `--entry-file=${opts.entry ?? 'index.js'}`,
    `--bundle-output=${bundle}`,
    `--assets-dest=${opts.out}`,
  ];
  onEvent({ type: 'log', message: `$ npx ${args.join(' ')}` });
  await runStreaming('react-native bundle', 'npx', args, opts.project, onEvent);

  if (opts.hermes) {
    // Fail loud rather than ship a plain JS bundle to a Hermes app.
    const hermesc = resolveHermesc(opts.project);
    if (!hermesc) {
      throw new Error('hermesc was not found under node_modules/react-native/sdks/hermesc — cannot produce an HBC bundle');
    }
    const hbc = `${bundle}.hbc`;
    onEvent({ type: 'log', message: `$ ${hermesc} -emit-binary -O -out ${hbc} ${bundle}` });
    await runStreaming('hermesc', hermesc, ['-emit-binary', '-O', '-out', hbc, bundle], opts.project, onEvent);
    renameSync(hbc, bundle);
    onEvent({ type: 'log', message: `✓ compiled Hermes bytecode (HBC): ${bundle}` });
  }
  return bundle;
}

/** Read a signing key, decrypting it when it is passphrase-protected. */
export function loadSigningKey(keyPath: string, passphrase?: string): string {
  if (!existsSync(keyPath)) throw new Error(`signing key not found: ${keyPath}`);
  const pem = readFileSync(keyPath, 'utf8');
  if (!isEncryptedPem(pem)) return pem;
  if (!passphrase) throw new Error('signing key is encrypted — provide a passphrase (OTA_KEY_PASSPHRASE)');
  try {
    return decryptPrivateKeyPem(pem, passphrase);
  } catch {
    throw new Error('failed to decrypt the signing key — wrong passphrase?');
  }
}

/** Read a channel content key: base64 of exactly 32 bytes. */
export function readContentKey(path: string): Buffer {
  if (!existsSync(path)) throw new Error(`content key not found: ${path}`);
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`content key must be 32 bytes (got ${key.length}): ${path}`);
  return key;
}

export interface ReleaseInput {
  files: ArchiveFile[];
  platform: Platform;
  channel: Channel;
  runtimeVersion: string;
  bundleVersion: number;
  appId: string;
  mandatory: boolean;
  keyId: string;
  privateKeyPem: string;
  encrypt: boolean;
  contentKey?: Buffer;
  verifyKey: { key: KeyObject; source: string };
  bundleId?: string;
  compressionLevel?: number;
  targetAppVersions?: string;
  releaseNotes?: string;
}

export interface PreparedRelease {
  bundleId: string;
  signed: SignedManifest;
  blobs: Map<string, Buffer>;
}

/** Build, sign and self-verify a release. Nothing leaves the machine. */
export async function prepareRelease(input: ReleaseInput, onEvent: OnEvent = silent): Promise<PreparedRelease> {
  if (input.files.length === 0) throw new Error('the bundle directory is empty');
  const bundlePath = input.files.find((f) => /(^|\/)(index\.android\.bundle|main\.jsbundle)$/.test(f.path))?.path;
  if (!bundlePath) throw new Error('no index.android.bundle or main.jsbundle in the bundle dir');
  const bundleId = input.bundleId ?? `bnd_${input.runtimeVersion}_${input.bundleVersion}_${Date.now().toString(36)}`;

  const built = await buildReleaseV2({
    bundleId,
    runtimeVersion: input.runtimeVersion,
    bundleVersion: input.bundleVersion,
    platform: input.platform,
    channel: input.channel,
    appId: input.appId,
    mandatory: input.mandatory,
    files: input.files,
    bundlePath,
    keyId: input.keyId,
    encrypt: input.encrypt,
    ...(input.contentKey ? { contentKey: input.contentKey } : {}),
    ...(input.compressionLevel ? { bundleCompressionLevel: input.compressionLevel } : {}),
    ...(input.targetAppVersions ? { targetAppVersions: input.targetAppVersions } : {}),
    ...(input.releaseNotes ? { releaseNotes: input.releaseNotes } : {}),
  });
  const signed = signManifest(built.manifest, input.privateKeyPem);

  // Verify against the key the app embeds before upload; a mismatch would ship an update every device rejects.
  if (!verifyManifest(signed, input.verifyKey.key)) {
    throw new Error(
      `self-verify FAILED against ${input.verifyKey.source}: the app embeds this key and would REJECT this update. Aborting.`,
    );
  }
  onEvent({ type: 'log', message: `  ✓ self-verified signature (${input.verifyKey.source})` });

  const plaintextBytes = input.files.reduce((sum, f) => sum + f.data.length, 0);
  const storedBytes = [...built.blobs.values()].reduce((sum, b) => sum + b.length, 0);
  onEvent({ type: 'log', message: `\n  bundleId:        ${bundleId}` });
  onEvent({ type: 'log', message: `  runtimeVersion:  ${input.runtimeVersion}   bundleVersion: ${input.bundleVersion}` });
  onEvent({
    type: 'log',
    message:
      `  files:           ${input.files.length} (${built.blobs.size} distinct blobs)   ` +
      `${formatBytes(plaintextBytes)} → ${formatBytes(storedBytes)}`,
  });
  onEvent({ type: 'log', message: `  encryption:      ${built.manifest.encryption.mode}` });
  return { bundleId, signed, blobs: built.blobs };
}

/**
 * Declare the release, upload only the blobs the server lacks, then finalize. Re-running after a
 * failure re-declares the same manifest and uploads only the gap.
 */
export async function uploadRelease(
  target: Target,
  prepared: PreparedRelease,
  rollout: number,
  onEvent: OnEvent = silent,
): Promise<{ bundleId: string; uploaded: number; total: number; response: unknown }> {
  assertPercent(rollout);
  const created = (await adminPost(
    target.server,
    '/admin/releases',
    { signedManifest: prepared.signed, rolloutPercentage: rollout },
    target.adminToken,
  )) as { missing?: string[] };
  const missing = created.missing ?? [];
  const total = prepared.blobs.size;
  onEvent({ type: 'plan', upload: missing.length, total });
  onEvent({
    type: 'log',
    message: `  uploading:       ${missing.length} of ${total} blobs (${total - missing.length} already present)   rollout: ${rollout}%`,
  });

  let done = 0;
  for (const sha of missing) {
    const bytes = prepared.blobs.get(sha);
    if (!bytes) throw new Error(`server asked for a blob this release does not contain: ${sha}`);
    await adminPutBytes(
      target.server,
      `/admin/releases/${encodeURIComponent(prepared.bundleId)}/blobs/${sha}`,
      bytes,
      target.adminToken,
    );
    done += 1;
    onEvent({ type: 'upload', done, total: missing.length });
  }

  const response = await adminPost(
    target.server,
    `/admin/releases/${encodeURIComponent(prepared.bundleId)}/finalize`,
    {},
    target.adminToken,
  );
  return { bundleId: prepared.bundleId, uploaded: missing.length, total, response };
}

function assertPercent(pct: number): void {
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new Error(`rollout must be an integer 0–100 (got ${pct})`);
}

function assertBundleId(bundleId: string): void {
  if (!bundleId) throw new Error('bundleId is required');
}

export async function listReleases(target: Target): Promise<ReleaseSummary[]> {
  const data = (await adminGet(target.server, '/admin/releases', target.adminToken)) as { releases?: ReleaseSummary[] };
  return data.releases ?? [];
}

export async function getRelease(target: Target, bundleId: string): Promise<Record<string, unknown>> {
  assertBundleId(bundleId);
  const data = (await adminGet(target.server, `/admin/releases/${encodeURIComponent(bundleId)}`, target.adminToken)) as {
    release: Record<string, unknown>;
  };
  return data.release;
}

/**
 * One past the highest version already published for this channel and platform. The server accepts
 * a lower number silently, and such a release is never offered to anyone.
 */
export async function nextBundleVersion(target: Target, channel: string, platform: Platform): Promise<number> {
  const releases = await listReleases(target);
  const highest = releases
    .filter((r) => r.channel === channel && r.platform === platform)
    .reduce((max, r) => Math.max(max, Number(r.bundleVersion) || 0), 0);
  return highest + 1;
}

export async function setRollout(target: Target, bundleId: string, pct: number): Promise<void> {
  assertBundleId(bundleId);
  assertPercent(pct);
  await adminPost(target.server, '/admin/rollout', { bundleId, rolloutPercentage: pct }, target.adminToken);
}

export async function setPaused(target: Target, bundleId: string, paused: boolean): Promise<void> {
  assertBundleId(bundleId);
  await adminPost(target.server, '/admin/pause', { bundleId, paused }, target.adminToken);
}

export async function rollbackRelease(target: Target, bundleId: string): Promise<void> {
  assertBundleId(bundleId);
  await adminPost(target.server, '/admin/rollback', { bundleId }, target.adminToken);
}

export interface NativePolicyInput {
  channel: string;
  minSupportedNativeVersion: number;
  severity: string;
  storeUrl?: string;
}

export async function setNativePolicy(target: Target, policy: NativePolicyInput): Promise<void> {
  if (policy.severity !== 'soft' && policy.severity !== 'hard') throw new Error('severity must be soft or hard');
  if (!Number.isInteger(policy.minSupportedNativeVersion) || policy.minSupportedNativeVersion < 0) {
    throw new Error('the minimum native build must be a non-negative integer');
  }
  await adminPost(
    target.server,
    '/admin/native-policy',
    {
      channel: policy.channel,
      minSupportedNativeVersion: policy.minSupportedNativeVersion,
      severity: policy.severity,
      storeUrl: policy.storeUrl || undefined,
    },
    target.adminToken,
  );
}

export async function registerKey(target: Target, keyId: string, publicKeyRawB64: string): Promise<void> {
  await adminPost(target.server, '/admin/keys', { keyId, publicKeyRawB64 }, target.adminToken);
}
