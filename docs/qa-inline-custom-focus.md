# Inline AI custom instruction focus regression

## Symptom and cause

The floating Inline AI menu cancelled every bubbling mousedown event. This kept
the editor selection intact, but also prevented the custom instruction textarea
from receiving native mouse focus. The Generate button stayed disabled when users
could not enter an instruction. The saved selection already protects the original
text while the menu is open.

## Repair boundary

Allow native focus for textarea, input and select controls inside the floating
menu. Keep selection-preserving behaviour for other surfaces. No request,
acceptance, conflict-check or persistence contract changes.

The existing custom-instruction browser test previously used Playwright fill,
which bypassed mouse focus. It now clicks the textarea, asserts focus, types via
the keyboard, and checks the submitted instruction and saved selection.

## Verification

- `pnpm exec playwright test e2e/inline-ai-review-controls.spec.ts`: 20 passed,
  covering both English and Chinese custom instructions, regenerate, insert,
  acceptance conflicts and editor selection behaviour.
- `pnpm type-check`: 0 errors / warnings.
- `pnpm lint`: 0 errors / warnings.
- `pnpm build`: passed; existing large chunk warning remains.

The installed 0.12.3 runtime's configured embedding model resolved successfully.
Its chapter index initially reported `no_index`, not `not_configured`. Starting
the existing index job completed successfully and the API reported `fresh`.
This metadata-only runtime check does not prove that an earlier tooltip could
never have shown a stale configuration state.

This frontend repair is later than the published v0.12.3 tag; it requires a new
installer release to reach the installed desktop UI.
