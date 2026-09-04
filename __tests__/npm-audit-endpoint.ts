// SPDX-License-Identifier: MIT
//
// Shared precondition probe for the LIVE `npm audit` tests
// (audit-deps.test.ts, harness-sbom-audit.test.ts).
//
// Those tests are the real security signal — a genuine high+ advisory in
// the lockfile MUST fail them. But they also depend on npm's advisory
// endpoint (registry.npmjs.org/-/npm/v1/security/advisories/bulk), which
// has returned 503s for hours at a time; with npm's default retry/backoff
// that shows up as a 120s+ hang and a CI failure that has nothing to do
// with the code. So: probe the endpoint ONCE per file with a tiny fixture
// and bounded retries/timeouts, and `describe.skipIf(!probe.ok)` the live
// block ONLY when the endpoint is unreachable or answering 5xx — the same
// convention the repo uses for optional tooling (packages/darwin-mode
// semgrep tests, packages/bench dataset tests). Any other outcome
// (advisories found, 4xx, unexpected output) runs the real tests so the
// failure surfaces loudly.
//
// Not a test file (no `.test.ts` suffix) — vitest's include globs skip it.

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFile = promisify(execFileCb);

export type EndpointProbe = { ok: true; detail: string } | { ok: false; reason: string };

/** Bound on the whole probe; npm is invoked with retries OFF + a short fetch timeout. */
const PROBE_TIMEOUT_MS = 45_000;
const FETCH_TIMEOUT_MS = 15_000;

/** npm `--json` error codes that mean "the endpoint didn't answer", not "npm disagreed". */
const UNREACHABLE_CODES = /^(E5\d\d|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ERR_SOCKET_TIMEOUT|FETCH_ERROR|ENETUNREACH|EHOSTUNREACH)$/;
const UNREACHABLE_TEXT = /\b5\d\d\b.*(service unavailable|bad gateway|gateway time-?out|internal server error)|audit endpoint returned an error|network (timeout|request .* failed)|request-timeout|FETCH_ERROR|getaddrinfo|socket hang up/i;

/**
 * A single dependency-free package with no advisory history, pinned, so the
 * probe request is representative (one real name in the bulk body) and its
 * answer is unambiguous: metadata present ⇒ the endpoint answered.
 */
async function writeProbeFixture(dir: string): Promise<void> {
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'npm-audit-endpoint-probe', version: '0.0.0', private: true,
    dependencies: { picocolors: '1.1.1' },
  }, null, 2));
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify({
    name: 'npm-audit-endpoint-probe', version: '0.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'npm-audit-endpoint-probe', version: '0.0.0', dependencies: { picocolors: '1.1.1' } },
      'node_modules/picocolors': { version: '1.1.1', resolved: 'https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz', license: 'ISC' },
    },
  }, null, 2));
}

/**
 * Is npm's advisory endpoint answering right now?
 *
 *   ok: true   — it answered (with or without advisories) → run the live tests
 *   ok: false  — unreachable / 5xx / hung past the bound → skip them, with the reason
 */
export async function probeNpmAuditEndpoint(): Promise<EndpointProbe> {
  const dir = await mkdtemp(join(tmpdir(), 'ahg-npm-audit-probe-'));
  try {
    await writeProbeFixture(dir);
    const npmArgs = ['audit', '--json', '--audit-level=high', `--fetch-retries=0`, `--fetch-timeout=${FETCH_TIMEOUT_MS}`];
    // Windows: npm is a .cmd shim — same wrapper audit-cmd.ts / audit-deps.mjs use.
    const [bin, args] = process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', 'npm', ...npmArgs]]
      : ['npm', npmArgs];
    let stdout = '', stderr = '', exitCode = 0, killed = false;
    try {
      const r = await execFile(bin, args, {
        cwd: dir, timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 4, windowsHide: true,
      });
      stdout = r.stdout; stderr = r.stderr;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; signal?: string };
      stdout = err.stdout ?? ''; stderr = err.stderr ?? '';
      exitCode = typeof err.code === 'number' ? err.code : 1;
      killed = Boolean(err.killed || err.signal);
    }
    if (killed) {
      return { ok: false, reason: `npm audit did not answer within ${PROBE_TIMEOUT_MS / 1000}s (retries off, fetch-timeout ${FETCH_TIMEOUT_MS}ms)` };
    }
    let parsed: { metadata?: { vulnerabilities?: unknown }; message?: string; error?: { code?: string; summary?: string } } | null = null;
    try { parsed = JSON.parse(stdout); } catch { /* npm prints non-JSON on some failures */ }
    if (parsed?.metadata?.vulnerabilities !== undefined) {
      return { ok: true, detail: 'advisory endpoint answered' };
    }
    if (parsed?.error) {
      const code = String(parsed.error.code ?? '');
      // npm 10 reports a fetch timeout as `{message: "network timeout at: <url>",
      // error: {summary: "", detail: ""}}` — the signature lives in `message`
      // (and on stderr as "audit endpoint returned an error"), NOT in code/summary.
      const text = [parsed.message, parsed.error.summary, stderr].filter(Boolean).join('\n');
      if (UNREACHABLE_CODES.test(code) || UNREACHABLE_TEXT.test(text)) {
        const first = text.split('\n').find(l => UNREACHABLE_TEXT.test(l) || UNREACHABLE_CODES.test(l))?.trim() ?? text.split('\n')[0];
        return { ok: false, reason: `npm audit endpoint unreachable: ${code || 'no code'} — ${first}` };
      }
      // 4xx / auth / anything else: the endpoint IS answering — run the real tests.
      return { ok: true, detail: `npm reported ${code || 'an error'} (endpoint answered)` };
    }
    if (exitCode === 0) {
      return { ok: true, detail: 'npm audit exited 0 (no advisories, no JSON body)' };
    }
    if (UNREACHABLE_TEXT.test(stderr)) {
      return { ok: false, reason: `npm audit endpoint unreachable: ${stderr.split('\n').find(l => UNREACHABLE_TEXT.test(l))?.trim()}` };
    }
    // Unknown non-zero exit without a recognisable network signature: do NOT
    // skip — let the real tests run and surface whatever this is.
    return { ok: true, detail: `npm exited ${exitCode} without a network-failure signature (exit ${exitCode})` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
