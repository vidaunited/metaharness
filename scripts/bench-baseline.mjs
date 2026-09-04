#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// scripts/bench-baseline.mjs — performance regression detector.
//
// Reads a current bench report (JSON) and compares against a stored
// baseline. Fails CI if any tracked metric has degraded by more than
// the configured threshold. Useful as the gate downstream of
// iter-13's memory bench + iter-39's host-bench.
//
// Inputs:
//   --current=<path>    current bench-report.json (required)
//   --baseline=<path>   baseline to compare against (default: packages/bench/baseline.json)
//   --threshold=<pct>   max acceptable regression % (default 25)
//   --keys=<k1,k2,...>  compare ONLY metrics whose leaf key is listed (e.g.
//                       `meanMs,p50Ms`); everything else is ignored. Default:
//                       every numeric leaf. Use it to drop noisy tail
//                       statistics (p95/p99/elapsed) from a hard gate.
//   --abs-floor=<n>     a metric regresses only if BOTH the relative delta
//                       exceeds --threshold AND the absolute delta exceeds
//                       <n> (in the metric's own units, e.g. 0.05 = 50µs
//                       for *Ms keys). Default 0 (relative only). Makes a
//                       hard CI gate immune to sub-microsecond jitter on
//                       sub-millisecond baselines (host-baseline.json means
//                       are 0.0002–0.007ms — a 50% swing there is noise).
//   --update            overwrite baseline with current (for re-baselining)
//
// Bench JSON shape this script understands:
//   memory bench:  { ndcg, recall, precision, ... } per config
//   host bench:    { iterations, results: [{ host, meanMs, p50Ms, p95Ms, ... }] }
//
// Each metric is auto-classified as "higher-is-better" (ndcg, recall,
// precision) or "lower-is-better" (latency); regression is computed
// accordingly.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

function log(tag, msg) { process.stderr.write(`[bench-baseline] ${tag}: ${msg}\n`); }

const HIGHER_IS_BETTER = new Set(['ndcg', 'recall', 'precision', 'mrr', 'hitrate']);

/**
 * Flatten a nested bench report into a list of {path, value, kind} entries.
 * kind = 'higher' or 'lower'.
 */
export function flattenMetrics(obj, prefix = '') {
  const out = [];
  if (obj === null || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      // For arrays of objects with a `host` or `name` key, use that as the
      // key; otherwise index. Keeps results stable.
      const key = obj[i]?.host ?? obj[i]?.name ?? String(i);
      out.push(...flattenMetrics(obj[i], prefix ? `${prefix}/${key}` : key));
    }
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}/${k}` : k;
    if (typeof v === 'number') {
      const lower = HIGHER_IS_BETTER.has(k.toLowerCase()) ? 'higher' : (
        // iter-154: 'tokens' + 'usd' added for DRACO efficiency (more tokens /
        // more $ = worse). DRACO quality metrics (score, grounding, coverage,
        // balance, cleanliness, faithfulness, mean, per-domain) all default to
        // higher-is-better, which is correct.
        /ms|latency|cost|usd|size|count|tokens?|p\d|wall/i.test(k) ? 'lower' :
        'higher'  // default to higher-is-better for unknown keys
      );
      out.push({ path: p, value: v, kind: lower });
    } else if (v && typeof v === 'object') {
      out.push(...flattenMetrics(v, p));
    }
  }
  return out;
}

/** Leaf key of a flattened metric path (`results/rvm/p50Ms` → `p50Ms`). */
function leafKey(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Compare current vs baseline.
 * Returns an array of {path, baseline, current, deltaPct, delta, regressed, kind}.
 *
 * opts (all optional, defaults reproduce the pre-flag behaviour):
 *   keys      — Set/array of leaf keys to compare; metrics whose leaf key is
 *               not listed are dropped from the result entirely (`--keys`).
 *   absFloor  — absolute-delta floor (`--abs-floor`): a metric is regressed
 *               only if the relative test trips AND |delta| > absFloor. With
 *               the default 0 the relative test alone decides, as before.
 */
export function compare(currentReport, baselineReport, thresholdPct, opts = {}) {
  const keys = opts.keys ? new Set(opts.keys) : null;
  const absFloor = Number.isFinite(opts.absFloor) && opts.absFloor > 0 ? opts.absFloor : 0;
  const c = flattenMetrics(currentReport);
  const b = flattenMetrics(baselineReport);
  const byPath = new Map(b.map(m => [m.path, m]));
  const results = [];
  for (const cm of c) {
    if (keys && !keys.has(leafKey(cm.path))) continue;
    const bm = byPath.get(cm.path);
    if (!bm) continue;
    if (bm.value === 0 && cm.value === 0) {
      results.push({ ...cm, baseline: bm.value, current: cm.value, delta: 0, deltaPct: 0, regressed: false });
      continue;
    }
    const delta = cm.value - bm.value;
    const deltaPct = bm.value === 0 ? Infinity : (delta / Math.abs(bm.value)) * 100;
    // For "lower is better", regression = positive delta; for "higher is better",
    // regression = negative delta.
    let regressed = false;
    if (cm.kind === 'lower') regressed = deltaPct > thresholdPct;
    else regressed = deltaPct < -thresholdPct;
    // Noise floor: a relative trip on a sub-floor absolute move is jitter, not
    // a regression (both conditions must hold).
    if (regressed && Math.abs(delta) <= absFloor) regressed = false;
    results.push({
      path: cm.path,
      baseline: bm.value,
      current: cm.value,
      delta,
      deltaPct,
      regressed,
      kind: cm.kind,
    });
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = name => args.find(a => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
  const flag = name => args.includes(`--${name}`);

  const ROOT = process.cwd();
  const current = arg('current');
  const baseline = arg('baseline') ?? 'packages/bench/baseline.json';
  const threshold = parseFloat(arg('threshold') ?? '25');
  const keysArg = arg('keys');
  // `undefined` = flag absent (compare every metric); `--keys=` (empty) is a usage error below.
  const keys = keysArg === undefined ? null : keysArg.split(',').map(k => k.trim()).filter(Boolean);
  const absFloor = parseFloat(arg('abs-floor') ?? '0');
  const updateBaseline = flag('update');

  if (!current) {
    process.stderr.write('[bench-baseline] usage: --current=<bench.json> [--baseline=<base.json>] [--threshold=<pct>] [--keys=<k1,k2>] [--abs-floor=<n>] [--update]\n');
    process.exit(2);
  }
  if (keys !== null && keys.length === 0) {
    log('FAIL', '--keys= must list at least one metric key (e.g. --keys=meanMs,p50Ms)');
    process.exit(2);
  }
  if (!Number.isFinite(absFloor) || absFloor < 0) {
    log('FAIL', `--abs-floor must be a non-negative number, got "${arg('abs-floor')}"`);
    process.exit(2);
  }

  const currentPath = join(ROOT, current);
  if (!existsSync(currentPath)) {
    log('FAIL', `current bench report not found: ${currentPath}`);
    process.exit(1);
  }
  const currentReport = JSON.parse(await readFile(currentPath, 'utf-8'));
  const baselinePath = join(ROOT, baseline);

  if (updateBaseline) {
    await mkdir(dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, JSON.stringify(currentReport, null, 2) + '\n', 'utf-8');
    log('INFO', `baseline updated at ${baselinePath}`);
    return;
  }

  if (!existsSync(baselinePath)) {
    log('WARN', `no baseline at ${baselinePath} — establishing it from current`);
    await mkdir(dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, JSON.stringify(currentReport, null, 2) + '\n', 'utf-8');
    log('INFO', 'baseline established; future runs will compare against it');
    return;
  }

  const baselineReport = JSON.parse(await readFile(baselinePath, 'utf-8'));
  const results = compare(currentReport, baselineReport, threshold, { keys, absFloor });

  const regressions = results.filter(r => r.regressed);
  log('INFO', `checked ${results.length} metric(s), threshold ${threshold}%` +
    (keys ? `, keys ${keys.join(',')}` : '') +
    (absFloor > 0 ? `, abs floor ${absFloor}` : ''));
  if (results.length === 0) {
    // A gate that compares nothing is not a gate — surface it loudly rather
    // than passing on an empty set (wrong --keys, or a report shape change).
    log('FAIL', 'no metrics in common between current and baseline (check --keys / report shape)');
    process.exit(1);
  }
  if (regressions.length === 0) {
    log('PASS', 'no regressions detected');
    process.exit(0);
  }
  for (const r of regressions.slice(0, 10)) {
    const sign = r.deltaPct > 0 ? '+' : '';
    log('FAIL', `${r.path}: ${r.baseline} -> ${r.current} (${sign}${r.deltaPct.toFixed(1)}%, Δ ${sign}${r.delta} ${r.kind === 'lower' ? 'slower' : 'lower-quality'})`);
  }
  log('FAIL', `${regressions.length} regression(s) > ${threshold}% threshold` + (absFloor > 0 ? ` and > ${absFloor} absolute` : ''));
  process.exit(1);
}

// Only run main when invoked as a CLI; not when imported as a module.
const isMain = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
  || (typeof process.argv[1] === 'string' && process.argv[1].endsWith('bench-baseline.mjs'));
if (isMain) {
  main().catch(err => {
    log('FAIL', err?.stack ?? err);
    process.exit(1);
  });
}
