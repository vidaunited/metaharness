// SPDX-License-Identifier: MIT
//
// .github/workflows/*.yml structural validation.
//
// Catches the silent-CI-drift bugs that actionlint would catch but
// without bringing actionlint into the toolchain. Pins:
//   - every `run: node scripts/<X>.mjs` references a real file
//   - every workflow has unique job names
//   - publish.yml's gate steps run BEFORE the workspace publish step
//   - ci.yml's matrix covers all 3 OS

import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS = join(process.cwd(), '.github', 'workflows');
const SCRIPTS = join(process.cwd(), 'scripts');

async function listWorkflowFiles(): Promise<string[]> {
  const entries = await readdir(WORKFLOWS, { withFileTypes: true });
  return entries.filter(e => e.isFile() && /\.ya?ml$/.test(e.name)).map(e => join(WORKFLOWS, e.name));
}

describe('.github/workflows/*.yml', () => {
  it('every workflow file parses as YAML at the line level (no tab indent)', async () => {
    for (const f of await listWorkflowFiles()) {
      const text = await readFile(f, 'utf-8');
      const tabs = text.split('\n').filter(l => /^\t/.test(l));
      expect(tabs, `${f} has ${tabs.length} tab-indented lines (use spaces)`).toEqual([]);
    }
  });

  it('every "node scripts/<X>.mjs" reference points at a real file', async () => {
    const missing: string[] = [];
    for (const f of await listWorkflowFiles()) {
      const text = await readFile(f, 'utf-8');
      const re = /node scripts\/([\w.-]+\.m?js)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const target = join(SCRIPTS, m[1]);
        if (!existsSync(target)) missing.push(`${f}: scripts/${m[1]}`);
      }
    }
    expect(missing, missing.length ? `missing script refs: ${missing.join(', ')}` : '').toEqual([]);
  });

  it('every job name within a single workflow is unique', async () => {
    for (const f of await listWorkflowFiles()) {
      const text = await readFile(f, 'utf-8');
      const jobs = [...text.matchAll(/^\s{2}([\w-]+):\s*$/gm)]
        .map(m => m[1])
        .filter(n => !['on', 'env', 'permissions', 'jobs', 'inputs', 'concurrency', 'group'].includes(n));
      const dup = jobs.filter((n, i) => jobs.indexOf(n) !== i);
      expect(dup, `${f} has duplicate job-like keys: ${dup.join(', ')}`).toEqual([]);
    }
  });

  it('ci.yml matrix runs every gate on all 3 OS (ubuntu, macos, windows)', async () => {
    const ci = await readFile(join(WORKFLOWS, 'ci.yml'), 'utf-8');
    expect(ci).toMatch(/os:\s*\[ubuntu-latest,\s*macos-latest,\s*windows-latest\]/);
    // Pin that we actually have OS-fanned-out jobs (not just the matrix def)
    expect(ci.match(/runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  // PR #152 post-mortem: publish.yml no longer carries one `npm publish
  // --provenance` step per package — a single idempotent
  // `node scripts/publish-workspace.mjs` step publishes RELEASE_ORDER in
  // dependency order, skipping versions already on the registry. The gates
  // must run BEFORE that step, and the script itself must carry the
  // provenance flag.
  const PUBLISH_STEP = /run:\s*node scripts\/publish-workspace\.mjs/;

  it('publish.yml runs validate-gcp-secrets + publish-dryrun BEFORE the workspace publish step', async () => {
    const pub = await readFile(join(WORKFLOWS, 'publish.yml'), 'utf-8');
    const gate1Idx = pub.indexOf('validate-gcp-secrets.mjs');
    const gate2Idx = pub.indexOf('publish-dryrun.mjs');
    // Look for the actual `run:` invocation, not the comment above it.
    const firstPubIdx = pub.search(PUBLISH_STEP);
    expect(gate1Idx, 'validate-gcp-secrets.mjs not in publish.yml').toBeGreaterThan(0);
    expect(gate2Idx, 'publish-dryrun.mjs not in publish.yml').toBeGreaterThan(0);
    expect(firstPubIdx, '`run: node scripts/publish-workspace.mjs` not in publish.yml').toBeGreaterThan(0);
    expect(gate1Idx, 'Gate 1 must run before the workspace publish').toBeLessThan(firstPubIdx);
    expect(gate2Idx, 'Gate 2 must run before the workspace publish').toBeLessThan(firstPubIdx);
    // No stray per-package publish steps snuck back in beside the script.
    expect(pub, 'publish.yml must not hand-roll `npm publish` steps').not.toMatch(/run:[^\n]*npm publish/);
  });

  it('scripts/publish-workspace.mjs publishes with --provenance --access public', async () => {
    const script = await readFile(join(SCRIPTS, 'publish-workspace.mjs'), 'utf-8');
    expect(script).toMatch(/\['publish',\s*'--provenance',\s*'--access',\s*'public'\]/);
  });

  it('publish.yml runs marketplace-entry.mjs AFTER the workspace publish step', async () => {
    const pub = await readFile(join(WORKFLOWS, 'publish.yml'), 'utf-8');
    const pubIdx = pub.search(PUBLISH_STEP);
    const marketplaceIdx = pub.indexOf('marketplace-entry.mjs');
    expect(marketplaceIdx, 'marketplace-entry.mjs not wired').toBeGreaterThan(0);
    expect(marketplaceIdx, 'marketplace gen must run after the workspace publish').toBeGreaterThan(pubIdx);
  });

  it('publish-workspace.mjs RELEASE_ORDER covers every published host adapter, and every entry is a real public package', async () => {
    // The script only runs main() when executed directly, so importing it
    // is side-effect free (same guard the unit tests rely on).
    const { RELEASE_ORDER } = await import('../scripts/publish-workspace.mjs') as { RELEASE_ORDER: string[] };
    for (const host of ['host-claude-code', 'host-codex', 'host-pi-dev', 'host-hermes', 'host-openclaw', 'host-rvm', 'host-prime-agent']) {
      expect(RELEASE_ORDER, `RELEASE_ORDER missing ${host}`).toContain(host);
    }
    // Dependency order: the kernel + sdk ship before any host adapter, and
    // create-agent-harness (which depends on all of them) ships last.
    expect(RELEASE_ORDER[0]).toBe('kernel-js');
    expect(RELEASE_ORDER.indexOf('sdk')).toBeLessThan(RELEASE_ORDER.indexOf('host-claude-code'));
    expect(RELEASE_ORDER[RELEASE_ORDER.length - 1]).toBe('create-agent-harness');
    // A stale entry fails the tag run with "release set is stale" — catch it here.
    for (const dir of RELEASE_ORDER) {
      const pkgPath = join(process.cwd(), 'packages', dir, 'package.json');
      expect(existsSync(pkgPath), `RELEASE_ORDER entry packages/${dir} has no package.json`).toBe(true);
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      expect(pkg.private, `packages/${dir} is private but listed in RELEASE_ORDER`).not.toBe(true);
    }
  });

  // iter 78 — pages.yml self-verifies the live deploy after deploy step
  // succeeds so a degraded Pages deploy fails LOUDLY on the same run.
  it('pages.yml chains a verify job that probes the live Studio after deploy (iter 78)', async () => {
    const pages = await readFile(join(WORKFLOWS, 'pages.yml'), 'utf-8');
    // The verify job exists and depends on deploy
    expect(pages, 'pages.yml missing verify job').toMatch(/^\s{2}verify:\s*$/m);
    // verify must `needs: deploy`
    const verifyBlock = pages.slice(pages.indexOf('  verify:'));
    expect(verifyBlock).toMatch(/needs:\s*deploy/);
    // and use the iter-72 healthcheck probe
    expect(verifyBlock).toMatch(/healthcheck\.mjs --probe-pages/);
  });

  // iter 89 — vertical-tour wired into ci.yml Node job. Per-push proof
  // that all 17 verticals scaffold + validate cleanly across every
  // OS-Node permutation, in ~1.1s.
  it('ci.yml runs vertical-tour as a per-push smoke gate (iter 89)', async () => {
    const ci = await readFile(join(WORKFLOWS, 'ci.yml'), 'utf-8');
    expect(ci, 'ci.yml missing vertical-tour invocation').toMatch(
      /node examples\/vertical-tour\/vertical-tour\.mjs/,
    );
    // Sits in the node job, AFTER healthcheck (per-OS-per-Node gate).
    const healthcheckIdx = ci.search(/scripts\/healthcheck\.mjs/);
    const tourIdx = ci.search(/examples\/vertical-tour\/vertical-tour\.mjs/);
    expect(healthcheckIdx).toBeGreaterThan(0);
    expect(tourIdx).toBeGreaterThan(healthcheckIdx);  // tour comes after healthcheck
  });

  // iter 84 — daily scheduled liveness monitor (independent of pushes).
  it('pages-monitor.yml is a daily cron probe of the live Studio (iter 84)', async () => {
    const monitor = await readFile(join(WORKFLOWS, 'pages-monitor.yml'), 'utf-8');
    // Has a cron schedule trigger (CRLF-tolerant — Windows checkouts).
    expect(monitor, 'pages-monitor.yml missing schedule').toMatch(/schedule:[\s\S]*?-\s*cron:/);
    // Cron is daily — 5-field cron with day-of-month=* (3rd field).
    // Pattern: 'M H * * *' (optional minute/hour values, then three *s).
    expect(monitor).toMatch(/cron:\s*'[\d*]+\s+[\d*]+\s+\*\s+\*\s+\*'/);
    // workflow_dispatch is also present so it can be triggered manually
    expect(monitor).toMatch(/workflow_dispatch:/);
    // Delegates to the same iter-72 healthcheck probe — single impl per ADR-028
    expect(monitor).toMatch(/healthcheck\.mjs --probe-pages/);
  });
});
