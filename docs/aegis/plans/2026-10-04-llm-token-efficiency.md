# LLM Token and Context Efficiency

## Goal

Reduce repeated and low-value input tokens while keeping current story facts, prose continuity, user constraints, and character/world consistency intact. Add enough per-call telemetry to measure the real effects and make future optimization evidence-based.

## Architecture

Reuse the existing owners: `agent_runtime/context` assembles prompts and compaction overlays; `agent_runtime/agents/tool_categories.py` gives each agent an ordered tool bundle; the existing Skill service supplies manifests and on-demand full content; `agent_runtime/tools` reads chapters and story memory; `audit` records normalized provider usage; `storage/migrations` owns persistent schema changes. Add only a small input-budget calculator, context estimator, and exact duplicate-result soft-GC processor. Do not create a second context engine, retrieval index, prompt cache, or story-state store.

## Tech Stack

Python, FastAPI, LangChain, SQLModel/Alembic, SQLite-compatible migrations, `tiktoken` (`o200k_base`) for estimates, and the existing React/Electron product.

## Baseline and Authority References

- User request in this conversation: audit the actual local checkout, implement token/cost improvements, add tests and benchmarks, run verification, then commit all current changes and push OpenFix's `origin`.
- `../../../../AGENTS.md`: OpenFix coding, privacy, compatibility, and verification constraints. Its Rust/Axum layout description does not match this nested Python/FastAPI repository; `OPENFIX.md` and current code are the implementation facts for OpenFix.
- `../../../OPENFIX.md` §1-5: `OpenFix/` is the writable product, `OpenFic/` is read-only reference, and runtime/backend compatibility is deliberate.
- Current local Git baseline: `feature/branding`, HEAD `b2b2a8f687d3fa51b4c3a6e42db11f6dd40d71e5`, 25 commits ahead of `origin/feature/branding`, one worktree, no staged changes, and 56 modified tracked plus 8 untracked paths already present before this task. Preserve and review that work; do not reset, clean, or broad-stage it.
- Primary code evidence: `backend/app/agent_runtime/context/build_context.py`, `context/parts/{system_prompt,rules,skills,history}.py`, `context/compaction/{tokens,window,service}.py`, `graph/react_agent.py`, `agents/tool_categories.py`, `tools/impls/{chapter/search_chapters.py,memory/search_story_memory.py,skill/skill.py}`, `models/clients/{model_factory,llm_client}.py`, `audit/context.py`, `audit/queue.py`, `storage/models/llm_audit_log.py`, and current `backend/tests/agent_runtime/context`, `backend/tests/agent_runtime/tools`, `backend/tests/audit`, and provider/usage tests.
- Current migration head is `1028_add_revision_chapter_snapshot_volume_id.py`; the local branch's later migration supersedes stale checkpoint references to 1027.
- No `CONTEXT.md`, `CONTEXT-MAP.md`, or project `docs/current/AEGIS_MINIMALITY_REFERENCE.md` / `AEGIS_PROCESS_BASELINE.md` was found. Use the concrete local code and the small Existence Check below; do not invent missing authority documents.

## Token Audit

The audit below is based on the current local source, not GitHub or OpenFic:

| Request content | Current behavior and waste/risk | Decision |
| --- | --- | --- |
| System prompt / Prompt Chain | Compiled from the active chain for each LLM turn. It precedes rules, Skills, and history, so the broad order is already cache-friendly. Token cost is not reported by source. | Keep current owner/order; count by part. |
| Global/project rules | All applicable rule text is rebuilt and included on each turn; repository ordering is deterministic. | Keep required rules; expose estimated cost. |
| Skills | A small manifest is supplied, and tools are added only when an agent has Skills or a message references one. `activate_skill` returns the full Skill and reference index; `reference_skill` returns a whole reference document. Those tool results remain in history until compaction. | Preserve lazy loading. Add exact duplicate result soft-GC; defer digests and section-level reference loading. |
| Conversation and tool history | Current history is reconstructed from the full session transcript; tool replies, Skill contents, reads, and searches stay visible until the compaction overlay replaces old sequence ranges. | Count history by role/source; remove only repeated, byte-identical results from the same tool. |
| Current chapter, scene, plan, summaries, characters, world, notes, and story state | `build_context` does not automatically preload prior chapter prose or all story data. Agents pull these with read/search tools; the current data model does not reliably mark an arbitrary history message as current-scene state. | Keep prose/facts available; do not truncate generic history by relevance guesses. Cap only ranked retrieval tool output. |
| RAG | `search_chapters` returns at most five chunks and drops scores below 0.3. `search_story_memory` defaults to eight, allows twenty, and caps each result at 1,200 characters. Neither has a token budget or marginal-utility stop; there is no shared retrieval-result cache. | Add a model-budget-aware token ceiling while preserving ranked order and at least the top result. |
| Tool definitions | Agent-specific ordered categories already reduce the bundle; category and tool order are static. Schemas are bound each turn and not included in the existing context token estimate. | Keep bundles/order; count schema tokens alongside message tokens. |
| Token budget / compaction | `count_context_tokens` uses `o200k_base`, message text, attachment placeholders, and assistant tool-call JSON; it omits message/protocol overhead and tool schemas. Automatic compaction starts at 80% of raw `max_context_tokens`, without output/reasoning/safety reserves. It keeps `min(20,000, 50% of model context)` and skips windows under 2,000 tokens. | Add a conservative usable-input budget and include schemas in utilization; trigger compaction against usable input. Keep the existing minimum window and preserve a large recent tail. |
| Provider usage / cache | OpenAI, Anthropic, Google/Gemini, OpenRouter, DeepSeek, Mistral, Groq, Cohere, NVIDIA, and compatible adapters exist. Cost helpers recognize some cache read/write variants, but the audit normalizer persists input/output/total and cache-read only; cache-write and reasoning usage are lost. | Normalize common aliases and expose cache-read, cache-write, reasoning, uncached-input, and cache-hit fields with zero-valued fallback when absent. Do not add provider-specific request fields. |
| Prompt caching | Stable prompt/rule/Skill order and deterministic tool category order help implicit prefix caching. No central capability layer or explicit cache breakpoints are present. Provider support and minimum cacheable prefix vary. | Preserve deterministic prefix; report provider usage when supplied. Defer explicit cache control until adapters can guarantee safe behavior. |
| Audit and logs | Per-call token totals, latency, first-token time, tool-call counts, and request detail are already recorded. Full prompts, tool schemas, arguments/results, and completions are persisted only when the audit-detail setting is enabled (queue default is off). There is no category token breakdown. | Store aggregate estimates separately from optional detail payloads. Never add manuscript or prompt text to logs/metrics. |
| Compaction, summaries, helper models | Compaction currently invokes the active Agent model. Chapter/range summaries and other background tasks already have a `light_model` policy. Compaction has no minimum-savings estimate beyond its 2,000-token source floor. | Use configured `light_model` for compaction when available; fall back to the existing active model. Preserve explicit model selection and report exact costs where usage is supplied. |
| Agent tool bundles / handoff | Built-in agents already get distinct ordered tool categories; call and tool counts are audited. Retrieval is not shared across agents, and handoff may require agents to reread. | Retain existing bundles. Defer retrieval caching and structured handoff until revisions and invalidation can be proven. |
| Attachments | Image content is sent as provider content blocks, while estimates use a fixed image-count placeholder. | Mark attachment estimates as approximate; do not claim exact multimodal billing from text estimation. |

The largest confirmed structural waste is repeated full tool-result history (especially Skill/reference and retrieval results) with no soft cleanup, followed by context overflow decisions that count neither schemas nor reserved output/reasoning. Exact production token savings are not known because no production usage breakdown or representative live workload is present in the checkout.

## Existence Check

- Proposed new surfaces: a small pure input-budget/metrics module and one processor for exact duplicate tool results.
- Existing owner/reuse candidate: `context/compaction/tokens.py`, `ContextMessage.metadata`, `audit/context.py`, existing audit migration/model/API, and current RAG tool result models.
- Why existing surface is insufficient: current token helper cannot account for output/reasoning reserve, schemas, per-part totals, or safe duplicate GC; audit schema drops provider fields and breakdowns.
- Creation proof: these helpers feed multiple existing call sites and can be tested independently without taking ownership of prompt assembly, retrieval indexing, or audit storage.
- Entropy / retirement impact: additive migration and API fields retain all legacy counters. The duplicate processor changes only an identical later tool payload; no legacy behavior or provider-specific field is retired.
- Decision: add-with-proof for narrow calculation/GC helpers; reuse all existing context, audit, Skill, and retrieval owners.

## Compatibility Boundary

- Keep `OpenFic/` untouched and use the current local `OpenFix` checkout as the only code baseline.
- Keep the existing `token_cache` field/API meaning as cache-read tokens; add fields rather than reinterpret existing values.
- Add a forward-only migration after local head 1028 with defaults so old audit records and existing SQLite projects continue to load.
- Treat provider token aliases as optional. Unknown fields or missing cache usage produce zero-valued details; no provider request relies on cache features.
- Respect user model configuration. `light_model` is used for compaction only when the setting resolves; otherwise use the current model.
- The duplicate-result GC requires the same tool name and exact result text and runs after compaction overlay, so it never leaves a reference to a result already removed from the model-visible history.
- RAG output remains read-only, preserves rank and current freshness/visibility checks, and is bounded by estimated tokens without changing indexed content.
- Keep all prompt/manuscript text out of new telemetry. Current opt-in audit-detail storage behavior remains intact.

## Change Necessity

- User-visible need: lower repeated context cost, prevent context overflow caused by missing output/schema reserves, and make token spend diagnosable.
- No-change / non-code option: advice or dashboard-only display cannot prevent oversized retrieval and repeated exact tool outputs, nor recover provider usage fields already discarded at the audit boundary.
- Why code change is necessary: budget checks, retrieval caps, provider normalization, and soft-GC must run on the model request path.
- Minimum change boundary: additive budget/metrics/GC helpers, the existing context/audit/RAG/compaction seams, and one additive audit migration/API response.
- Decision: code-change.

## TDD Route

- Mode: `off`
- Decision: `skipped`
- Authority: the repository Aegis routing block in `../../../../AGENTS.md`.
- Test posture: the user explicitly requested tests and benchmark evidence. Add focused fake-provider/unit regression tests and an offline deterministic benchmark; run relevant and repository-wide checks. Do not require RED-first ordering under the declared off mode.
- Verification: migration tests, usage normalization/cache accounting tests, budget/GC/RAG/compaction threshold tests, backend lint/type-check/tests, frontend and desktop checks for the pre-existing pending changes, and `git diff --check`.

## Tasks

1. **Usage telemetry and migration** — extend the existing normalizer for cache read/write, reasoning, and uncached/cache-hit calculations; persist new aggregate columns and token breakdown separately from optional audit details; return additive fields through the audit API. Preserve existing `token_cache` behavior.
2. **Budget and per-call context breakdown** — add a context budget calculator with output, reasoning, and safety reserves; estimate ordered part totals and tool schema tokens without storing text; attach the metrics to the actual ReAct audit call; use usable input plus tool schemas for compaction thresholds and recent-tail selection.
3. **Low-risk soft GC and retrieval budget** — after compaction overlay, replace only repeated same-tool, exact-identical, sufficiently large tool results with a short reference to the earlier visible result. Add a budget-derived ceiling to ranked `search_chapters` and `search_story_memory` output; keep top-ranked facts first and retain freshness/visibility constraints.
4. **Compaction model and offline benchmark** — prefer configured `light_model` for compaction with active-model fallback; add deterministic benchmark cases for short writing, multi-chapter continuity, long-book retrieval, reviewer/actor, Skill-heavy, RAG-heavy, and compaction paths. Label synthetic estimates as such; do not claim live billing or quality wins.
5. **Whole-worktree review and delivery** — review all 56 pre-existing modified and 8 pre-existing untracked paths plus this task's delta, scan for secrets/raw logs, run the requested verification, stage an explicit reviewed path list, commit all authorized work, verify the local commit, and push only to `origin` if the branch remains a fast-forward.

## Verification

- Add fake-provider tests for common OpenAI/OpenRouter, Anthropic, Gemini, and compatible usage shapes, missing metrics, and cache-hit math.
- Add unit tests for budget reserves, stable category ordering, tool-schema measurement, exact duplicate GC, and zero/negative/small-context fallbacks.
- Add RAG tests proving ranked results fit the token ceiling, the first result survives, and hidden/stale/project filters still run before serialization.
- Add compaction tests proving the usable-input threshold includes tool schemas and output/reasoning reserves, plus configured light-model and fallback behavior.
- Run the offline benchmark against fixed fixtures and report its token counts as synthetic `o200k_base` estimates only.
- Run backend `ruff`, `ty`, targeted tests, and the full backend pytest suite; run frontend lint/type-check/build and desktop lint/type-check/tests as applicable to all pre-existing changes.
- Review the full staged diff and run `git diff --cached --check`. Before push, confirm `origin` is `Knight-ask-art/OpenFix`, no upstream-only remote is selected, and `origin/feature/branding` is an ancestor of HEAD.

## Observed Results (2026-10-04)

- The full backend suite passes: `2073 passed`. `ruff check app tests scripts`, `ty check app`, and Ruff format checks for the final compaction-metric change pass.
- Frontend lint, type-check, and production build pass. Desktop lint, type-check, main/setup builds, and Node tests pass: `134 passed`, `0 failed`, `2 skipped` (the local Windows environment lacks symlink creation permission for those cases).
- The focused browser batch passes `36/36`. The three `agent-context-sources` E2E cases cannot reach their assertions in this environment: the frontend at `127.0.0.1:9000` is running, but the configured API backend at `127.0.0.1:8000` is not. The Vite proxy logs `ECONNREFUSED` for `/api/v1/auth/status` and `/api/v1/auth/preferences`, and the pages remain on the loading screen. This is an environment-blocked integration check, not a passing product result.
- The offline benchmark reports `synthetic_o200k_base_estimates` and `live_provider_calls: 0`: short writing `22 → 22`; 10-message continuity `141 → 141`; chapter-50+ retrieval `21,758 → 1,200`; repeated reads `6,000 → 3,018`; duplicate Skill results `9,000 → 3,036`; RAG-heavy `21,758 → 900`. The top-ranked retrieval item survives both capped cases. For a 64k context, usable input is estimated at `51,040`; the 80% soft-compaction threshold is `40,832` rather than the old `51,200` raw-context threshold.
- These are synthetic token estimates, not measured bills or production cache-hit changes. The continuity case demonstrates that the conservative policy preserves all 10 history messages; no live-provider prose-quality evaluation was available, so prose quality and long-book continuity are not claimed as regression-tested.
- The final `tokens_compacted` value is derived from the visible compaction summary text rather than provider-reported output alone, so missing usage fields and appended current-plan text do not inflate estimated savings.
- A fresh delivery verification repeated `uv run ruff check app tests scripts`, `uv run ty check app`, and the full backend suite (`2073 passed`). Six focused token, migration, audit, retrieval-budget, and benchmark test modules pass (`23 passed`). The selected token-efficiency source files and newly added tests pass Ruff formatting after formatting the new audit assertion.
- A repository-wide `ruff format --check app tests scripts` is not a clean gate: it reports 442 files would be reformatted. A focused working-tree check also finds several touched legacy files already fail the same formatter at `HEAD`; these were left intact to avoid unrelated whole-file formatting changes. The formatter-clean token-efficiency files pass; the existing legacy formatting baseline remains a follow-up.
- Fresh frontend lint, type-check, and production build pass. Desktop lint, type-check, and build pass; the Node suite passes `134` tests with `2` host-permission skips when invoked with `node --experimental-vm-modules --test tests/main/*.test.mjs`.
- The read-only Claude Code review could not start because the installed CLI returned `Not logged in · Please run /login`; no Claude review findings are claimed. Local review and Git closeout completed without changing authentication settings.
- Delivery completed: all 112 reviewed paths were committed as `bc56eea` (`feat(openfix): deliver token efficiency and product updates`). After fetching `origin`, `origin/feature/branding` at `a020a2c` was confirmed as an ancestor; the normal push fast-forwarded it to `bc56eea`. A subsequent fetch confirmed the remote tip equals local HEAD, the worktree is clean, and one worktree remains. This does not establish V1.0 release readiness.

## Deferred Scope

Do not implement broad relevance-based history eviction, automatic compression of generic user/chapter text, semantic tool-result deletion, Skill Digest or section-level Skill RAG, retrieval caches with revision invalidation, structured Story State extraction, structured Agent handoff/span-based Actor edits, batch tool calls, explicit provider cache breakpoints/capability negotiation, or a dashboard redesign in this slice. Current metadata does not reliably separate current-scene prose from long-term facts; deleting it by generic relevance would risk continuity. These remain candidates after the new measurements and quality fixtures exist.

## Risks and Stop Conditions

- Never prune non-identical tool results or erase novel facts to meet a target token count.
- If the new additive migration conflicts with local schema history, stop migration edits and report the exact divergence.
- If RAG trimming removes the highest-ranked item or violates story-memory freshness / hidden-item filters, fix before claiming the cap is safe.
- Report benchmark results only for fixed synthetic fixtures and provider usage only when the provider actually supplied the field.
- Do not force V1.0 release readiness: signing, remote Actions/Release, real provider acceptance, and clean-machine upgrade gates remain independent.
- Preserve and include all current local modifications in delivery; do not reset, clean, overwrite, or push upstream.
