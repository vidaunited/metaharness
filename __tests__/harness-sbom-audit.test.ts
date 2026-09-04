// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sbomCmd } from '../packages/create-agent-harness/src/sbom-cmd.js';
import { auditCmd } from '../packages/create-agent-harness/src/audit-cmd.js';
import { probeNpmAuditEndpoint, registryFailureSignature, NPM_FAIL_FAST_ENV } from './npm-audit-endpoint.js';

// Precondition for the live `harness audit` test: skip ONLY when npm's
// advisory endpoint is unreachable/5xx (see npm-audit-endpoint.ts).
const endpoint = await probeNpmAuditEndpoint();
if (!endpoint.ok) console.warn(`[harness-sbom-audit.test] skipping live npm audit: ${endpoint.reason}`);

async function makePkgDir(opts: { withLock?: boolean; deps?: Record<string, string> } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ahg-pkg-'));
  const deps = opts.deps ?? { 'lodash': '^4.17.21' };
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture', version: '0.1.0',
    dependencies: deps,
  }, null, 2));
  if (opts.withLock) {
    // Lockfile mirrors `deps` (range stripped to the exact version) so a test
    // can pick its own package without a second fixture shape.
    const packages: Record<string, unknown> = { '': { name: 'fixture', version: '0.1.0', dependencies: deps } };
    for (const [name, range] of Object.entries(deps)) {
      const version = range.replace(/^[\^~]/, '');
      packages[`node_modules/${name}`] = { name, version, resolved: `https://example.invalid/${name}` };
    }
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify({
      name: 'fixture', version: '0.1.0', lockfileVersion: 3, packages,
    }));
  }
  return dir;
}

describe('harness sbom', () => {
  it('fails when no package.json present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-sbom-empty-'));
    try {
      const r = await sbomCmd([dir, '--validate-only']);
      expect(r.code).toBe(1);
      expect(r.lines.join('\n')).toMatch(/no package\.json/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reads from package-lock.json when present', async () => {
    const dir = await makePkgDir({ withLock: true });
    try {
      const r = await sbomCmd([dir, '--validate-only']);
      expect(r.code).toBe(0);
      expect(r.lines.join('\n')).toMatch(/source: package-lock\.json/);
      expect(r.lines.join('\n')).toMatch(/packages: 1/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('falls back to manifest deps when no lockfile', async () => {
    const dir = await makePkgDir({ withLock: false });
    try {
      const r = await sbomCmd([dir, '--validate-only']);
      expect(r.code).toBe(0);
      expect(r.lines.join('\n')).toMatch(/package\.json dependencies/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('--out= writes to a file', async () => {
    const dir = await makePkgDir({ withLock: true });
    try {
      const r = await sbomCmd([dir, '--out=sbom.json']);
      expect(r.code).toBe(0);
      const text = await (await import('node:fs/promises')).readFile(join(dir, 'sbom.json'), 'utf-8');
      const doc = JSON.parse(text);
      expect(doc.spdxVersion).toBe('SPDX-2.3');
      expect(doc.SPDXID).toBe('SPDXRef-DOCUMENT');
      expect(doc.packages.length).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('harness audit', () => {
  it('fails when no package.json present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-aud-empty-'));
    try {
      const r = await auditCmd([dir]);
      expect(r.code).toBe(1);
      expect(r.lines.join('\n')).toMatch(/no package\.json/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('asks for package-lock.json when missing', async () => {
    const dir = await makePkgDir({ withLock: false });
    try {
      const r = await auditCmd([dir]);
      expect(r.code).toBe(1);
      expect(r.lines.join('\n')).toMatch(/npm install --package-lock-only/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('rejects unknown --level= with exit 2', async () => {
    const dir = await makePkgDir({ withLock: true });
    try {
      const r = await auditCmd([dir, '--level=invalid']);
      expect(r.code).toBe(2);
      expect(r.lines.join('\n')).toMatch(/unknown --level/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

});

// auditCmd spawns `npm audit` without an explicit env, so the child inherits
// process.env — set npm's fail-fast knobs there for the blocks below and
// restore afterwards so the offline tests keep whatever npm config CI has.
function withNpmEnv(extra: Record<string, string>) {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [k, v] of Object.entries(extra)) { saved[k] = process.env[k]; process.env[k] = v; }
  });
  afterAll(() => {
    for (const k of Object.keys(extra)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
}

// Offline, deterministic: a registry that cannot be reached must NEVER read as
// a clean audit. npm answers `{message: "... ECONNREFUSED ...", error: {}}`
// (no metadata) in ~0.3s against a refused local port — the exact envelope a
// 503 / fetch timeout produces — and auditCmd used to count that as
// "0 advisories" → PASS.
describe('harness audit — fails closed when npm cannot reach the registry', () => {
  withNpmEnv({ ...NPM_FAIL_FAST_ENV, npm_config_registry: 'http://127.0.0.1:9' });

  it('reports "did not complete" with exit 1 (never PASS) on a refused registry', async () => {
    const dir = await makePkgDir({ withLock: true, deps: { picocolors: '1.1.1' } });
    try {
      const r = await auditCmd([dir]);
      const txt = r.lines.join('\n');
      expect(r.code, txt).toBe(1);
      expect(txt).toMatch(/npm audit did not complete/);
      expect(txt).not.toMatch(/PASS/);
      // The npm message is surfaced verbatim — and it IS a registry-failure
      // signature, which is what lets the live test below skip-with-reason.
      expect(registryFailureSignature(txt)).toMatch(/ECONNREFUSED|127\.0\.0\.1:9/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);

  it('--bundle emits an npm-audit-incomplete error envelope, exit 1', async () => {
    const dir = await makePkgDir({ withLock: true, deps: { picocolors: '1.1.1' } });
    try {
      const r = await auditCmd([dir, '--bundle']);
      expect(r.code).toBe(1);
      const j = JSON.parse(r.lines.join('\n'));
      expect(j.schema).toBe(1);
      expect(j.error).toBe('npm-audit-incomplete');
      expect(j.detail).toMatch(/ECONNREFUSED|127\.0\.0\.1:9/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);
});

// The live path: a real `npm audit` round-trip through auditCmd. Skipped when
// the advisory endpoint is down at PROBE time (describe.skipIf) — and, since
// the registry can answer the probe then hang or 503 the real call, also
// skipped (ctx.skip, not a pass) when the RUN's own output carries a
// registry-failure signature. Fail-fast env bounds that run to ~20s instead of
// npm's default 5min × 3 attempts. Otherwise this must be a clean PASS: a
// single dependency-free package with no advisory history, so any other
// non-zero exit is a genuine auditCmd/npm regression — or a real advisory.
describe.skipIf(!endpoint.ok)('harness audit — live npm audit (endpoint reachable)', () => {
  withNpmEnv({ ...NPM_FAIL_FAST_ENV });

  it('passes audit with 0 advisories at high+ on a tiny clean lockfile', async (ctx) => {
    const dir = await makePkgDir({ withLock: true, deps: { picocolors: '1.1.1' } });
    try {
      const r = await auditCmd([dir]);
      const txt = r.lines.join('\n');
      if (r.code !== 0) {
        const sig = registryFailureSignature(txt);
        if (sig) {
          console.warn(`[harness-sbom-audit.test] registry failed mid-run — skipping live audit: ${sig}`);
          ctx.skip();
        }
      }
      expect(r.code, txt).toBe(0);
      // Either the parsed-JSON PASS line or npm's empty-body "clean" path —
      // never the non-JSON fallback (that is the 503 symptom this guards).
      expect(txt).toMatch(/PASS: 0 advisories at high\+|no advisories at the configured level/);
      expect(txt).not.toMatch(/non-JSON/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 90_000);
});
