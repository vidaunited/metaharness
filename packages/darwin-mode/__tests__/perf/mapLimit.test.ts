// SPDX-License-Identifier: MIT
//
// `mapLimit` invariants: (1) never more than `concurrency` tasks in flight at
// once, and (2) results preserve input order.
//
// `mapLimit` is now exported from src/evolve.ts, so we assert its two invariants
// directly on the primitive:
//
//   - ORDER + WIDTH (unit): drive the REAL `mapLimit` with an in-flight counter
//     test double — proves it caps concurrency at `limit` and writes
//     `results[i] = fn(items[i])` (order-preserving).
//   - WIDTH (end-to-end): drive the REAL `evolve` with a rendezvous test command
//     (rendezvous-fixture.ts): each child evaluation blocks until `concurrency`
//     of them have begun, so the first `concurrency` are provably alive at the
//     same instant, and `mapLimit`'s bound keeps it from ever being more —
//     `maxOverlap === concurrency`, independent of runner speed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evolve, mapLimit } from '../../src/evolve.js';
import type { EvolutionConfig } from '../../src/types.js';
import { makeRendezvousRepo, readRendezvous } from './rendezvous-fixture.js';

describe('mapLimit primitive — width bound + order (unit)', () => {
  it('never exceeds the concurrency width and preserves input order', async () => {
    const items = Array.from({ length: 13 }, (_, i) => i);
    const limit = 4;
    let inFlight = 0;
    let maxInFlight = 0;

    const out = await mapLimit(items, limit, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5)); // let overlap develop
      inFlight--;
      return n * 10;
    });

    expect(maxInFlight).toBeLessThanOrEqual(limit);
    expect(maxInFlight).toBe(limit); // saturates because items > limit
    expect(out).toEqual(items.map((n) => n * 10)); // order preserved
  });

  it('clamps width to item count when limit > items', async () => {
    const items = [0, 1];
    let inFlight = 0;
    let maxInFlight = 0;
    await mapLimit(items, 8, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n;
    });
    expect(maxInFlight).toBeLessThanOrEqual(items.length);
  });
});

// ── End-to-end width bound through evolve's real mapLimit + sandbox path. ──
//
// Previously `skipIf(CI)`: it inferred overlap from wall-clock markers around
// an 80ms sleep, which a loaded runner defeats (observed maxOverlap=1), and its
// relative `markers.log` path landed in a per-variant copy on Windows (ENOENT).
// The rendezvous fixture removes both: overlap is a barrier fact, not a timing
// one, and every path it touches is absolute and outside the repo.

/** Barrier wait ceiling per child — generous for `concurrency` simultaneous
 * `npm` startups on a loaded runner, and under the sandbox's 30s task timeout. */
const BARRIER_TIMEOUT_MS = 20_000;

describe('evolve mapLimit — width bound through the real sandbox path', () => {
  const dirs: string[] = [];
  beforeEach(() => {
    dirs.length = 0;
  });
  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it(
    'runs exactly `concurrency` variant evaluations simultaneously (6 children at width 3)',
    async () => {
      const concurrency = 3;
      const children = 6; // 6 children evaluated via mapLimit at width 3
      // Barrier target = the width: the first 3 children wait for each other
      // (all alive at once); children 4–6 see ≥3 begun and exit immediately.
      const { repo, markers } = await makeRendezvousRepo(concurrency, BARRIER_TIMEOUT_MS);
      const work = await mkdtemp(join(tmpdir(), 'darwin-ml-work-'));
      dirs.push(repo, work);

      const cfg: EvolutionConfig = {
        repoRoot: repo,
        workRoot: work,
        generations: 1,
        childrenPerGeneration: children,
        tasks: ['t0'],
        promotionDelta: 0.01,
        seed: 1,
        concurrency,
        taskTimeoutMs: 30_000,
      };

      await evolve(cfg);

      const rv = await readRendezvous(markers);
      // eslint-disable-next-line no-console
      console.log(
        `[mapLimit] concurrency=${concurrency} children=${children} begun=${rv.begun} maxOverlap=${rv.maxOverlap} timedOut=${rv.timedOut}`,
      );

      expect(rv.timedOut).toBe(0); // nobody gave up at the barrier
      expect(rv.begun).toBe(children); // every child evaluation ran
      expect(rv.maxOverlap).toBe(concurrency); // proves overlap AND the width bound
    },
    90_000,
  );
});
