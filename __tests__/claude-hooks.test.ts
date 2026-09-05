// SPDX-License-Identifier: MIT
//
// .claude/hooks/*.sh — PostToolUse hooks wired by .claude/settings.json.
// Each hook reads the Claude Code payload JSON on stdin and acts on
// tool_input.file_path only. These tests feed real payloads through stdin
// and pin exit codes + stderr. POSIX sh only (skipped on Windows); the two
// rustfmt cases self-skip when rustfmt is not on PATH (the Node CI job has
// no Rust toolchain).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const HOOKS = join(ROOT, '.claude', 'hooks');
const RUSTFMT = join(HOOKS, 'rustfmt-on-edit.sh');
const VITEST = join(HOOKS, 'vitest-related.sh');
const isWin = process.platform === 'win32';
// `rustfmt --version`, not `command -v`: rustup's proxy is on PATH even when
// the component is missing (GitHub ubuntu runner) and exits non-zero there.
const hasRustfmt = !isWin && spawnSync('sh', ['-c', 'rustfmt --version'], { stdio: 'ignore' }).status === 0;

interface Result { code: number; stdout: string; stderr: string }

function runHook(script: string, payload: string, env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [script], { cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(payload);
  });
}

const payload = (file_path: string): string =>
  JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path } });

describe('.claude/settings.json wires both hooks', () => {
  it('registers rustfmt (15s) and vitest (120s) as PostToolUse on Write|Edit|MultiEdit', async () => {
    const s = JSON.parse(await readFile(join(ROOT, '.claude', 'settings.json'), 'utf-8'));
    const [entry] = s.hooks.PostToolUse;
    expect(entry.matcher).toBe('Write|Edit|MultiEdit');
    const cmds = entry.hooks.map((h: { command: string; timeout: number }) => [h.command, h.timeout]);
    expect(cmds).toEqual([
      ['${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/rustfmt-on-edit.sh', 15],
      ['${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/vitest-related.sh', 120],
    ]);
    expect(existsSync(RUSTFMT)).toBe(true);
    expect(existsSync(VITEST)).toBe(true);
  });
});

describe.skipIf(isWin)('.claude/hooks/rustfmt-on-edit.sh', () => {
  let proj = '';
  beforeAll(async () => {
    proj = await mkdtemp(join(tmpdir(), 'hook-rustfmt-'));
    await mkdir(join(proj, 'crates', 'demo', 'src'), { recursive: true });
  });
  afterAll(async () => { await rm(proj, { recursive: true, force: true }); });

  it.skipIf(!hasRustfmt)('formats a .rs file under crates/ in place and exits 0', async () => {
    const f = join(proj, 'crates', 'demo', 'src', 'ok.rs');
    await writeFile(f, 'fn main(){let x=1;println!("{}",x);}\n');
    const r = await runHook(RUSTFMT, payload(f), { CLAUDE_PROJECT_DIR: proj });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(await readFile(f, 'utf-8')).toBe('fn main() {\n    let x = 1;\n    println!("{}", x);\n}\n');
  });

  it.skipIf(!hasRustfmt)('exits 2 with rustfmt stderr on an unparsable .rs (repo-relative path)', async () => {
    const f = join(proj, 'crates', 'demo', 'src', 'bad.rs');
    await writeFile(f, 'fn broken( {\n');
    const r = await runHook(RUSTFMT, payload('crates/demo/src/bad.rs'), { CLAUDE_PROJECT_DIR: proj });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/rustfmt-on-edit: rustfmt failed/);
    expect(r.stderr).toMatch(/unclosed delimiter|error/);
  });

  it('ignores a .ts path (exit 0, silent)', async () => {
    const r = await runHook(RUSTFMT, payload(join(proj, 'crates', 'demo', 'src', 'x.ts')), { CLAUDE_PROJECT_DIR: proj });
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('ignores an unparsable payload (exit 0, silent)', async () => {
    const r = await runHook(RUSTFMT, 'not json', { CLAUDE_PROJECT_DIR: proj });
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
  });
});

describe.skipIf(isWin)('.claude/hooks/vitest-related.sh', () => {
  it('exits 0 silently for a path outside packages/', async () => {
    const r = await runHook(VITEST, payload(join(ROOT, 'scripts', 'nope.ts')));
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('exits 0 silently under METAHARNESS_SKIP_VITEST=1 even for a workspace file', async () => {
    const r = await runHook(VITEST, payload(join(ROOT, 'packages', 'kernel-js', 'src', 'index.ts')), {
      METAHARNESS_SKIP_VITEST: '1',
    });
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('exits 2 with the failing output when the owning workspace test fails', async () => {
    const proj = await mkdtemp(join(tmpdir(), 'hook-vitest-'));
    try {
      const ws = join(proj, 'packages', 'foo');
      await mkdir(join(ws, 'src'), { recursive: true });
      // vitest is resolved through the real repo's node_modules (no network).
      await symlink(join(ROOT, 'node_modules'), join(proj, 'node_modules'), 'dir');
      await writeFile(join(proj, 'package.json'), JSON.stringify({ name: 'tproj', private: true, workspaces: ['packages/*'] }));
      await writeFile(join(ws, 'package.json'), JSON.stringify({ name: 'foo', private: true, type: 'module', scripts: { test: 'vitest run' } }));
      await writeFile(join(ws, 'src', 'add.ts'), 'export const add = (a: number, b: number): number => a - b;\n');
      await writeFile(join(ws, 'src', 'add.test.ts'),
        "import { it, expect } from 'vitest';\nimport { add } from './add.js';\nit('adds', () => { expect(add(1, 2)).toBe(3); });\n");
      const r = await runHook(VITEST, payload(join(ws, 'src', 'add.ts')), { CLAUDE_PROJECT_DIR: proj });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/vitest-related: FAILED in foo/);
      expect(r.stderr).toMatch(/expected -1 to be 3/);
    } finally {
      await rm(proj, { recursive: true, force: true });
    }
  }, 60_000);
});
