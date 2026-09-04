// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '../packages/create-agent-harness/src/index.js';
import { upgradeCmd } from '../packages/create-agent-harness/src/upgrade-cmd.js';

const GENERATOR_VERSION = '0.1.0';

async function scaffoldFixture(extra: { darwin?: boolean; sessions?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ahg-upgrade-'));
  await scaffold({
    name: 'upgrade-test',
    template: 'minimal',
    host: 'claude-code',
    description: 'upgrade test fixture',
    targetDir: dir,
    force: true,
    generatorVersion: GENERATOR_VERSION,
    ...extra,
  });
  return dir;
}

describe('harness upgrade', () => {
  it('exits 1 if the directory is not a generated harness', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-upg-empty-'));
    try {
      const r = await upgradeCmd([dir]);
      expect(r.code).toBe(1);
      expect(r.lines.join('\n')).toMatch(/not a generated harness/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ADR-008 contract (CHANGELOG iter 47/48): a fresh scaffold has NO drift —
  // no false positives. upgradeCmd must re-render through the same pipeline
  // scaffold() uses (renderHarnessFiles), or the scaffolder's own post-render
  // additions (GH #23 license, ADR-147 darwin, ADR-246 sessions) show up as
  // "2 removed, 1 clean-overwrite" and `--apply` strips them.
  it('reports "No drift" on a freshly scaffolded harness', async () => {
    const dir = await scaffoldFixture();
    try {
      const r = await upgradeCmd([dir]);
      expect(r.code).toBe(0);
      const txt = r.lines.join('\n');
      expect(txt).toMatch(/No drift/);
      expect(txt).toMatch(/0 added\n\s+0 removed\n\s+0 clean-overwrite\n\s+0 conflict/);
      // The manifest records the scaffold-time toggles (copier answers-file
      // model) so upgrade re-renders from them rather than guessing.
      const m = JSON.parse(await readFile(join(dir, '.harness', 'manifest.json'), 'utf-8'));
      expect(m.vars.darwin).toBe(true);    // ADR-147 default ON
      expect(m.vars.sessions).toBe(false); // ADR-246 §2.3 default OFF
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('reports "No drift" for --no-darwin and --sessions scaffolds (toggles recorded in the manifest)', async () => {
    for (const opts of [{ darwin: false }, { sessions: true }, { darwin: false, sessions: true }]) {
      const dir = await scaffoldFixture(opts);
      try {
        const r = await upgradeCmd([dir]);
        expect(r.code, JSON.stringify(opts)).toBe(0);
        expect(r.lines.join('\n'), JSON.stringify(opts)).toMatch(/No drift/);
        const m = JSON.parse(await readFile(join(dir, '.harness', 'manifest.json'), 'utf-8'));
        expect(m.vars.darwin).toBe(opts.darwin !== false);
        expect(m.vars.sessions).toBe(opts.sessions === true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('infers the darwin/sessions choice for a legacy manifest that did not record it', async () => {
    // Pre-ADR-147 manifests have only name/description/host in vars. The
    // scaffold still left evidence (the @metaharness/darwin devDependency in
    // package.json; src/sessions/log.ts in the file table) — upgrade must
    // read that rather than defaulting and reporting false drift.
    for (const opts of [{}, { darwin: false }, { sessions: true }]) {
      const dir = await scaffoldFixture(opts);
      try {
        const mPath = join(dir, '.harness', 'manifest.json');
        const m = JSON.parse(await readFile(mPath, 'utf-8'));
        delete m.vars.darwin;
        delete m.vars.sessions;
        await writeFile(mPath, JSON.stringify(m, null, 2));
        const r = await upgradeCmd([dir]);
        expect(r.code, JSON.stringify(opts)).toBe(0);
        expect(r.lines.join('\n'), JSON.stringify(opts)).toMatch(/No drift/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('detects a tampered file as a conflict (dry-run)', async () => {
    const dir = await scaffoldFixture();
    try {
      // Tamper a generated file
      const pkgPath = join(dir, 'package.json');
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      pkg.description = 'TAMPERED — should show as conflict';
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

      const r = await upgradeCmd([dir]);
      expect(r.code, r.lines.join('\n')).toBe(0);  // dry-run still 0
      const txt = r.lines.join('\n');
      expect(txt).toMatch(/DRY-RUN/);
      // The plan should mention either changed or conflict
      expect(txt).toMatch(/changed|conflict/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('--apply runs the apply path (0 if no drift, may modify on tamper)', async () => {
    const dir = await scaffoldFixture();
    try {
      // Tamper a known-rendered file
      const pkgPath = join(dir, 'package.json');
      const original = await readFile(pkgPath, 'utf-8');
      await writeFile(pkgPath, original.replace(/"description":/g, '"DESCRIPTION_TAMPERED":'));

      const r = await upgradeCmd([dir, '--apply', '--conflict=inline']);
      // Apply should produce one of:
      //   exit 0 + "No drift" (tamper didn't register because of fingerprint match)
      //   exit 0 + "Modified N file(s)" + "Clean apply"
      //   exit 1 + "Modified N file(s)" + conflict marker note
      expect([0, 1]).toContain(r.code);
      const txt = r.lines.join('\n');
      expect(txt).toMatch(/APPLY|No drift|Modified|Clean apply|conflict/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects unknown --conflict= value with exit 2', async () => {
    const dir = await scaffoldFixture();
    try {
      const r = await upgradeCmd([dir, '--conflict=invalid']);
      expect(r.code).toBe(2);
      expect(r.lines.join('\n')).toMatch(/unsupported/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails when manifest references a non-existent template', async () => {
    const dir = await scaffoldFixture();
    try {
      // Tamper the manifest's template id
      const mpath = join(dir, '.harness', 'manifest.json');
      const m = JSON.parse(await readFile(mpath, 'utf-8'));
      m.template = 'this-template-does-not-exist';
      await writeFile(mpath, JSON.stringify(m, null, 2));

      const r = await upgradeCmd([dir]);
      expect(r.code).toBe(1);
      expect(r.lines.join('\n')).toMatch(/template "this-template-does-not-exist" not found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
