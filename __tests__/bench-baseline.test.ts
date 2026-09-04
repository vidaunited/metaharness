// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore — JS module
import { flattenMetrics, compare } from '../scripts/bench-baseline.mjs';

const execFile = promisify(execFileCb);
const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'bench-baseline.mjs');

async function run(args: string[] = [], cwd: string = ROOT): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await execFile('node', [SCRIPT, ...args], { cwd, windowsHide: true });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('flattenMetrics', () => {
  it('flattens host-bench shape', () => {
    const report = {
      iterations: 1000,
      results: [
        { host: 'claude-code', meanMs: 0.001, p95Ms: 0.005 },
        { host: 'rvm', meanMs: 0.004, p95Ms: 0.023 },
      ],
    };
    const flat = flattenMetrics(report);
    const paths = flat.map((m: any) => m.path).sort();
    expect(paths).toContain('iterations');
    expect(paths).toContain('results/claude-code/meanMs');
    expect(paths).toContain('results/rvm/p95Ms');
  });

  it('classifies latency-ish keys as lower-is-better', () => {
    const flat = flattenMetrics({ meanMs: 1.0, p95Ms: 5.0 });
    expect(flat.find((m: any) => m.path === 'meanMs')?.kind).toBe('lower');
    expect(flat.find((m: any) => m.path === 'p95Ms')?.kind).toBe('lower');
  });

  it('classifies quality keys as higher-is-better', () => {
    const flat = flattenMetrics({ ndcg: 0.85, recall: 0.7 });
    expect(flat.find((m: any) => m.path === 'ndcg')?.kind).toBe('higher');
    expect(flat.find((m: any) => m.path === 'recall')?.kind).toBe('higher');
  });
});

describe('compare', () => {
  it('reports no regressions when current matches baseline', () => {
    const a = { meanMs: 1.0, ndcg: 0.85 };
    const results = compare(a, a, 25);
    expect(results.every((r: any) => !r.regressed)).toBe(true);
  });

  it('flags latency regression > threshold', () => {
    const baseline = { meanMs: 1.0 };
    const current = { meanMs: 2.0 };  // +100% — slower
    const results = compare(current, baseline, 25);
    expect(results[0].regressed).toBe(true);
    expect(results[0].deltaPct).toBeCloseTo(100, 0);
  });

  it('does not flag latency IMPROVEMENT (negative delta)', () => {
    const baseline = { meanMs: 1.0 };
    const current = { meanMs: 0.5 };  // -50% — faster, GOOD
    const results = compare(current, baseline, 25);
    expect(results[0].regressed).toBe(false);
  });

  it('flags quality regression (lower than baseline by > threshold)', () => {
    const baseline = { ndcg: 1.0 };
    const current = { ndcg: 0.5 };  // 50% drop in quality
    const results = compare(current, baseline, 25);
    expect(results[0].regressed).toBe(true);
  });

  it('does not flag quality IMPROVEMENT (higher than baseline)', () => {
    const baseline = { ndcg: 0.5 };
    const current = { ndcg: 0.9 };  // 80% gain in quality
    const results = compare(current, baseline, 25);
    expect(results[0].regressed).toBe(false);
  });
});

describe('compare — noise-robust hard-gate options (--keys / --abs-floor)', () => {
  const baseline = {
    results: [{ host: 'rvm', meanMs: 0.004, p50Ms: 0.003, p95Ms: 0.005, p99Ms: 0.03 }],
  };

  it('--keys restricts the comparison to the listed leaf keys', () => {
    const current = {
      results: [{ host: 'rvm', meanMs: 0.004, p50Ms: 0.003, p95Ms: 0.5, p99Ms: 3 }], // tails explode
    };
    const all = compare(current, baseline, 50);
    expect(all.filter((r: any) => r.regressed).map((r: any) => r.path).sort())
      .toEqual(['results/rvm/p95Ms', 'results/rvm/p99Ms']);
    const gated = compare(current, baseline, 50, { keys: ['meanMs', 'p50Ms'] });
    expect(gated.map((r: any) => r.path).sort()).toEqual(['results/rvm/meanMs', 'results/rvm/p50Ms']);
    expect(gated.every((r: any) => !r.regressed)).toBe(true);
  });

  it('--abs-floor: a relative trip on a sub-floor absolute move is NOT a regression', () => {
    // +100% relative, but only +0.004ms absolute — sub-microsecond jitter class.
    const current = { results: [{ host: 'rvm', meanMs: 0.008, p50Ms: 0.003, p95Ms: 0.005, p99Ms: 0.03 }] };
    const relOnly = compare(current, baseline, 50);
    expect(relOnly.find((r: any) => r.path === 'results/rvm/meanMs')?.regressed).toBe(true);
    const floored = compare(current, baseline, 50, { absFloor: 0.05 });
    const m = floored.find((r: any) => r.path === 'results/rvm/meanMs');
    expect(m?.regressed).toBe(false);
    expect(m?.delta).toBeCloseTo(0.004, 6);
  });

  it('--abs-floor: an absolute move above the floor with a sub-threshold relative delta is NOT a regression either (BOTH must hold)', () => {
    const base = { meanMs: 10 };
    const current = { meanMs: 12 }; // +20% (< 50%), +2 absolute (> floor)
    expect(compare(current, base, 50, { absFloor: 0.05 })[0].regressed).toBe(false);
  });

  it('--abs-floor does not mask a real regression (both conditions hold)', () => {
    const current = { results: [{ host: 'rvm', meanMs: 0.4, p50Ms: 0.003, p95Ms: 0.005, p99Ms: 0.03 }] }; // 100× slower
    const r = compare(current, baseline, 50, { keys: ['meanMs', 'p50Ms'], absFloor: 0.05 });
    expect(r.find((x: any) => x.path === 'results/rvm/meanMs')?.regressed).toBe(true);
    expect(r.find((x: any) => x.path === 'results/rvm/p50Ms')?.regressed).toBe(false);
  });

  it('--abs-floor applies to higher-is-better metrics symmetrically', () => {
    expect(compare({ ndcg: 0.001 }, { ndcg: 0.01 }, 25, { absFloor: 0.05 })[0].regressed).toBe(false); // -90% but Δ 0.009
    expect(compare({ ndcg: 0.1 }, { ndcg: 0.9 }, 25, { absFloor: 0.05 })[0].regressed).toBe(true);
  });

  it('defaults (no opts) reproduce the relative-only behaviour', () => {
    const current = { meanMs: 2.0 };
    expect(compare(current, { meanMs: 1.0 }, 25)).toEqual(compare(current, { meanMs: 1.0 }, 25, {}));
    expect(compare(current, { meanMs: 1.0 }, 25, { absFloor: 0 })[0].regressed).toBe(true);
  });
});

describe('script integration', () => {
  it('--update establishes baseline + exits 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-bb-'));
    try {
      const current = join(dir, 'current.json');
      await writeFile(current, JSON.stringify({ meanMs: 1.0 }));
      const r = await run(['--current=current.json', '--baseline=base.json', '--update'], dir);
      expect(r.code).toBe(0);
      expect(r.stderr).toMatch(/baseline updated/);
      // Confirm baseline written
      const txt = await readFile(join(dir, 'base.json'), 'utf-8');
      expect(JSON.parse(txt).meanMs).toBe(1.0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('first run with no baseline establishes one (exit 0)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-bb-'));
    try {
      const current = join(dir, 'current.json');
      await writeFile(current, JSON.stringify({ p95Ms: 5.0 }));
      const r = await run(['--current=current.json', '--baseline=base.json'], dir);
      expect(r.code).toBe(0);
      expect(r.stderr).toMatch(/establishing it/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('exit 1 on regression', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-bb-'));
    try {
      await writeFile(join(dir, 'base.json'), JSON.stringify({ meanMs: 1.0 }));
      await writeFile(join(dir, 'current.json'), JSON.stringify({ meanMs: 10.0 }));
      const r = await run(['--current=current.json', '--baseline=base.json', '--threshold=10'], dir);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/1 regression/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('CI shape: --keys=meanMs,p50Ms --abs-floor=0.05 ignores tail jitter (exit 0) but fails a real regression (exit 1)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-bb-'));
    try {
      const base = { elapsedMs: 27, results: [{ host: 'rvm', meanMs: 0.004, p50Ms: 0.003, p95Ms: 0.005, p99Ms: 0.03 }] };
      await writeFile(join(dir, 'base.json'), JSON.stringify(base));
      // Jitter: +100% mean (Δ 0.004ms), p99 ×10, elapsed ×3 — all noise at this scale.
      const jitter = { elapsedMs: 81, results: [{ host: 'rvm', meanMs: 0.008, p50Ms: 0.0031, p95Ms: 0.05, p99Ms: 0.3 }] };
      await writeFile(join(dir, 'current.json'), JSON.stringify(jitter));
      const gateArgs = ['--current=current.json', '--baseline=base.json', '--threshold=50', '--keys=meanMs,p50Ms', '--abs-floor=0.05'];
      const ok = await run(gateArgs, dir);
      expect(ok.code).toBe(0);
      expect(ok.stderr).toMatch(/checked 2 metric\(s\), threshold 50%, keys meanMs,p50Ms, abs floor 0.05/);
      // Without the flags the same report would have failed the (old) gate.
      const old = await run(['--current=current.json', '--baseline=base.json', '--threshold=50'], dir);
      expect(old.code).toBe(1);
      // A real regression: +0.4ms per call on the mean (100× slower) still fails.
      const real = { elapsedMs: 27, results: [{ host: 'rvm', meanMs: 0.4, p50Ms: 0.003, p95Ms: 0.005, p99Ms: 0.03 }] };
      await writeFile(join(dir, 'current.json'), JSON.stringify(real));
      const bad = await run(gateArgs, dir);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toMatch(/results\/rvm\/meanMs: 0.004 -> 0.4/);
      expect(bad.stderr).toMatch(/1 regression\(s\) > 50% threshold and > 0.05 absolute/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects a --keys allowlist that matches nothing (a gate that compares nothing is not a gate)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-bb-'));
    try {
      await writeFile(join(dir, 'base.json'), JSON.stringify({ meanMs: 1.0 }));
      await writeFile(join(dir, 'current.json'), JSON.stringify({ meanMs: 1.0 }));
      const r = await run(['--current=current.json', '--baseline=base.json', '--keys=nope'], dir);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/no metrics in common/);
      const empty = await run(['--current=current.json', '--baseline=base.json', '--keys='], dir);
      expect(empty.code).toBe(2);
      const badFloor = await run(['--current=current.json', '--baseline=base.json', '--abs-floor=-1'], dir);
      expect(badFloor.code).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
