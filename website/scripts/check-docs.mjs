/**
 * Guards against the four ways these docs have actually gone wrong before:
 *
 *   1. a command that does not exist  (`dash-ota keys generate` shipped on the landing page)
 *   2. a flag the command does not accept  (`rollout --rollout` silently ramped to 100%)
 *   3. `:::warning Title` instead of `:::warning[Title]`  (12 pages rendered the marker as text,
 *      and the build passed anyway)
 *   4. a Node version in prose that disagrees with what the code requires
 *
 * The CLI stays the single source of truth: commands and flags are read out of its own
 * `KNOWN_FLAGS` table rather than restated here. Run: `npm run check:docs`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..');
const repo = join(site, '..');
const problems = [];

const fail = (file, line, message) => problems.push({ file, line, message });

/* ---------------------------------------------------- the CLI's own flag table */

function readCliFlags() {
  const src = readFileSync(join(repo, 'packages/cli/src/util.ts'), 'utf8');

  const serverMatch = /const SERVER_FLAGS = \[([^\]]*)\]/.exec(src);
  if (!serverMatch) throw new Error('SERVER_FLAGS not found in packages/cli/src/util.ts');
  const serverFlags = [...serverMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const tableMatch = /const KNOWN_FLAGS: Record<string, string\[\]> = \{([\s\S]*?)\n\};/.exec(src);
  if (!tableMatch) throw new Error('KNOWN_FLAGS not found in packages/cli/src/util.ts');

  const commands = {};
  const entry = /(?:^|\n)\s*'?([a-z-]+)'?:\s*\[([\s\S]*?)\],/g;
  let m;
  while ((m = entry.exec(tableMatch[1])) !== null) {
    const flags = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    if (m[2].includes('...SERVER_FLAGS')) flags.push(...serverFlags);
    commands[m[1]] = flags;
  }
  if (Object.keys(commands).length < 5) throw new Error('parsed too few commands from KNOWN_FLAGS');
  return commands;
}

/* ---------------------------------------------------- walk the docs */

function markdownFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...markdownFiles(full));
    else if (/\.mdx?$/.test(name)) found.push(full);
  }
  return found;
}

const CLI = readCliFlags();
const KNOWN_COMMANDS = new Set(Object.keys(CLI));
const ADMONITIONS = /^:::(note|tip|info|caution|warning|danger)\s+\S/;

/**
 * Commands inside fenced blocks, with `\` continuations joined so a flag list stays one command.
 * A block containing `✗` is demonstrating a rejected command, so it is skipped.
 */
function commandInvocations(text) {
  const out = [];
  const lines = text.split('\n');
  let inFence = false;
  let fenceIsErrorDemo = false;
  let buffer = null;

  const flush = () => {
    if (buffer) out.push(buffer);
    buffer = null;
  };

  lines.forEach((raw, i) => {
    if (/^\s*```/.test(raw)) {
      flush();
      if (!inFence) {
        // Look ahead: does this block show the CLI refusing something?
        const close = lines.findIndex((l, n) => n > i && /^\s*```/.test(l));
        fenceIsErrorDemo = lines.slice(i + 1, close === -1 ? undefined : close).some((l) => l.includes('✗'));
      }
      inFence = !inFence;
      return;
    }
    if (!inFence || fenceIsErrorDemo) return;

    const line = raw.replace(/\s*#.*$/, '').trimEnd();
    if (buffer) {
      buffer.text += ' ' + line.replace(/\\$/, '').trim();
      if (!line.endsWith('\\')) flush();
      return;
    }
    const hit = /(?:^|\s|\$\s)(?:npx\s+)?dash-ota\s+([a-z-]+)/.exec(line);
    if (!hit) return;
    buffer = { line: i + 1, command: hit[1], text: line.replace(/\\$/, '').trim() };
    if (!line.endsWith('\\')) flush();
  });
  flush();
  return out;
}

for (const file of markdownFiles(join(site, 'docs'))) {
  // The generated API reference is not hand-written prose; skip it.
  if (file.includes(join('api', 'client'))) continue;
  const rel = relative(repo, file);
  const text = readFileSync(file, 'utf8');

  text.split('\n').forEach((line, i) => {
    if (ADMONITIONS.test(line)) {
      fail(rel, i + 1, `admonition title needs brackets: ${line.trim().slice(0, 48)} → :::type[Title]`);
    }
  });

  for (const call of commandInvocations(text)) {
    if (!KNOWN_COMMANDS.has(call.command)) {
      fail(rel, call.line, `\`dash-ota ${call.command}\` is not a command`);
      continue;
    }
    const accepted = CLI[call.command];
    for (const [, flag] of call.text.matchAll(/\s--([a-z][a-z0-9-]*)/g)) {
      if (!accepted.includes(flag)) {
        fail(rel, call.line, `\`dash-ota ${call.command}\` does not accept --${flag}`);
      }
    }
  }
}

/* ---------------------------------------------------- Node version agreement */

const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'));
const zstd = lock.packages?.['node_modules/@mongodb-js/zstd'];
const required = zstd?.engines?.node?.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];

if (required) {
  const floor = `Node ${required}`;
  for (const file of markdownFiles(join(site, 'docs'))) {
    if (file.includes(join('api', 'client'))) continue;
    const rel = relative(repo, file);
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const m = /\bNode(?:\.js)?\s+(\d+)(?:\.(\d+))?\+/.exec(line);
        if (!m) return;
        const stated = Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0);
        const need = Number(required.split('.')[0]) + Number(required.split('.')[1]) / 100;
        if (stated < need) {
          fail(rel, i + 1, `says "${m[0]}" but @mongodb-js/zstd requires ${floor}`);
        }
      });
  }
}

/* ---------------------------------------------------- generated API reference is current */

/*
 * CI builds the site without the React Native package's dependencies, so TypeDoc cannot be re-run
 * there. Instead, compare the package's exported names against the pages already committed under
 * docs/api/client — that catches an export added or removed without `npm run docs:api`.
 */
const apiDir = join(site, 'docs/api/client');
const entry = join(repo, 'packages/rn/src/index.tsx');

try {
  const src = readFileSync(entry, 'utf8');
  const exported = new Set();
  for (const [, names] of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of names.split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) exported.add(name);
    }
  }

  const documented = new Set();
  for (const group of ['functions', 'interfaces', 'type-aliases', 'variables']) {
    const dir = join(apiDir, group);
    try {
      for (const f of readdirSync(dir)) if (f.endsWith('.md')) documented.add(f.replace(/\.md$/, ''));
    } catch {
      /* group absent is fine — not every kind exists */
    }
  }

  for (const name of exported) {
    if (!documented.has(name)) {
      fail('website/docs/api/client', 0, `\`${name}\` is exported but has no generated page — run \`npm run docs:api\``);
    }
  }
  for (const name of documented) {
    if (!exported.has(name)) {
      fail('website/docs/api/client', 0, `\`${name}\` has a generated page but is no longer exported — run \`npm run docs:api\``);
    }
  }
} catch (err) {
  fail('website/scripts/check-docs.mjs', 0, `could not compare the generated API reference: ${err.message}`);
}

/* ---------------------------------------------------- report */

if (problems.length === 0) {
  console.log('check:docs — commands, flags, admonitions and Node version all agree with the code.');
  process.exit(0);
}

console.error(`check:docs found ${problems.length} problem${problems.length > 1 ? 's' : ''}:\n`);
for (const p of problems) console.error(`  ${p.file}:${p.line}  ${p.message}`);
console.error('');
process.exit(1);
