# Phase 5 Windows Release and Update Slice

## Goal

Connect OpenFix Windows packages to releases in its own GitHub repository and make the package, update metadata, and release workflow use the same OpenFix artifact names.

## Architecture

`desktop/electron-builder.yml` and the packaged `app-update.yml` define the production update feed. `desktop/src/main/updater.ts` reads release metadata and controls the update UI. `desktop/scripts/prepare-windows-update.mjs` creates architecture-specific update manifests, and the GitHub workflows build and upload the referenced assets.

## Tech Stack

Electron, `electron-updater`, `electron-builder`, Node.js scripts, and GitHub Actions.

## Baseline and Authority References

- `../../../../AGENTS.md`: OpenFix is writable; OpenFic is read-only; retain upstream compatibility and legal notices; avoid unrelated runtime rewrites.
- `../../../../docs/04-fork-and-packaging-roadmap.md` §14: Phase 5 updates must target the product's own GitHub repository.
- `../../../OPENFIX.md` §5: TASK-014 release verification is recorded as complete for its first round; own GitHub Releases and automatic updates are the next release-engineering slice.
- `../../../desktop/electron-builder.yml`, `../../../desktop/resources/app-update.yml`, `../../../desktop/src/main/updater.ts`, `../../../desktop/scripts/prepare-windows-update.mjs`, `../../../.github/workflows/package.yml`, and `../../../.github/workflows/package-check.yml`: current implementation baseline.

## Compatibility Boundary

- Production updater identity is `Knight-ask-art/OpenFix`, as recorded by `OPENFIX.md` and the current `origin` remote.
- The local update harness remains on its loopback generic feed and keeps its current behavior.
- Preserve the internal `openfic` backend wheel, CLI, database, and upstream attribution; this slice does not perform the Phase 3 backend package rename.
- Keep OpenFic source read-only. Do not create tags, publish releases, push branches, or configure signing without a signing identity.
- A forked OpenFix tag must not publish inherited PyPI `openfic` packages or Docker images as a side effect; keep those jobs limited to their upstream owner while allowing OpenFix desktop release assets.

## TDD Route

- Mode: `off`
- Decision: `skipped`
- Authority: `../../../../AGENTS.md` Aegis routing block.
- Test posture: do not add or run tests for this slice. Use a scoped diff review and non-test static checks; report package/runtime checks that remain unverified.

## Change Necessity

The current production feed is deliberately disabled, updater repository constants are empty, and update asset preparation plus CI still expect `OpenFic-*` names while the Windows builder emits `OpenFix-*`. Configuration-only changes cannot resolve the asset-name mismatch or prove that both architecture manifests point to uploaded files, so the existing updater and release-script owners need a narrow code/config repair.

## Task

Integrate the production Windows GitHub update feed with the release pipeline as one coordinated change: configure `Knight-ask-art/OpenFix` in the builder, packaged feed resource, and updater runtime; align manifest generation, Windows release upload globs, and package checks with `OpenFix-*` x86_64/aarch64 artifacts; guard inherited PyPI/Docker publication jobs so OpenFix desktop tags cannot publish upstream package identities while allowing the desktop release job to proceed when PyPI is skipped; run the existing `build-backend-wheel.mjs` on Windows package-check and release runners before Electron Builder so clean runners include the internal OpenFix backend wheel; strengthen the existing release verifier for the feed identity and both architecture manifests; then update `OPENFIX.md` with implementation status and remaining release/signing limits. Preserve the loopback local-update configuration and the internal `openfic` wheel identity.

## Verification

- `git diff --check` passes for the task diff.
- Inspect the complete diff against this plan and confirm the production updater never targets OpenFic and the local harness stays on loopback.
- Confirm the Windows package-check and release jobs stage the internal wheel before Electron Builder, and an OpenFix release can proceed when the upstream-only PyPI job is skipped.
- Do not claim an installer, GitHub Release, signature, or in-app update was validated unless that operation was actually performed.

## Risks and Stop Conditions

- If the recorded repository identity conflicts with the current GitHub source, stop and report the mismatch rather than guessing.
- Do not publish, tag, push, or sign. Missing signing credentials and real-release validation remain explicit follow-up work.
- Preserve release workflow behavior outside the stated desktop release boundary; do not otherwise rewrite the multi-platform build.
