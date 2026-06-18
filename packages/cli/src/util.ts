/**
 * CLI utilities: arg parsing, interactive prompts (built-in readline — no deps), backend
 * admin API calls, recursive bundle-dir reading, and project runtimeVersion fingerprinting.
 *
 * @module util
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as readline from 'node:readline/promises';
import { type ArchiveFile, computeRuntimeVersion, type FingerprintInputs } from '@dash-ota/shared';

/** Parsed CLI args: positional `_` plus `--flag value` / `--bool` flags. */
export interface ParsedArgs {
  _: string[];
  flags: Record<string, string | boolean>;
}

/** Parse argv into positionals + flags (`--k v`, `--k=v`, `--bool`). */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.flags[key] = next;
      i++;
    } else {
      out.flags[key] = true;
    }
  }
  return out;
}

/** Get a string flag or fallback. */
export function flagStr(args: ParsedArgs, name: string, fallback = ''): string {
  const v = args.flags[name];
  return typeof v === 'string' ? v : fallback;
}

/** Get a boolean flag. */
export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}

/** Prompt for a single line, with an optional default. */
export async function ask(question: string, fallback?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `);
    return answer.trim() || fallback || '';
  } finally {
    rl.close();
  }
}

/** Prompt yes/no. */
export async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
  const a = (await ask(`${question} (y/n)`, defaultYes ? 'y' : 'n')).toLowerCase();
  return a.startsWith('y');
}

/** Prompt for multi-line text (release notes); end input with a single "." on its own line. */
export async function askMultiline(question: string): Promise<string> {
  console.log(`${question} (end with a single "." on its own line):`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];
  try {
    for (;;) {
      const line = await rl.question('');
      if (line.trim() === '.') break;
      lines.push(line);
    }
  } finally {
    rl.close();
  }
  return lines.join('\n').trim();
}

/** Resolve the backend base URL + admin token from flags or env. */
export function resolveServer(args: ParsedArgs): { server: string; adminToken: string } {
  return {
    server: flagStr(args, 'server', process.env.OTA_SERVER ?? 'http://localhost:4455'),
    adminToken: flagStr(args, 'admin-token', process.env.OTA_ADMIN_TOKEN ?? 'dev-admin-token'),
  };
}

/** POST JSON to an admin endpoint; throws on non-2xx. */
export async function adminPost(server: string, path: string, body: unknown, adminToken: string): Promise<unknown> {
  const res = await fetch(`${server}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ota-admin-token': adminToken },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

/** GET JSON from an admin endpoint; throws on non-2xx. */
export async function adminGet(server: string, path: string, adminToken: string): Promise<unknown> {
  const res = await fetch(`${server}${path}`, { headers: { 'x-ota-admin-token': adminToken } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

/** Recursively list files under a dir (returns absolute paths). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Read a bundle directory into archive files with POSIX-style relative paths. */
export function readBundleDir(dir: string): ArchiveFile[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`bundle dir not found: ${dir}`);
  return walk(dir).map((abs) => ({
    path: relative(dir, abs).split(sep).join('/'),
    data: readFileSync(abs),
  }));
}

/** Cheap, deterministic hash of a native source tree (relpath + size; content-hash in prod). */
function hashNativeDir(dir: string): string {
  if (!existsSync(dir)) return 'absent';
  const entries = walk(dir)
    .map((abs) => `${relative(dir, abs).split(sep).join('/')}:${statSync(abs).size}`)
    .sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Compute a project's runtimeVersion from its native inputs. Best-effort for the POC:
 * hashes all dependencies + RN version + native dir shapes + Hermes version. A production
 * version should use a curated native-dependency allowlist and content-hash native trees.
 * @param projectPath path to the React Native app
 * @returns the runtimeVersion string
 */
export function fingerprintProject(projectPath: string): { runtimeVersion: string; inputs: FingerprintInputs } {
  const pkgPath = join(projectPath, 'package.json');
  if (!existsSync(pkgPath)) throw new Error(`no package.json at ${projectPath}`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  const nativeDependencies = Object.entries(deps).map(([n, v]) => `${n}@${v}`);

  const rnPkgPath = join(projectPath, 'node_modules', 'react-native', 'package.json');
  const reactNativeVersion = existsSync(rnPkgPath)
    ? (JSON.parse(readFileSync(rnPkgPath, 'utf8')) as { version: string }).version
    : (deps['react-native'] ?? 'unknown');

  const hermesVersionPath = join(projectPath, 'node_modules', 'react-native', 'sdks', '.hermesversion');
  const hermesVersion = existsSync(hermesVersionPath) ? readFileSync(hermesVersionPath, 'utf8').trim() : 'bundled';

  const inputs: FingerprintInputs = {
    nativeDependencies,
    nativeDirHashes: { android: hashNativeDir(join(projectPath, 'android')), ios: hashNativeDir(join(projectPath, 'ios')) },
    hermesVersion,
    reactNativeVersion,
  };
  return { runtimeVersion: computeRuntimeVersion(inputs), inputs };
}
