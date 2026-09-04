#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// scripts/pack-all.mjs — npm-pack every published package into ./_packed/.
// Used by the cross-platform pack+install smoke job.

import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dst = join(root, '_packed');
mkdirSync(dst, { recursive: true });

// Packages excluded from the root workspace (`"!packages/<name>"` in the root
// package.json — today only @metaharness/agntcy, whose `agntcy-dir` dependency
// needs the Buf Schema Registry and would otherwise make `npm ci` impossible
// offline; ADR-240 §5) are installed and built on their own. Pack one only
// when that has actually happened (it has a node_modules/), otherwise the
// tarball would ship without dist/ and install-all would try to resolve its
// deps from a registry the runner may not reach.
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const excluded = new Set(
  (rootPkg.workspaces ?? [])
    .filter(w => typeof w === 'string' && w.startsWith('!packages/'))
    .map(w => w.slice('!packages/'.length)),
);

const packages = readdirSync(join(root, 'packages'));
let count = 0;
for (const name of packages) {
  const pj = join(root, 'packages', name, 'package.json');
  if (!existsSync(pj)) continue;
  const pkg = JSON.parse(readFileSync(pj, 'utf-8'));
  if (pkg.private) {
    console.log(`skip private: ${pkg.name}`);
    continue;
  }
  if (excluded.has(name) && !existsSync(join(root, 'packages', name, 'node_modules'))) {
    console.log(`skip not-installed (outside the root workspace, installed separately): ${pkg.name}`);
    continue;
  }
  console.log(`pack: ${pkg.name}`);
  const out = execSync('npm pack --json', { cwd: join(root, 'packages', name) }).toString();
  // npm pack --json emits an array containing { filename }.
  const arr = JSON.parse(out);
  for (const entry of arr) {
    const src = join(root, 'packages', name, entry.filename);
    const finalPath = join(dst, entry.filename);
    renameSync(src, finalPath);
    count++;
  }
}
console.log(`Packed ${count} tarball(s) into ${dst}`);
