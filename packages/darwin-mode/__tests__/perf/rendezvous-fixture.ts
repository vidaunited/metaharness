// SPDX-License-Identifier: MIT
//
// Shared fixture for the two end-to-end `mapLimit` width tests
// (concurrency.perf.test.ts, mapLimit.test.ts): a tiny repo whose `npm test`
// runs a RENDEZVOUS script instead of a fixed sleep.
//
// Why a rendezvous and not a sleep: the previous fixtures inferred overlap
// from wall-clock (a `conMs < seqMs * 0.7` ratio, or B/E markers around an
// 80ms sleep). On a loaded shared CI runner the per-variant `npm` startup
// jitter alone exceeds the sleep window, so sibling evaluations sometimes
// finished before the next one had even started — observed ratio 0.72 vs the
// 0.70 ceiling, observed maxOverlap=1 — and both tests were `skipIf(CI)`.
//
// A rendezvous makes overlap a LOGICAL property instead of a timing one: each
// evaluation appends a "B <t>" begin marker, then BLOCKS until at least
// `target` begin markers exist (or `timeoutMs` elapses — a loud failure, never
// a silent pass), then appends "E <t>" and exits 0. Under a real width-`target`
// `mapLimit` the first `target` evaluations are therefore provably alive at
// the same instant regardless of how slow the runner is; under sequential
// evaluation every one of them would time out. `mapLimit`'s own bound
// guarantees the overlap never EXCEEDS the width, so `maxOverlap === target`.
//
// Ordering assumption (evolve.ts, `--- generations ---`): the baseline
// variant is evaluated ALONE, before any child. It must not wait at the
// barrier, so the very first invocation (no gate file yet) just drops the gate
// file and exits; every later invocation is a child and rendezvouses.
//
// All paths are ABSOLUTE and live OUTSIDE the fixture repo: the sandbox runs
// the command with its own cwd and a scrubbed env (sandbox.ts), and on Windows
// the previous relative `markers.log` landed in a per-variant copy (ENOENT).

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface RendezvousRepo {
  /** The fixture repo root (pass as `repoRoot`). */
  repo: string;
  /** Marker log the rendezvous script appends to ("B <hrtime>" / "E <hrtime> <begun>" / "TIMEOUT"). */
  markers: string;
}

/**
 * Write a fixture repo whose `npm test` (the command the profiler resolves)
 * runs the rendezvous script with the given barrier `target` and `timeoutMs`.
 */
export async function makeRendezvousRepo(target: number, timeoutMs: number): Promise<RendezvousRepo> {
  const repo = await mkdtemp(join(tmpdir(), 'darwin-rv-repo-'));
  const state = await mkdtemp(join(tmpdir(), 'darwin-rv-state-'));
  const markers = join(state, 'markers.log');
  const gate = join(state, 'baseline-done');
  const script = `
const fs = require('fs');
const LOG = ${JSON.stringify(markers)};
const GATE = ${JSON.stringify(gate)};
const TARGET = ${target};
const TIMEOUT_MS = ${timeoutMs};
// First invocation = the baseline evaluation, which evolve runs alone before
// any child: mark it done and exit without touching the barrier.
if (!fs.existsSync(GATE)) { fs.writeFileSync(GATE, '1'); process.exit(0); }
fs.appendFileSync(LOG, 'B ' + process.hrtime.bigint() + '\\n');
const t0 = Date.now();
(function poll() {
  const begun = fs.readFileSync(LOG, 'utf8').split('\\n').filter(l => l.startsWith('B ')).length;
  if (begun >= TARGET) {
    fs.appendFileSync(LOG, 'E ' + process.hrtime.bigint() + ' ' + begun + '\\n');
    process.exit(0);
  }
  if (Date.now() - t0 > TIMEOUT_MS) {
    fs.appendFileSync(LOG, 'TIMEOUT ' + process.hrtime.bigint() + ' ' + begun + '\\n');
    process.exit(0);
  }
  setTimeout(poll, 10);
})();
`;
  await writeFile(join(repo, 'rendezvous.cjs'), script, 'utf8');
  await writeFile(
    join(repo, 'package.json'),
    // Profiler resolves `npm test`, which the sandbox runs per variant evaluation.
    JSON.stringify({ name: 'rv-fixture', version: '0.0.0', scripts: { test: 'node rendezvous.cjs' } }),
    'utf8',
  );
  await writeFile(join(repo, 'index.ts'), 'export const x = 1;\n', 'utf8');
  return { repo, markers };
}

/** Parsed view of a rendezvous marker log. */
export interface RendezvousResult {
  /** Max number of simultaneously-open [B, E) intervals. */
  maxOverlap: number;
  /** Number of "B" (begin) markers = child evaluations that reached the barrier. */
  begun: number;
  /** Number of evaluations that gave up waiting (must be 0 for a valid run). */
  timedOut: number;
}

/** Reconstruct overlap + barrier outcome from the marker log. */
export async function readRendezvous(markersPath: string): Promise<RendezvousResult> {
  const log = await readFile(markersPath, 'utf8');
  const events: Array<{ t: bigint; d: number }> = [];
  let begun = 0;
  let timedOut = 0;
  for (const line of log.split('\n')) {
    const [tag, ts] = line.split(' ');
    if (!ts) continue;
    if (tag === 'B') begun++;
    if (tag === 'TIMEOUT') timedOut++;
    // A TIMEOUT closes the interval too (the process exits either way).
    events.push({ t: BigInt(ts), d: tag === 'B' ? 1 : -1 });
  }
  // Ties: process ends (-1) before begins (+1) so we never over-count overlap.
  events.sort((a, b) => (a.t === b.t ? a.d - b.d : a.t < b.t ? -1 : 1));
  let cur = 0;
  let maxOverlap = 0;
  for (const e of events) {
    cur += e.d;
    if (cur > maxOverlap) maxOverlap = cur;
  }
  return { maxOverlap, begun, timedOut };
}
