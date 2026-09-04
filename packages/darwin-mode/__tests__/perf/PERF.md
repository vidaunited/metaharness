# Darwin Mode — Performance & Bounds Validation

Scope: validate and measure the performance/safety bounds claimed for the
evolution loop. Tests live in `packages/darwin-mode/__tests__/perf/` and touch
nothing under `src/`.

Run: `npx vitest run packages/darwin-mode/__tests__/perf`

## 1. Bounded concurrency actually overlaps work (`concurrency.perf.test.ts`)

`evolve` evaluates a generation's children with `mapLimit(children, concurrency, …)`
(`src/evolve.ts:mapLimit()`, called from the generation loop). The test drives
the **real `evolve`** over a fixture repo whose `scripts.test` is the
**rendezvous** script from `rendezvous-fixture.ts`, resolved by the profiler to
`npm test` and run once per variant by the sandbox.

History: this was a wall-clock ratio (`con(C=4) < seq(C=1) × 0.7`; measured
0.37–0.44 locally) and had to be `it.skipIf(CI)` — per-variant `npm` startup on a
shared runner is slow and variable enough to swamp the overlap signal (observed
0.72 vs the 0.70 ceiling on Windows). Overlap is now proven **logically**, not by
timing: every child evaluation appends a begin marker and then blocks until
`target` (= the width, 4) begin markers exist, then appends an end marker.
Under a real width-4 `mapLimit` all four children are therefore alive at the
same instant regardless of runner speed — `maxOverlap === 4` — while the
`mapLimit` bound means it can never be more. A sequential evaluation could only
ever produce `maxOverlap = 1` after 4 barrier timeouts (verified as a negative
control with `concurrency: 1`: `{maxOverlap: 1, begun: 2, timedOut: 1}`).

The baseline variant is evaluated alone before any child (`evolve.ts`, `---
generations ---`), so the script's first invocation only drops a gate file and
exits; every later invocation rendezvouses. All paths are absolute and outside
the fixture repo (the sandbox scrubs the env and, on Windows, ran with a
per-variant cwd — the old relative `markers.log` was ENOENT there).

Measured (3 runs under `CI=1`, this machine, while a `cargo test` run loaded
the CPU):

| run | wall (C=4, 4 children) | begun | maxOverlap | timedOut |
|-----|------------------------|-------|------------|----------|
| 1   | 732 ms                 | 4     | 4          | 0        |
| 2   | 602 ms                 | 4     | 4          | 0        |
| 3   | 551 ms                 | 4     | 4          | 0        |

Asserted: `timedOut === 0`, `begun === 4`, `maxOverlap === 4`. Wall-clock is
logged for local inspection, never asserted. Conclusion: concurrency is real and
bounded, and the test runs on CI.

## 2. `mapLimit` width bound + order (`mapLimit.test.ts`)

`mapLimit` is now **exported** from `src/evolve.ts`, so the invariants are
checked directly on the primitive plus end-to-end:

- **Unit (primitive):** the real `mapLimit` is driven with an in-flight counter
  test double. With 13 items at limit 4 the observed max in-flight is exactly 4
  (saturates, never exceeds), and results come back in input order
  (`results[i] === fn(items[i])`). Width also clamps to item count when
  `limit > items`.
- **End-to-end (real path):** `evolve` runs 6 children at `concurrency=3` against
  the same rendezvous testCommand as §1 with `target = 3`: the first three
  children wait for each other (all alive at once), children 4–6 see ≥3 begun
  and exit immediately. Observed `maxOverlap` = **3** = `concurrency` exactly,
  `begun = 6`, `timedOut = 0` — real overlap, never exceeding the configured
  width. (Previously an ~80 ms-sleep `marker.cjs` with overlap inferred from
  timestamps, `skipIf(CI)` because a loaded runner produced `maxOverlap = 1`;
  now runs on CI.)

## 3. Resource bounds hold (`bounds.perf.test.ts`)

- **File size cap (256 KiB):** an oversized approved file whose bytes contain a
  blocked pattern (`process.env`) yields a `too large (… > 262144 bytes)` finding
  and **no content finding** — proving `inspectVariant` short-circuits on
  `stat.size > MAX_FILE_BYTES` and `continue`s **without reading** the file
  (`src/safety.ts:159-162`). It never pulls an oversized file into memory.
- **File count cap (MAX_FILES = 32):** a 33-entry directory is flagged
  `too many entries (33 > 32)` (`src/safety.ts:120`).
- **`maxBuffer`:** a command that floods ~5 MB to stdout under a 64 KiB
  `maxBufferBytes` is bounded — `execFile` aborts (ENOBUFS), the call **never
  throws**, returns a non-zero trace (exitCode 1), terminates in ~60 ms (no hang
  to the 15 s timeout, no OOM), and captured `stdout` is held to the 64 KiB cap.
  Measured: `elapsed≈60 ms, exitCode=1, stdoutBytes=65536`.

Also confirmed by the existing `sandbox.test.ts` suite (not re-tested here):
**scrubbed env** (only `PATH` + 3 identifying vars; ambient `process.env` does not
leak), **timeout** wall-clock budget, and **gate-first** disqualification
(exitCode 99 before any command runs).

## Big-O of the hot paths

- `inspectVariant(dir)` — **O(files × patterns + total bytes)**. Per entry: one
  `lstat`, an allowlist `Set.has` (O(1)), a scan over the fixed blocked-filename
  list, and (only if within the size cap) a `readFile` plus a fixed set of regex
  tests over the content. Files and pattern sets are both hard-capped (≤32 files,
  ≤256 KiB each, constant pattern counts), so each call is bounded by a small
  constant — it cannot blow up on a pathological variant.
- `evolve` — **O(generations × parents × childrenPerGeneration)** variant
  evaluations, each = `tasks` sandbox runs. Children per generation =
  `parents × childrenPerGeneration`; parents ≤ 2 on a stalled generation
  (`archive.selectParents(2)`) or the promoted set. Wall-clock per generation is
  divided by `concurrency` (the `mapLimit` width), bounded by `costBudgetSeconds`
  when set. Commit is a single serial writer pass — O(children) I/O, no fan-out.

## Optimization recommendation

**None needed — already bounded.** The concurrency width, per-generation cost
breaker, file size/count caps, `maxBuffer`, timeout, and scrubbed env are all
real and enforced in code, and the hot paths are constant- or
linearly-bounded with no unbounded fan-out or quadratic scans.

Optional, low-value (do **not** apply unless desired):
- `inspectVariant` reads each file with `readFile(full, 'utf8')` then runs ~17
  regexes over the whole string. Files are already capped at 256 KiB, so this is
  bounded; no change recommended.
- Exporting `mapLimit` would simplify the width-bound test (see §2 note); a
  test-ergonomics improvement only, not a performance change.
