/**
 * Regenerates the client API reference from the source TSDoc.
 *
 * TypeDoc clears its output directory on every run, so the Docusaurus category file has to be
 * written afterwards rather than committed and left alone. Run: `npm run docs:api`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(site, 'docs/api/client');

execFileSync('npx', ['typedoc'], { cwd: site, stdio: 'inherit' });

// TypeDoc writes index.md with a bare H1; give it front matter and say where it came from.
const index = join(out, 'index.md');
const body = readFileSync(index, 'utf8').replace(/^#[^\n]*\n+/, '');
writeFileSync(
  index,
  `---
title: Client reference
sidebar_position: 0
---

# Client reference

Every export of \`react-native-dash-ota\`, generated from the source TSDoc by
\`npm run docs:api\`. For a curated tour of the same surface, start at
[react-native-dash-ota](/docs/api/react-native).

${body}`,
);

writeFileSync(
  join(out, '_category_.json'),
  JSON.stringify(
    {
      label: 'Client reference',
      position: 4,
      link: { type: 'doc', id: 'api/client/index' },
      customProps: { generated: true },
    },
    null,
    2,
  ) + '\n',
);

console.log('api reference: regenerated from packages/rn/src/index.tsx');
