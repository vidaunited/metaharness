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
// How the child learns where the state lives: the sandbox (src/sandbox.ts)
// runs the profiler-resolved `npm test` via execFile with NO shell, cwd =
// the repo root, and a SCRUBBED env (PATH + 3 identifying vars, nothing else)
// — so neither env nor argv can carry a path to the child. The only channel
// guaranteed to reach it on every OS is the script file itself, so every
// absolute path is baked into `rendezvous.cjs` at fixture-creation time (via
// JSON.stringify, so Windows backslashes and 8.3 names like `RUNNER~1`
// survive verbatim). The state dir and `markers.log` are created by the
// PARENT before `evolve` starts, and the child `mkdirSync`s recursively
// before appending anyway, so a missing file can never be mistaken for a
// missing child.
//
// Windows (Node 20/22 / windows-latest, CI run 33868034552): both tests
// failed with `ENOENT … darwin-rv-state-*/markers.log` after the WHOLE
// evolve run (baseline + 4 children = five `npm test` invocations) took
// 211ms — impossible if even one `npm` had started (~200ms each on Linux,
// where the same run takes 550–730ms). Root cause: `execFile('npm', …)` with
// no `shell` cannot start `npm.cmd` on Windows (libuv resolves only
// .exe/.com; Node ≥ 20.12 refuses .cmd/.bat without a shell), the sandbox
// catches the spawn error as an ordinary exitCode-1 trace, evolve carries on,
// and no child ever runs the rendezvous script. That is a property of the
// sandbox, not of this fixture — nothing a child-side fixture can do can
// observe a process that was never created — so the e2e tests skip on win32
// (same precedent as tier2-sandbox.e2e.test.ts) and `sandboxDiagnostics`
// below turns the symptom into a readable assertion message everywhere else.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface RendezvousRepo {
  /** The fixture repo root (pass as `repoRoot`). */
  repo: string;
  /** Marker log the rendezvous script appends to ("B <hrtime>" / "E <hrtime> <begun>" / "TIMEOUT"). Pre-created (empty) by the parent. */
  markers: string;
}

/**
 * Write a fixture repo whose `npm test` (the command the profiler resolves)
 * runs the rendezvous script with the given barrier `target` and `timeoutMs`.
 * The state dir and the (empty) marker log exist before this returns.
 */
export async function makeRendezvousRepo(target: number, timeoutMs: number): Promise<RendezvousRepo> {
  const repo = await mkdtemp(join(tmpdir(), 'darwin-rv-repo-'));
  const state = await mkdtemp(join(tmpdir(), 'darwin-rv-state-'));
  const markers = join(state, 'markers.log');
  const gate = join(state, 'baseline-done');
  // Parent-side: the dir exists (mkdtemp) and the log exists, empty, before
  // any child could be spawned — an absent log is never the parent's fault.
  await mkdir(state, { recursive: true });
  await writeFile(markers, '', 'utf8');
  const script = `
const fs = require('fs');
const path = require('path');
// Absolute paths baked in at fixture-creation time (see the header comment:
// the sandbox scrubs the env and fixes argv, so the script is the only channel).
const LOG = ${JSON.stringify(markers)};
const GATE = ${JSON.stringify(gate)};
const TARGET = ${target};
const TIMEOUT_MS = ${timeoutMs};
fs.mkdirSync(path.dirname(LOG), { recursive: true });
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

/**
 * What the sandbox actually recorded for every evaluation (`<workRoot>/runs/
 * <variantId>.json`, written by evolve's commit step): one line per trace,
 * with exit code, timeout flag and the head of stderr. Pass it as the
 * assertion message so a run where no child reached the barrier says WHY —
 * a trace with exitCode 1, timedOut false and NO output at all means the
 * command never started (the Windows `npm.cmd`-without-shell class above).
 */
export async function sandboxDiagnostics(workRoot: string): Promise<string> {
  const dir = join(workRoot, 'runs');
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return `no run traces under ${dir}`;
  }
  const lines: string[] = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(await readFile(join(dir, f), 'utf8')) as {
        traces?: Array<{ taskId: string; exitCode: number; timedOut: boolean; durationMs: number; stdout: string; stderr: string }>;
      };
      for (const t of rec.traces ?? []) {
        const out = (t.stderr || t.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 160);
        lines.push(
          `${f}/${t.taskId}: exit=${t.exitCode} timedOut=${t.timedOut} ${t.durationMs}ms ` +
            (out ? `output="${out}"` : 'NO OUTPUT (command never started?)'),
        );
      }
    } catch (e) {
      lines.push(`${f}: unreadable (${(e as Error).message})`);
    }
  }
  return lines.length ? `sandbox traces:\n  ${lines.join('\n  ')}` : `no traces in ${dir}`;
}
