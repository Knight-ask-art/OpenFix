import { useTranslation } from "react-i18next";

import type {
  AgentContextCategory,
  AgentContextRuntime,
  AgentContextRuntimeSkipReason,
  AgentContextSource,
  AgentContextSourceType,
} from "../lib/agent-context-sources";

import "./agent-context-panel.css";

interface AgentContextPanelProps {
  sources: AgentContextSource[];
  runtime?: AgentContextRuntime | null;
}

const CATEGORY_ORDER: AgentContextCategory[] = [
  "conversation",
  "chapter",
  "character",
  "worldEntry",
  "outline",
  "note",
  "rule",
  "skill",
];

const CATEGORY_LABELS: Record<AgentContextCategory, string> = {
  conversation: "assistant.contextSources.categories.conversation",
  chapter: "assistant.contextSources.categories.chapters",
  character: "assistant.contextSources.categories.characters",
  worldEntry: "assistant.contextSources.categories.worldEntries",
  outline: "assistant.contextSources.categories.outlines",
  note: "assistant.contextSources.categories.notes",
  rule: "assistant.contextSources.categories.rules",
  skill: "assistant.contextSources.categories.skills",
};

const SOURCE_LABELS: Record<AgentContextSourceType, string> = {
  compactionSummary: "assistant.contextSources.sources.compactionSummary",
  chapterBody: "assistant.contextSources.sources.chapterBody",
  chapterCatalog: "assistant.contextSources.sources.chapterCatalog",
  chapterSearch: "assistant.contextSources.sources.chapterSearch",
  chapterSummary: "assistant.contextSources.sources.chapterSummary",
  rangeSummary: "assistant.contextSources.sources.rangeSummary",
  characterList: "assistant.contextSources.sources.characterList",
  characterProfile: "assistant.contextSources.sources.characterProfile",
  worldEntryList: "assistant.contextSources.sources.worldEntryList",
  worldEntryContent: "assistant.contextSources.sources.worldEntryContent",
  noteList: "assistant.contextSources.sources.noteList",
  noteContent: "assistant.contextSources.sources.noteContent",
  storyMemorySearch: "assistant.contextSources.sources.storyMemorySearch",
  mentionReference: "assistant.contextSources.sources.mentionReference",
  mentionExcerpt: "assistant.contextSources.sources.mentionExcerpt",
  availableSkill: "assistant.contextSources.sources.availableSkill",
  activatedSkill: "assistant.contextSources.sources.activatedSkill",
  agentRules: "assistant.contextSources.sources.agentRules",
};

const RUNTIME_REASON_LABELS: Record<AgentContextRuntimeSkipReason, string> = {
  no_project: "assistant.contextSources.runtime.reasons.no_project",
  agent_unavailable: "assistant.contextSources.runtime.reasons.agent_unavailable",
  agent_disabled: "assistant.contextSources.runtime.reasons.agent_disabled",
  note_read_disabled: "assistant.contextSources.runtime.reasons.note_read_disabled",
  skill_disabled: "assistant.contextSources.runtime.reasons.skill_disabled",
  profile_missing: "assistant.contextSources.runtime.reasons.profile_missing",
  profile_ambiguous: "assistant.contextSources.runtime.reasons.profile_ambiguous",
  profile_unconfirmed: "assistant.contextSources.runtime.reasons.profile_unconfirmed",
  profile_invalid: "assistant.contextSources.runtime.reasons.profile_invalid",
  profile_budget: "assistant.contextSources.runtime.reasons.profile_budget",
  no_valid_confirmed_card: "assistant.contextSources.runtime.reasons.no_valid_confirmed_card",
  token_budget: "assistant.contextSources.runtime.reasons.token_budget",
  dropped: "assistant.contextSources.runtime.reasons.dropped",
};

// Guidance shown under the runtime section. profile_* notes explain how to
// prepare the note in the note editor; none of them claim a card is confirmed.
const RUNTIME_REASON_NOTES: Record<AgentContextRuntimeSkipReason, string> = {
  no_project: "assistant.contextSources.runtime.notes.default",
  agent_unavailable: "assistant.contextSources.runtime.notes.default",
  agent_disabled: "assistant.contextSources.runtime.notes.default",
  note_read_disabled: "assistant.contextSources.runtime.notes.default",
  skill_disabled: "assistant.contextSources.runtime.notes.default",
  profile_missing: "assistant.contextSources.runtime.notes.profile_missing",
  profile_ambiguous: "assistant.contextSources.runtime.notes.profile_ambiguous",
  profile_unconfirmed: "assistant.contextSources.runtime.notes.profile_unconfirmed",
  profile_invalid: "assistant.contextSources.runtime.notes.profile_invalid",
  profile_budget: "assistant.contextSources.runtime.notes.profile_budget",
  no_valid_confirmed_card: "assistant.contextSources.runtime.notes.profile_legacy",
  token_budget: "assistant.contextSources.runtime.notes.token_budget",
  dropped: "assistant.contextSources.runtime.notes.default",
};

function getSourceTitle(  source: AgentContextSource,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (source.category === "rule") {
    return source.title || t("assistant.contextSources.ruleSourceTitle");
  }

  if (source.category !== "chapter") return source.title;

  if (source.chapterStartOrder !== undefined && source.chapterEndOrder !== undefined) {
    return t("assistant.contextSources.chapterRange", {
      start: source.chapterStartOrder,
      end: source.chapterEndOrder,
    });
  }

  if (source.chapterOrder !== undefined) {
    if (source.title) {
      return t("assistant.contextSources.chapterTitle", {
        order: source.chapterOrder,
        title: source.title,
      });
    }
    return t("assistant.contextSources.chapterNumber", { order: source.chapterOrder });
  }

  return source.title;
}

function RuntimeRow({ label, value }: { label: string; value: string }) {
  return (
    <li className="agent-context-item">
      <span className="agent-context-item__title">{label}</span>
      <span className="agent-context-item__sources">
        <span className="agent-context-source-tag">{value}</span>
      </span>
    </li>
  );
}

export function AgentContextPanel({ sources, runtime }: AgentContextPanelProps) {
  const { t } = useTranslation();
  const sections = CATEGORY_ORDER.map((category) => ({
    category,
    items: sources.filter((source) => source.category === category),
  })).filter((section) => section.items.length > 0);
  const runtimeTitle = runtime?.style
    ? runtime.style.status === "loaded"
      ? t("assistant.contextSources.runtime.styleLoaded")
      : t("assistant.contextSources.runtime.styleSkipped")
    : t("assistant.contextSources.runtime.modelId");
  // Status notes derive from the fixed reason only; snapshot text is never shown.
  const styleNote =
    runtime?.style?.status === "skipped" ? t(RUNTIME_REASON_NOTES[runtime.style.reason]) : null;

  return (
    <div
      className="agent-context-panel"
      role="region"
      aria-label={t("assistant.contextSources.panelLabel")}
    >
      <div className="agent-context-panel__intro">
        <p className="agent-context-panel__description">
          {t("assistant.contextSources.description", { count: sources.length })}
        </p>
      </div>

      {sections.length > 0 ? (
        <div className="agent-context-panel__sections">
          {sections.map((section) => (
            <section
              className="agent-context-section"
              key={section.category}
              aria-labelledby={`agent-context-${section.category}`}
            >
              <h3
                className="agent-context-section__title"
                id={`agent-context-${section.category}`}
              >
                {t(CATEGORY_LABELS[section.category])}
                <span className="agent-context-section__count">{section.items.length}</span>
              </h3>
              <ul className="agent-context-section__list">
                {section.items.map((source) => (
                  <li
                    className="agent-context-item"
                    key={source.id}
                  >
                    <span className="agent-context-item__title">{getSourceTitle(source, t)}</span>
                    <span className="agent-context-item__sources">
                      {source.sourceTypes.map((sourceType) => (
                        <span
                          className="agent-context-source-tag"
                          key={sourceType}
                        >
                          {t(SOURCE_LABELS[sourceType])}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <p
          className="agent-context-panel__empty"
          role="status"
        >
          {t("assistant.contextSources.empty")}
        </p>
      )}

      {runtime ? (
        <section
          className="agent-context-section"
          aria-labelledby="agent-context-runtime"
        >
          <h3
            className="agent-context-section__title"
            id="agent-context-runtime"
          >
            {runtimeTitle}
          </h3>
          <ul className="agent-context-section__list">
            {runtime.model ? (
              <RuntimeRow
                label={t("assistant.contextSources.runtime.modelId")}
                value={runtime.model.id ?? t("assistant.contextSources.runtime.unknown")}
              />
            ) : null}
            {runtime.model ? (
              <RuntimeRow
                label={t("assistant.contextSources.runtime.recordId")}
                value={runtime.model.recordId ?? t("assistant.contextSources.runtime.unknown")}
              />
            ) : null}
            {runtime.style?.status === "loaded" ? (
              <RuntimeRow
                label={t("assistant.contextSources.runtime.noteId")}
                value={runtime.style.noteId}
              />
            ) : null}
            {runtime.style?.status === "loaded" ? (
              <RuntimeRow
                label={t("assistant.contextSources.runtime.hash")}
                value={runtime.style.sha256}
              />
            ) : null}
            {runtime.style?.status === "loaded" ? (
              <RuntimeRow
                label={t("assistant.contextSources.runtime.tokens")}
                value={`${runtime.style.tokens} / ${runtime.style.budget}`}
              />
            ) : null}
            {runtime.style?.status === "skipped" ? (
              <RuntimeRow
                label={t("assistant.contextSources.runtime.styleSkipped")}
                value={t(RUNTIME_REASON_LABELS[runtime.style.reason])}
              />
            ) : null}
            {styleNote ? (
              <RuntimeRow
                label={t("assistant.contextSources.runtime.nextStep")}
                value={styleNote}
              />
            ) : null}
            {runtime.style?.status === "skipped" &&
            runtime.style.reason === "profile_budget" &&
            runtime.style.budget !== undefined ? (
              <RuntimeRow
                label={t("assistant.contextSources.runtime.budget")}
                value={String(runtime.style.budget)}
              />
            ) : null}
            {runtime.style?.status === "skipped" &&
            runtime.style.reason === "token_budget" &&
            runtime.style.tokens !== undefined &&
            runtime.style.budget !== undefined ? (
              <RuntimeRow
                label={t("assistant.contextSources.runtime.tokens")}
                value={`${runtime.style.tokens} / ${runtime.style.budget}`}
              />
            ) : null}
          </ul>
        </section>
      ) : null}

      {runtime ? (
        <p className="agent-context-panel__scope-note">
          {t("assistant.contextSources.runtime.skillsNotice")}
        </p>
      ) : null}

      <p className="agent-context-panel__scope-note">{t("assistant.contextSources.scopeNotice")}</p>
    </div>
  );
}
