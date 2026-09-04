// SPDX-License-Identifier: MIT
//
// Concurrency check (ADR-070 §loop): prove that `evolve`'s BOUNDED
// concurrency (`mapLimit`) actually OVERLAPS variant evaluation, end-to-end
// through the public `evolve` entry point — the real hot path (`mapLimit` is
// also unit-tested directly in mapLimit.test.ts).
//
// Previously a wall-clock RATIO assertion (`conMs < seqMs * 0.7`) that had to
// be `skipIf(CI)`: per-variant `npm` startup on a shared runner is slow and
// high-variance enough to swamp the overlap signal at these sizes (observed
// 0.72 vs the 0.70 ceiling on Windows). Overlap is now proven LOGICALLY with
// the rendezvous fixture (see rendezvous-fixture.ts): with C children at width
// C, every child blocks until all C have begun, so all C are alive at the same
// instant — `maxOverlap === C` — whatever the runner's speed; sequential
// evaluation could only ever produce 1 (after C barrier timeouts). The
// wall-clock is still logged for local perf inspection but never asserted.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evolve } from '../../src/evolve.js';
import type { EvolutionConfig } from '../../src/types.js';
import { makeRendezvousRepo, readRendezvous } from './rendezvous-fixture.js';

/** Barrier wait ceiling per child — generous for C concurrent `npm` startups
 * on a loaded runner, and well under the sandbox's 30s task timeout. */
const BARRIER_TIMEOUT_MS = 20_000;

describe('evolve — bounded concurrency overlaps work', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    dirs.length = 0;
  });

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it(
    'C=4 over 4 children: all four variant evaluations are alive simultaneously (maxOverlap === 4)',
    async () => {
      const concurrency = 4;
      const children = 4;
      const { repo, markers } = await makeRendezvousRepo(children, BARRIER_TIMEOUT_MS);
      const work = await mkdtemp(join(tmpdir(), 'darwin-perf-work-'));
      dirs.push(repo, work);
      const cfg: EvolutionConfig = {
        repoRoot: repo,
        workRoot: work,
        generations: 1,
        childrenPerGeneration: children,
        tasks: ['t0'], // one evaluation per variant
        promotionDelta: 0.01,
        seed: 1,
        concurrency,
        taskTimeoutMs: 30_000,
      };

      const start = performance.now();
      await evolve(cfg);
      const wallMs = performance.now() - start;

      const rv = await readRendezvous(markers);
      // eslint-disable-next-line no-console
      console.log(
        `[concurrency.perf] C=${concurrency} children=${children} wall=${wallMs.toFixed(0)}ms begun=${rv.begun} maxOverlap=${rv.maxOverlap} timedOut=${rv.timedOut}`,
      );

      expect(rv.timedOut).toBe(0); // no child gave up waiting → the barrier was real
      expect(rv.begun).toBe(children); // every child (not the baseline) reached it
      expect(rv.maxOverlap).toBe(concurrency); // all C alive at once, never more
    },
    90_000,
  );
});
