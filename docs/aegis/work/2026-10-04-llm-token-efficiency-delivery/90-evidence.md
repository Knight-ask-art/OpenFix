# LLM Token 效率优化与本地交付 - Evidence


## EvidenceBundleDraft: backend-frontend-desktop-20261004

- Artifact key: verification-20261004
- Slice ID: backend-frontend-desktop-20261004
- Type: test
- Source: Fresh local backend, frontend, desktop, and Playwright results
- Summary: Backend full suite: 2073 passed; Ruff lint and ty passed. Six focused token, migration, audit, retrieval-budget, and benchmark test modules: 23 passed. Frontend lint, type-check, and production build passed. Desktop lint, type-check, and build passed; Node tests: 134 passed, 2 skipped with --experimental-vm-modules. Browser batch: 36 passed; three agent-context-sources cases did not reach assertions because API 127.0.0.1:8000 was unavailable. Full-repo Ruff format check reports 442 files to reformat; six touched legacy files already fail formatting at HEAD, and broad reformatting was not applied.
- Verifier: Codex local verification
- Evidence status: evidence-finalized

## EvidenceBundleDraft: synthetic-benchmark-20261004

- Artifact key: synthetic-benchmark-20261004
- Slice ID: synthetic-benchmark-20261004
- Type: benchmark
- Source: backend/scripts/token_efficiency_benchmark.py
- Summary: Synthetic o200k_base estimates only; live_provider_calls=0. Short writing 22 to 22; ten-message continuity 141 to 141; chapter-50 retrieval 21758 to 1200; repeated reads 6000 to 3018; duplicate skill outputs 9000 to 3036; RAG-heavy 21758 to 900. Top-ranked result preserved in both capped retrieval cases. No live billing, cache-hit, or prose-quality claim.
- Verifier: Codex local benchmark rerun
- Evidence status: evidence-finalized

## EvidenceBundleDraft: claude-review-attempt-20261004

- Artifact key: claude-review-attempt-20261004
- Slice ID: claude-review-attempt-20261004
- Type: review-attempt
- Source: Claude Code CLI 2.1.288
- Summary: Read-only review invocation returned Not logged in; no independent Claude findings were produced. Authentication settings were not changed.
- Verifier: Codex local CLI output
- Evidence status: evidence-finalized

## EvidenceBundleDraft: git-delivery-20261004

- Artifact key: git-delivery-20261004
- Slice ID: llm-token-efficiency-delivery
- Type: git-delivery
- Source: Local Git readback and successful push to origin
- Summary: 112 reviewed paths committed as bc56eea; origin/feature/branding advanced from a020a2c to bc56eea by a normal fast-forward. Post-push fetch matched local HEAD; branch/worktree status was clean and one worktree remained. CRLF-aware staged diff check and common credential-marker scan passed.
- Verifier: Codex local Git readback
- Evidence status: evidence-finalized
