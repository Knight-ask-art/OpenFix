import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Character } from "@/lib/character.types";

import { CharacterAuthorPanel } from "./character-author-panel";
import { CharacterEditor } from "./character-editor";

import "./character-editor-panel.css";

type CharacterEditorView = "description" | "author";

interface CharacterEditorPanelProps {
  character: Character | null;
  projectId: string;
  isSaving?: boolean;
  isLoading?: boolean;
  isAgentLocked?: boolean;
  onSave: (data: { name: string; description: string }) => Promise<void> | void;
}

export function CharacterEditorPanel({
  character,
  projectId,
  isSaving = false,
  isLoading = false,
  isAgentLocked = false,
  onSave,
}: CharacterEditorPanelProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<CharacterEditorView>("description");

  const selectView = useCallback((next: CharacterEditorView) => setView(next), []);

  const switcher = character ? (
    <div
      className="character-editor-view-switcher"
      role="group"
      aria-label={t("characters.editorViewLabel")}
    >
      <button
        type="button"
        className="character-editor-view-switcher__button"
        data-active={view === "description"}
        aria-pressed={view === "description"}
        onClick={() => selectView("description")}
      >
        {t("characters.editorViewDescription")}
      </button>
      <button
        type="button"
        className="character-editor-view-switcher__button"
        data-active={view === "author"}
        aria-pressed={view === "author"}
        onClick={() => selectView("author")}
      >
        {t("characters.editorViewAuthor")}
      </button>
    </div>
  ) : null;

  return (
    <div className="character-editor-panel">
      {switcher}
      <div className="character-editor-panel__body">
        {view === "author" && character ? (
          <CharacterAuthorPanel
            characterId={character.id}
            projectId={projectId}
            isAgentLocked={isAgentLocked}
          />
        ) : (
          <CharacterEditor
            key={character?.id ?? "empty"}
            character={character}
            isSaving={isSaving}
            isLoading={isLoading}
            isAgentLocked={isAgentLocked}
            onSave={onSave}
          />
        )}
      </div>
    </div>
  );
}
