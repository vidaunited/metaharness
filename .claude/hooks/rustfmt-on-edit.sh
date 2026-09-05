#!/bin/sh
# SPDX-License-Identifier: MIT
#
# PostToolUse hook (Write|Edit|MultiEdit): run rustfmt on the one Rust file
# that was just edited, if it lives under crates/. Reads the Claude Code hook
# payload JSON from stdin and uses tool_input.file_path.
#
# Exit codes:
#   0 — formatted, nothing to do, or rustfmt is not installed (one stderr line)
#   2 — rustfmt could not parse the file; its stderr is forwarded so the
#       editor sees the real defect (CI runs `cargo fmt --all -- --check`)
#
# Never touches any file other than the edited one.

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
  *.rs) ;;
  *) exit 0 ;;
esac

# Only files under crates/ — absolute ("$root/crates/…") or repo-relative.
case "$f" in
  /*) abs=$f ;;
  *)  abs=$root/$f ;;
esac
case "$abs" in
  "$root"/crates/*) ;;
  *) exit 0 ;;
esac
[ -f "$abs" ] || exit 0

# Probe a WORKING rustfmt, not its presence on PATH: rustup installs a
# `rustfmt` proxy for every toolchain, which exits non-zero with "component
# not installed" when the component is absent (GitHub's ubuntu runner, Node
# CI job). `command -v` said yes there and this hook wrongly returned 2.
if ! rustfmt --version >/dev/null 2>&1; then
  echo "rustfmt-on-edit: rustfmt not installed or not usable; skipped $abs" >&2
  exit 0
fi

if out=$(rustfmt --edition 2021 "$abs" 2>&1); then
  exit 0
fi
printf '%s\n' "rustfmt-on-edit: rustfmt failed on $abs" "$out" >&2
exit 2
