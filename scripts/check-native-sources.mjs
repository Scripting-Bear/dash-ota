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
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

const failures = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (!file.endsWith('.kt')) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (line.includes(ESCAPED_DOLLAR)) failures.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} escaped dollar(s) in Kotlin source — these emit literal text, not values:\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error('\nUse a plain $ for interpolation.\n');
  process.exit(1);
}
console.log('native source checks passed.');
