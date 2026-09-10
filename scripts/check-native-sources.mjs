/**
 * Source hygiene checks for the native clients, which no compiler or linter here would catch.
 *
 * `${'$'}` is Kotlin's escape for a literal dollar. It belongs in Gradle files and string
 * templates, never in a `.kt` source: there it turns `"$blobBaseUrl/$blobSha"` into the literal
 * text `$blobBaseUrl/$blobSha`. It compiles, it type-checks, and it fails only on a device — this
 * exact form once shipped a download URL of `$blobBaseUrl/$blobSha`, named every temporary blob
 * `$blobSha.part`, and sent `Range: bytes=$have-`.
 *
 * Run: `npm run lint:native`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOTS = ['packages/rn/android/src', 'packages/rn/ios'];
const ESCAPED_DOLLAR = "${'$'}";

/**
 * @param dir - directory to walk.
 * @param out - accumulator.
 * @returns every file below `dir`.
 */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const files = ROOTS.flatMap((root) => walk(root));
let failed = false;

/**
 * @param title - what went wrong.
 * @param lines - offending locations.
 */
function report(title, lines) {
  failed = true;
  console.error(`\n${title}\n`);
  for (const line of lines) console.error(`  ${line}`);
}

const dollars = [];
for (const file of files.filter((f) => f.endsWith('.kt'))) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (line.includes(ESCAPED_DOLLAR)) dollars.push(`${file}:${i + 1}: ${line.trim()}`);
    });
}
if (dollars.length > 0) {
  report(
    `${dollars.length} escaped dollar(s) in Kotlin source — these emit literal text, not values. Use a plain $:`,
    dollars,
  );
}

// Sweeping slots is safe only at launch, before JS starts and before any download is in flight.
// `markHealthy` used to call it from a timer mid-download and deleted files a staging directory had
// already assembled; the update then committed with them missing and each rendered blank. Both
// clients must therefore have exactly one call site, in the launch path.
for (const [file, pattern] of [
  ['packages/rn/android/src/main/java/com/dashota/DashOtaStore.kt', /^\s*gc\(ctx, state\)/gm],
  ['packages/rn/ios/DashOtaStore.swift', /^\s*gc\(state\)/gm],
]) {
  let body;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const calls = body.split('\n').filter((line) => pattern.test(line.concat('\n')));
  pattern.lastIndex = 0;
  const count = (body.match(pattern) ?? []).length;
  if (count !== 1) {
    report(`${file}: gc() is called ${count} times; it must be called exactly once, from the launch path:`, calls);
  }
}

// The vendored zstd must not leak an un-prefixed global symbol, or a libzstd in the host app can
// silently take over our decoder — see scripts/generate-zstd-prefix.mjs. Verified by compiling the
// amalgamation exactly as the podspec does and reading the symbol table back.
try {
  const vendor = 'packages/rn/ios/vendor';
  const header = join(vendor, 'zstd_symbol_prefix.h');
  if (existsSync(join(vendor, 'zstddeclib.c')) && existsSync(header)) {
    const work = mkdtempSync(join(tmpdir(), 'zstd-check-'));
    try {
      const object = join(work, 'probe.o');
      execFileSync('cc', ['-c', '-O1', '-w', '-include', header, join(vendor, 'zstddeclib.c'), '-I', vendor, '-o', object]);
      const leaked = execFileSync('nm', ['-g', '-U', object], { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim().match(/^[0-9a-f]+\s+[TDBSCI]\s+_(\S+)$/i))
        .filter((m) => m !== null)
        .map((m) => m[1])
        .filter((name) => !name.startsWith('DashOtaZ_'));
      if (leaked.length > 0) {
        report(
          `${leaked.length} un-prefixed global symbol(s) escape the vendored zstd — run \`npm run gen:zstd-prefix\`:`,
          leaked.slice(0, 10),
        );
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.error(`\nskipped the vendored-zstd symbol check: ${error.message}\n`);
}

if (failed) {
  console.error('');
  process.exit(1);
}
console.log('native source checks passed.');
