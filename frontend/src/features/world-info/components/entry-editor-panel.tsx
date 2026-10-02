import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import type { WorldInfoEntry, WorldInfoEntryBrief } from "@/lib/world-info.types";

import { EntryEditor } from "./entry-editor";
import { EntryMetaPanel } from "./entry-meta-panel";

import "./entry-editor-panel.css";

type EntryEditorView = "content" | "meta";

interface EntryEditorPanelProps {
  entry: WorldInfoEntry;
  worldInfoId: string;
  projectId: string;
  entries: WorldInfoEntryBrief[];
  scrollToLine?: number | null;
  onScrollComplete?: () => void;
  isAgentLocked?: boolean;
}

export function EntryEditorPanel({
  entry,
  worldInfoId,
  projectId,
  entries,
  scrollToLine,
  onScrollComplete,
  isAgentLocked = false,
}: EntryEditorPanelProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<EntryEditorView>("content");
  const selectView = useCallback((next: EntryEditorView) => setView(next), []);

  return (
    <div className="entry-editor-panel">
      <div
        className="entry-editor-view-switcher"
        role="group"
        aria-label={t("worldInfo.editorViewLabel")}
      >
        <button
          type="button"
          className="entry-editor-view-switcher__button"
          data-active={view === "content"}
          aria-pressed={view === "content"}
          onClick={() => selectView("content")}
        >
          {t("worldInfo.editorViewContent")}
        </button>
        <button
          type="button"
          className="entry-editor-view-switcher__button"
          data-active={view === "meta"}
          aria-pressed={view === "meta"}
          onClick={() => selectView("meta")}
        >
          {t("worldInfo.editorViewMeta")}
        </button>
      </div>

      <div className="entry-editor-panel__body">
        {view === "meta" ? (
          <EntryMetaPanel
            key={entry.id}
            entryId={entry.id}
            projectId={projectId}
            isAgentLocked={isAgentLocked}
          />
        ) : (
          <EntryEditor
            key={entry.id}
            entry={entry}
            worldInfoId={worldInfoId}
            entries={entries}
            scrollToLine={scrollToLine}
            onScrollComplete={onScrollComplete}
            isAgentLocked={isAgentLocked}
          />
        )}
      </div>
    </div>
  );
}
