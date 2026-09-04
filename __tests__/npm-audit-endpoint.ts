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
// Probe-then-run is not enough on its own: the registry can answer the
// probe and then hang or 503 the real audit seconds later (npm's legacy
// `/audits/quick` endpoint, used by npm ≤10.8, is being retired and has been
// degraded for whole days). So the same module also exports the two things
// the live tests need at RUN time — NPM_FAIL_FAST_ENV (bounded fetch, no
// retries, inherited by every `npm audit` child) and
// registryFailureSignature() (one source of truth for "the registry, not
// the code, failed" so a test can ctx.skip() with a reason instead of
// timing out — or reporting a false pass).
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

/**
 * Fail-fast npm config for every LIVE audit child process. npm reads
 * `npm_config_*` from the environment (verified: 5s fetch_timeout + 0 retries
 * turned a multi-minute hang into a 10s `network timeout at:` failure). Both
 * spawn sites — audit-cmd.ts's execFile and scripts/audit-deps.mjs's — pass no
 * `env`, so the child inherits process.env; the tests set these on
 * process.env (in-process auditCmd) or on execFile's env (the script).
 * Defaults would otherwise be 5 min × 3 attempts with 10s–60s backoff.
 */
export const NPM_FAIL_FAST_ENV = {
  npm_config_fetch_timeout: '20000',
  npm_config_fetch_retries: '0',
  npm_config_fetch_retry_mintimeout: '1000',
  npm_config_fetch_retry_maxtimeout: '2000',
} as const;

/** npm `--json` error codes that mean "the endpoint didn't answer", not "npm disagreed". */
const UNREACHABLE_CODES = /^(E5\d\d|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ERR_SOCKET_TIMEOUT|FETCH_ERROR|ENETUNREACH|EHOSTUNREACH)$/;
/**
 * Registry-failure signatures as they appear in npm's TEXT output (stderr,
 * the `message` field of its --json error envelope, or a wrapper's echo of
 * either). Every entry is something the registry/network did, never something
 * an advisory does — so matching one on a FAILED run means "skip with reason",
 * while a FAIL line naming advisories matches nothing here and stays a failure.
 * Observed in the wild (2026-09-04): 503s, 400 "Invalid package tree",
 * multi-minute hangs → `network timeout at:` / `audit endpoint returned an error`.
 */
const UNREACHABLE_TEXT = new RegExp([
  // "503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/... - ..."
  String.raw`\b5\d\d\b.*(service unavailable|bad gateway|gateway time-?out|internal server error)`,
  // any HTTP-status error npm reports for the audit endpoint itself (400 "Invalid
  // package tree", 5xx variants) — the registry misbehaving, never an advisory
  String.raw`\b[45]\d\d\b [^\n]*(POST|GET) https?://registry\.npmjs\.org/-/npm/v1/security/`,
  String.raw`\bE5\d\d\b`, 'Invalid package tree',
  'audit endpoint returned an error', String.raw`network (timeout|request .* failed)`, 'request-timeout',
  // a 200 with a body that is not an audit report (no metadata) — degraded registry
  'npm returned no audit metadata',
  String.raw`\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET_TIMEOUT|FETCH_ERROR)\b`,
  'getaddrinfo', 'socket hang up',
].join('|'), 'i');

/**
 * The first line of `text` that carries a registry/network failure signature,
 * or null when there is none. Use on the OUTPUT of a live run that did not
 * pass: a match ⇒ the registry failed mid-run (skip with this line as the
 * reason); no match ⇒ a genuine failure (advisory, script bug) — let it fail.
 */
export function registryFailureSignature(text: string): string | null {
  for (const line of text.split('\n')) {
    if (UNREACHABLE_TEXT.test(line)) return line.trim();
  }
  return null;
}

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
    const npmArgs = ['audit', '--json', '--audit-level=high'];
    // Windows: npm is a .cmd shim — same wrapper audit-cmd.ts / audit-deps.mjs use.
    const [bin, args] = process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', 'npm', ...npmArgs]]
      : ['npm', npmArgs];
    let stdout = '', stderr = '', exitCode = 0, killed = false;
    try {
      const r = await execFile(bin, args, {
        cwd: dir, timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 4, windowsHide: true,
        env: { ...process.env, ...NPM_FAIL_FAST_ENV },
      });
      stdout = r.stdout; stderr = r.stderr;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; signal?: string };
      stdout = err.stdout ?? ''; stderr = err.stderr ?? '';
      exitCode = typeof err.code === 'number' ? err.code : 1;
      killed = Boolean(err.killed || err.signal);
    }
    if (killed) {
      return { ok: false, reason: `npm audit did not answer within ${PROBE_TIMEOUT_MS / 1000}s (retries off, fetch-timeout ${NPM_FAIL_FAST_ENV.npm_config_fetch_timeout}ms)` };
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
      const sig = registryFailureSignature(text);
      if (UNREACHABLE_CODES.test(code) || sig) {
        return { ok: false, reason: `npm audit endpoint unreachable: ${code || 'no code'} — ${sig ?? text.split('\n')[0]}` };
      }
      // 4xx / auth / anything else: the endpoint IS answering — run the real tests.
      return { ok: true, detail: `npm reported ${code || 'an error'} (endpoint answered)` };
    }
    if (exitCode === 0) {
      return { ok: true, detail: 'npm audit exited 0 (no advisories, no JSON body)' };
    }
    const stderrSig = registryFailureSignature(stderr);
    if (stderrSig) {
      return { ok: false, reason: `npm audit endpoint unreachable: ${stderrSig}` };
    }
    // Unknown non-zero exit without a recognisable network signature: do NOT
    // skip — let the real tests run and surface whatever this is.
    return { ok: true, detail: `npm exited ${exitCode} without a network-failure signature (exit ${exitCode})` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
