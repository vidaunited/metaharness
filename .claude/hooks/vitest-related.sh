#!/bin/sh
# SPDX-License-Identifier: MIT
#
# PostToolUse hook (Write|Edit|MultiEdit): run `vitest related` for the one
# TypeScript file that was just edited, inside the workspace that owns it.
# Reads the Claude Code hook payload JSON from stdin (tool_input.file_path).
#
# Runs only for .ts/.tsx under packages/<workspace>/ that are not .d.ts, not
# under node_modules/ or dist/, and not in a workspace the root package.json
# negates in "workspaces" (e.g. "!packages/agntcy"). The test runs in the
# nearest ancestor directory whose package.json "test" script mentions vitest.
#
# Exit codes:
#   0 — skipped, no owning vitest workspace, or tests passed (one stderr line)
#   2 — vitest failed; the last 30 lines of its output go to stderr
#
# METAHARNESS_SKIP_VITEST=1 disables the hook.

[ "${METAHARNESS_SKIP_VITEST:-}" = "1" ] && exit 0

root=${CLAUDE_PROJECT_DIR:-$PWD}

f=$(node -e '
let d = "";
process.stdin.on("data", c => { d += c; }).on("end", () => {
  try {
    const j = JSON.parse(d);
    const p = j && j.tool_input && j.tool_input.file_path;
    if (typeof p === "string") process.stdout.write(p);
  } catch { /* unparsable payload: print nothing */ }
});
' 2>/dev/null) || exit 0
[ -n "$f" ] || exit 0

case "$f" in
  *.d.ts) exit 0 ;;
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

case "$f" in
  /*) abs=$f ;;
  *)  abs=$root/$f ;;
esac
# Canonicalise both sides (pwd -P resolves symlinks). macOS's temp dir is
# /var/folders -> /private/var, and vitest matches REAL paths: handed the
# symlinked path, `vitest related` related nothing and --passWithNoTests
# turned a failing workspace into "ok" (CI macos-latest, 2026-09-05).
root=$(cd "$root" 2>/dev/null && pwd -P) || exit 0
absdir=$(cd "$(dirname "$abs")" 2>/dev/null && pwd -P) || exit 0
abs=$absdir/$(basename "$abs")
rel=${abs#"$root"/}
[ "$rel" != "$abs" ] || exit 0          # not inside the project

case "$rel" in
  packages/*/*) ;;
  *) exit 0 ;;
esac
case "/$rel" in
  */node_modules/*|*/dist/*) exit 0 ;;
esac

ws=${rel#packages/}
ws=${ws%%/*}

# Honour the root package.json "workspaces" negations ("!packages/<name>").
excluded=$(node -e '
try {
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ws = Array.isArray(j.workspaces) ? j.workspaces : (j.workspaces && j.workspaces.packages) || [];
  for (const w of ws) {
    if (typeof w === "string" && w.startsWith("!packages/")) console.log(w.slice("!packages/".length).replace(/\/+$/, ""));
  }
} catch { /* no root package.json: nothing excluded */ }
' "$root/package.json" 2>/dev/null)
for x in $excluded; do
  [ "$x" = "$ws" ] && exit 0
done

# Nearest ancestor package.json whose "test" script mentions vitest.
d=$(dirname "$abs")
pkgdir=
while :; do
  if [ -f "$d/package.json" ] && node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.exit(/vitest/.test((j.scripts && j.scripts.test) || "") ? 0 : 1);
  ' "$d/package.json" 2>/dev/null; then
    pkgdir=$d
    break
  fi
  [ "$d" = "$root" ] && break
  parent=$(dirname "$d")
  [ "$parent" = "$d" ] && break
  d=$parent
done
[ -n "$pkgdir" ] || exit 0

# `timeout` is GNU coreutils: absent on macOS (CI's macos-latest job failed
# with "timeout: command not found", exit 127). Fall back to Homebrew's
# `gtimeout`, then to no wrapper — the hook-level 120 s timeout in
# .claude/settings.json still bounds the run.
if command -v timeout >/dev/null 2>&1; then to="timeout 90"
elif command -v gtimeout >/dev/null 2>&1; then to="gtimeout 90"
else to=""
fi

log=$(mktemp "${TMPDIR:-/tmp}/vitest-related.XXXXXX") || exit 0
start=$(date +%s)
(
  cd "$pkgdir" && $to npx vitest related "$abs" --run --passWithNoTests
) >"$log" 2>&1
status=$?
elapsed=$(( $(date +%s) - start ))

if [ "$status" -ne 0 ]; then
  echo "vitest-related: FAILED in $ws (exit $status, ${elapsed}s) — last 30 lines:" >&2
  tail -n 30 "$log" >&2
  rm -f "$log"
  exit 2
fi
echo "vitest-related: $ws ok (${elapsed}s)" >&2
rm -f "$log"
exit 0
