import { useTranslation } from "react-i18next";

import type {
  AgentContextCategory,
  AgentContextSource,
  AgentContextSourceType,
} from "../lib/agent-context-sources";

import "./agent-context-panel.css";

interface AgentContextPanelProps {
  sources: AgentContextSource[];
}

const CATEGORY_ORDER: AgentContextCategory[] = [
  "conversation",
  "chapter",
  "character",
  "worldEntry",
  "outline",
  "note",
];

const CATEGORY_LABELS: Record<AgentContextCategory, string> = {
  conversation: "assistant.contextSources.categories.conversation",
  chapter: "assistant.contextSources.categories.chapters",
  character: "assistant.contextSources.categories.characters",
  worldEntry: "assistant.contextSources.categories.worldEntries",
  outline: "assistant.contextSources.categories.outlines",
  note: "assistant.contextSources.categories.notes",
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
};

function getSourceTitle(
  source: AgentContextSource,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
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

export function AgentContextPanel({ sources }: AgentContextPanelProps) {
  const { t } = useTranslation();
  const sections = CATEGORY_ORDER.map((category) => ({
    category,
    items: sources.filter((source) => source.category === category),
  })).filter((section) => section.items.length > 0);

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

      <p className="agent-context-panel__scope-note">{t("assistant.contextSources.scopeNotice")}</p>
    </div>
  );
}
