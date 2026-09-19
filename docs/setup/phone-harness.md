# Phone Harness setup

[`phone-harness`](https://github.com/ShawnPana/phone-harness) lets an agent control a physical iPhone or Android device — view the screen via OCR, tap coordinates or text, type input, open apps — without jailbreaking. It's an optional, external skill: relevant to a generated harness that needs device-control capability, not part of `agent-harness-generator`'s own build/publish pipeline.

## Prerequisites

- macOS, Linux, or Windows host with a **physical phone attached**
  - iOS: iPhone Mirroring (macOS only)
  - Android: `adb` with USB debugging enabled
- Python 3
- OS-level permissions granted interactively (Accessibility, Screen Recording) — this step cannot be scripted or run headless

Phone Harness needs a real device and an interactive desktop session. It will not work in CI, in a headless container, or in any remote/cloud execution environment with no attached hardware.

## Install

```bash
git clone https://github.com/ShawnPana/phone-harness ~/.phone-harness
cd ~/.phone-harness
# follow install.md in the repo for OS-specific steps
```

Verify the CLI is on `PATH` and functioning:

```bash
phone-harness --doctor
```

## Register as a Claude Code skill

```bash
phone-harness skill
```

Then complete device onboarding per the repo's `onboarding.md` — granting Accessibility/Screen Recording (iOS) or enabling developer options (Android).

## Using it from a generated harness

If a harness scaffolded by this generator needs phone control, treat `phone-harness` as a skill dependency documented in that harness's own setup docs (see `packages/create-agent-harness`), not as a kernel primitive — it requires host hardware and interactive permission grants that a scaffolded harness cannot provision on its own.
