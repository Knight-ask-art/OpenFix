# LLM Token 效率优化与本地交付 - Reflection

## Completion Reflection

- The confirmed Token waste came from repeated, large, identical tool results remaining in session history, unbounded ranked retrieval responses, and context limits that did not reserve output, reasoning, safety, or tool-schema tokens. Existing Skill loading and agent-specific tool bundles were already lazy/static, so they were preserved rather than duplicated.
- The implemented policy favors measurable, conservative savings: exact duplicate tool-result replacement, token-capped ranked retrieval with top-result preservation, additive per-call token/cache/source metrics, a reserved input budget, and configured light-model compaction with active-model fallback.
- Synthetic results show large reductions in the capped long-book and RAG-heavy cases, with no reduction for short writing or the ten-message continuity case. Those values are local estimates only. Real provider billing, cache-hit improvements, latency, and prose-quality regression were not measured.
- Generic history eviction, semantic tool-result deletion, Skill digests/RAG, shared retrieval caching, structured Story State, explicit provider cache breakpoints, and broader Agent handoff changes remain deferred until the code can prove freshness and continuity safely.
- Local verification is documented in `90-evidence.md`. Three browser E2E cases remain environment-blocked because the API service was unavailable, and a separate Claude Code review could not start because the local CLI was not logged in. Neither limitation is reported as a pass.
- The V1.0 release gate remains separate from this delivery; real-provider acceptance, signing, remote release, and clean-machine upgrade verification are still outstanding.

Method Pack output does not grant completion authority.
