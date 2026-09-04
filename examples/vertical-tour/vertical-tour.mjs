#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// examples/vertical-tour/vertical-tour.mjs
//
// Analogue of iter-55's host-tour: scaffold + validate EVERY vertical
// in one run, surfacing markdown table + the one vertical that drifts
// (if any). Closes the per-vertical-example combinatorial trap:
// instead of writing a separate examples/<vertical>/ for each of 18
// templates, this one script proves the whole catalog scaffolds
// cleanly. Adding a new vertical is two lines in catalog.def.mjs +
// healthcheck catalogCount; this tour automatically covers it.
//
// Run with:
//   node examples/vertical-tour/vertical-tour.mjs                  # default host claude-code
//   node examples/vertical-tour/vertical-tour.mjs --host=codex     # any of 6 hosts
//   node examples/vertical-tour/vertical-tour.mjs --json           # machine output

import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold, TEMPLATES } from '../../packages/create-agent-harness/dist/index.js';
import { validate } from '../../packages/create-agent-harness/dist/validate.js';

function parseFlag(name, fallback) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.slice(`--${name}=`.length) : fallback;
}

async function countFiles(dir) {
  let n = 0;
  let bytes = 0;
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = await countFiles(p);
      n += sub.n;
      bytes += sub.bytes;
    } else {
      n += 1;
      const st = await stat(p);
      bytes += st.size;
    }
  }
  return { n, bytes };
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  return `${(n / 1024).toFixed(1)}K`;
}

async function tour(template, host) {
  const slug = template.replace(/[^a-z0-9]/gi, '-');
  const dir = await mkdtemp(join(tmpdir(), `ahg-vtour-${slug}-`));
  const t0 = Date.now();
  try {
    await scaffold({
      name: `${slug}-bot`,
      template,
      host,
      description: `vertical-tour iter 88 — ${template}`,
      targetDir: dir,
      force: true,
      generatorVersion: '0.1.0',
    });
    const { n, bytes } = await countFiles(dir);
    const v = await validate([dir, '--skip-gcp']);
    const healthy = v.lines.join('\n').includes('Result: HEALTHY');
    const dt = Date.now() - t0;
    return { template, host, n, bytes, dt, healthy };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const host = parseFlag('host', 'claude-code');
  const jsonOut = process.argv.includes('--json');

  // Tour the actually-registered TEMPLATES export from the built
  // generator — if someone adds a template to catalog.def.mjs but
  // forgets to update TEMPLATES, this script automatically surfaces
  // the drift instead of pinning a duplicate list here.
  const templates = TEMPLATES.filter(t => t !== 'minimal');

  process.stderr.write(`agent-harness-generator — vertical tour\n`);
  process.stderr.write(`scaffolding ${templates.length} verticals on host ${host}\n\n`);

  const reports = [];
  const t0 = Date.now();
  for (const tpl of templates) {
    try {
      reports.push(await tour(tpl, host));
    } catch (err) {
      reports.push({
        template: tpl, host, n: 0, bytes: 0, dt: 0, healthy: false,
        error: err?.message ?? String(err),
      });
    }
  }
  const total = Date.now() - t0;

  if (jsonOut) {
    const failed = reports.filter(r => !r.healthy);
    process.stdout.write(JSON.stringify({
      host, count: templates.length, reports, totalMs: total,
      failed: failed.length, ok: failed.length === 0,
    }, null, 2) + '\n');
    // stdout on a pipe is async and macOS's pipe buffer is ~8 KB; process.exit()
    // right after a large write truncates whatever hasn't flushed yet.
    process.exitCode = failed.length === 0 ? 0 : 1;
    return;
  }

  process.stdout.write('# Vertical Tour — output\n\n');
  process.stdout.write(`| Template | files | bytes | wall | validate |\n`);
  process.stdout.write(`|----------|-------|-------|------|----------|\n`);
  for (const r of reports) {
    process.stdout.write(
      `| \`${r.template}\` | ${r.n} | ${fmtBytes(r.bytes)} | ${r.dt}ms | ${r.healthy ? 'HEALTHY' : 'FAIL'} |\n`
    );
  }
  process.stdout.write(`\nTotal wall time: ${total}ms across ${reports.length} verticals (host=${host}).\n`);

  const failed = reports.filter(r => !r.healthy);
  if (failed.length > 0) {
    process.stderr.write(`\n[vertical-tour] FAIL: ${failed.length} of ${reports.length} verticals failed\n`);
    for (const r of failed) {
      process.stderr.write(`  - ${r.template}${r.error ? ` (${r.error})` : ''}\n`);
    }
    // Follows the full markdown table above (up to 17 verticals) — same
    // async-pipe/exit() truncation risk as the JSON path above.
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`\n[vertical-tour] DONE — ${reports.length}/${reports.length} verticals HEALTHY in ${total}ms\n`);
}

main().catch(err => {
  process.stderr.write(`[vertical-tour] FAIL: ${err?.stack ?? err}\n`);
  process.exit(1);
});
