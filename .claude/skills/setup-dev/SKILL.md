---
name: setup-dev
description: Prerequisite checks and the ordered TypeScript + Rust + WASM build for this repo, with the exact test commands.
disable-model-invocation: true
---

# setup-dev — build this repo from a clean checkout

Every command below is taken from the cited file; run them in order from the repo root.

## 1. Prerequisites (check before building)

| Need | Why | Source |
|------|-----|--------|
| Node 20 (22 also tested) + npm | `engines.node >= 20`; CI matrix `node: ['20','22']`, every other job pins `'20'` | `package.json` (engines), `.github/workflows/ci.yml` (node job) |
| rustup | `rust-toolchain.toml` pins `channel = "1.88.0"`, components `rustfmt, clippy`, target `wasm32-unknown-unknown`; rustup installs all three on first `cargo` call | `rust-toolchain.toml`, `Cargo.toml` (`rust-version = "1.85"`) |
| wasm-pack (optional, WASM backend) | `build:wasm` shells out to `wasm-pack build … --target nodejs`; CI installs via `rustwasm.github.io/wasm-pack/installer/init.sh` (Linux/macOS) or `cargo install wasm-pack --version 0.13.1` (Windows) | `packages/kernel-js/package.json` (`build:wasm`), `ci.yml` (wasm job) |
| wasm-tools 1.250.0 (optional, validation) | `wasm-tools validate crates/kernel-wasm/pkg/*.wasm` + 500 KB size gate | `ci.yml` (wasm job) |
| napi CLI (optional, native backend) | `@napi-rs/cli ^3` is a root devDependency, so `npx napi` works after `npm ci`; `build:napi` calls it | `package.json` (devDependencies, `build:napi`), `crates/kernel-napi/package.json` |

Quick check: `node -v && npm -v && rustup show && (wasm-pack -V; npx napi --version) || true`

## 2. Ordered build

1. `npm ci` — installs the npm workspaces `packages/*` except `!packages/agntcy` (`package.json` → `workspaces`).
2. Optional WASM kernel: `npm run build:wasm` → runs `build:wasm` in `@metaharness/kernel`:
   `RUSTFLAGS= wasm-pack build ../../crates/kernel-wasm --target nodejs --release --out-dir ../../packages/kernel-js/pkg`,
   removes `pkg/.gitignore`, and rewrites `pkg/package.json` to `"type": "commonjs"` (`packages/kernel-js/package.json`).
   The loader imports `../pkg/ruflo_kernel_wasm.js` and falls back to pure JS when absent (`packages/kernel-js/src/index.ts` → `loadWasm`).
   wasm-opt flags live in `crates/kernel-wasm/Cargo.toml` (`[package.metadata.wasm-pack.profile.release]`).
3. Optional native kernel: `npm run build:napi` →
   `cd crates/kernel-napi && napi build --platform --release --output-dir ../../packages/kernel-js/native`
   (`package.json`; targets listed in `crates/kernel-napi/package.json` → `napi.targets`; `crates/kernel-napi/build.rs` runs `napi_build::setup()`).
   Note: `loadNative` in `packages/kernel-js/src/index.ts` resolves the `@metaharness/kernel-<platform>` optional packages, not `native/`.
4. `npm run build` → `node scripts/build-ordered.mjs`: four topological phases, each `npm run --if-present build` per package in parallel
   (`scripts/build-ordered.mjs` → `PHASES`): (1) `kernel-js`, `router`, `harness`, `darwin-mode`, `projects`, `redblue`, `weight-eft`, `jujutsu`,
   `flywheel`, `workspace-lens`, `radio`, `horizon`, `turn-credit`; (2) `vertical-base`, `evals-*`, `workspace-probe`, `oo-agents`;
   (3) all `host-*`, `sdk`, `create-agent-harness`; (4) `vertical-trading`, `bench`, `agent-harness-generator-lib`.
   A phase failure stops the run with exit code 1. Steps 2–3 are not required for step 4: `packages/kernel-js/tsconfig.json` excludes `pkg` and `native`.

## 3. Tests

- TypeScript workspaces: `npm test` — `pretest` re-runs `npm run build`, then `npm run -ws --if-present test` (each workspace's `test` is `vitest run`) (`package.json`).
- Root suite (`__tests__/`, not covered by `npm test`): `npx vitest run --exclude "packages/**" --exclude "**/*.real.test.ts"` (`ci.yml` node job; includes from `vitest.config.ts`).
- Rust: `npm run fmt:rust` (`cargo fmt --all`; CI uses `cargo fmt --all -- --check`), `npm run clippy` (`cargo clippy --workspace --all-targets -- -D warnings`),
  `npm run test:rust` (`cargo test --workspace`; `poker-darwin` is built at `opt-level = 3` for dev/test per `Cargo.toml`), `cargo doc --workspace --no-deps` with `RUSTDOCFLAGS=-D warnings` (`ci.yml` rust job).
- Smoke: `npm run smoke` → `scripts/smoke.mjs` imports `packages/kernel-js/dist/index.js` (needs step 4), checks `kernelInfo().version` equals
  `packages/kernel-js/package.json` version and `mcpValidate` behaviour, and prints the resolved backend.
- Optional peer package: `npm run install:agntcy` (`npm install --prefix packages/agntcy --no-audit --no-fund`) then `npm run test:agntcy`
  (`npm --prefix packages/agntcy run build && npm --prefix packages/agntcy test`); needs buf.build reachable (`package.json`, `ci.yml` comment).
- Extra CI gates worth running locally: `node scripts/path-guard.mjs`, `node scripts/healthcheck.mjs` (`ci.yml` node job).
