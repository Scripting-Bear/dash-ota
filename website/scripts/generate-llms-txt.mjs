/**
 * Emits `static/llms.txt` — a flat index of the docs for language models and agents.
 * Runs as a prebuild step so it can never drift from the pages that actually exist.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const docsDir = join(root, 'docs');
const SITE = 'https://scripting-bear.github.io/dash-ota';

/** Read the `title` and `description` out of a page's front matter. */
function frontMatter(file) {
  const text = readFileSync(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  const read = (key) => {
    const hit = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(match[1]);
    return hit ? hit[1].trim().replace(/^['"]|['"]$/g, '') : undefined;
  };
  return {
    title: read('title'),
    description: read('description'),
    slug: read('slug'),
    position: Number(read('sidebar_position')),
  };
}

/** Category label for a directory, from its `_category_.json`. */
function categoryLabel(dir) {
  try {
    const meta = JSON.parse(readFileSync(join(dir, '_category_.json'), 'utf8'));
    return { label: meta.label ?? null, position: meta.position ?? 99 };
  } catch {
    return { label: null, position: 99 };
  }
}

function walk(dir) {
  const pages = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) continue;
    if (!/\.mdx?$/.test(name)) continue;
    const fm = frontMatter(full);
    const path = relative(docsDir, full).replace(/\.mdx?$/, '');
    // A `slug` in front matter replaces the file path entirely.
    const slug = fm.slug ? fm.slug.replace(/^\//, '') : path;
    pages.push({ title: fm.title ?? path, description: fm.description, position: fm.position ?? 99, slug });
  }
  return pages.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
}

const lines = [
  '# dash-ota',
  '',
  '> Self-hosted over-the-air updates for React Native. The CLI signs releases with an Ed25519',
  '> key you hold, the backend only distributes them, and the device verifies against a public',
  '> key compiled into the binary — so a breached backend cannot forge an update.',
  '',
];

for (const page of walk(docsDir)) {
  lines.push(`- [${page.title}](${SITE}/docs/${page.slug})${page.description ? `: ${page.description}` : ''}`);
}
lines.push('');

const dirs = readdirSync(docsDir)
  .map((name) => ({ name, full: join(docsDir, name) }))
  .filter(({ full }) => statSync(full).isDirectory())
  .map(({ name, full }) => ({ name, full, ...categoryLabel(full) }))
  .sort((a, b) => a.position - b.position);

for (const dir of dirs) {
  const pages = walk(dir.full);
  if (pages.length === 0) continue;
  lines.push(`## ${dir.label ?? dir.name}`, '');
  for (const page of pages) {
    lines.push(`- [${page.title}](${SITE}/docs/${page.slug})${page.description ? `: ${page.description}` : ''}`);
  }
  lines.push('');
}

mkdirSync(join(root, 'static'), { recursive: true });
writeFileSync(join(root, 'static', 'llms.txt'), lines.join('\n'));
console.log(`llms.txt: ${lines.filter((l) => l.startsWith('- [')).length} pages indexed`);
