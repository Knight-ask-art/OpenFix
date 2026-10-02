import { Box, Button, Checkbox, Flex, Select, Switch, Text, TextField } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components/toast";
import {
  fetchChapters,
  fetchCharactersByProject,
  fetchWorldEntryMeta,
  updateWorldEntryMeta,
} from "@/lib/api-client";
import type { WorldEntryType } from "@/lib/world-info.types";

import "./entry-meta-panel.css";

const ENTRY_TYPES: WorldEntryType[] = [
  "location",
  "organization",
  "nation",
  "faction",
  "rule",
  "history",
  "power_system",
  "technology",
  "custom",
];

const CUSTOM_TYPE: WorldEntryType = "custom";

function parseTags(value: string): string[] {
  return value
    .split(/[,，、\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

interface EntryMetaPanelProps {
  entryId: string;
  projectId: string;
  isAgentLocked?: boolean;
}

export function EntryMetaPanel({ entryId, projectId, isAgentLocked = false }: EntryMetaPanelProps) {
  const { t } = useTranslation();
  const [entryType, setEntryType] = useState<WorldEntryType>("custom");
  const [customTypeLabel, setCustomTypeLabel] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [linkedCharacterIds, setLinkedCharacterIds] = useState<string[]>([]);
  const [linkedChapterIds, setLinkedChapterIds] = useState<string[]>([]);
  const [aiVisible, setAiVisible] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const metaQuery = useQuery({
    queryKey: ["world-entry-meta", entryId],
    queryFn: () => fetchWorldEntryMeta(entryId),
    enabled: Boolean(entryId),
  });

  const charactersQuery = useQuery({
    queryKey: ["characters", projectId],
    queryFn: () => fetchCharactersByProject(projectId),
    enabled: Boolean(projectId),
  });

  const chaptersQuery = useQuery({
    queryKey: ["chapters", projectId],
    queryFn: () => fetchChapters(projectId),
    enabled: Boolean(projectId),
  });

  const characters = charactersQuery.data?.items ?? [];
  const chapters = useMemo(
    () =>
      (chaptersQuery.data?.volumes ?? []).flatMap((volume) =>
        volume.chapters.map((chapter) => ({ id: chapter.id, label: chapter.title })),
      ),
    [chaptersQuery.data],
  );

  useEffect(() => {
    const data = metaQuery.data;
    if (!data) return;
    setEntryType(data.entryType);
    setCustomTypeLabel(data.customTypeLabel);
    setTagsInput(data.tags.join("、"));
    setLinkedCharacterIds(data.linkedCharacterIds);
    setLinkedChapterIds(data.linkedChapterIds);
    setAiVisible(data.aiVisible);
  }, [metaQuery.data]);

  const toggleId = useCallback((list: string[], id: string): string[] => {
    return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await updateWorldEntryMeta(entryId, {
        entryType,
        customTypeLabel: entryType === CUSTOM_TYPE ? customTypeLabel : "",
        tags: parseTags(tagsInput),
        linkedCharacterIds,
        linkedChapterIds,
        aiVisible,
      });
      await metaQuery.refetch();
      toast.success(t("worldInfo.metaSaved"));
    } catch {
      toast.error(t("worldInfo.metaSaveFailed"));
    } finally {
      setIsSaving(false);
    }
  }, [
    aiVisible,
    customTypeLabel,
    entryId,
    entryType,
    linkedChapterIds,
    linkedCharacterIds,
    metaQuery,
    t,
    tagsInput,
  ]);

  // 扩展信息尚未加载完成时不允许编辑或保存，避免把上一条目的值写到当前条目。
  const disabled = isAgentLocked || isSaving || !metaQuery.isSuccess;

  return (
    <div className="entry-meta-panel">
      <section className="entry-meta-section">
        <Text
          size="3"
          weight="medium"
        >
          {t("worldInfo.metaTypeSection")}
        </Text>

        <Flex
          align="center"
          gap="3"
          wrap="wrap"
        >
          <Text
            size="2"
            color="gray"
          >
            {t("worldInfo.metaType")}
          </Text>
          <Select.Root
            value={entryType}
            onValueChange={(value) => setEntryType(value as WorldEntryType)}
          >
            <Select.Trigger
              variant="soft"
              aria-label={t("worldInfo.metaType")}
            />
            <Select.Content>
              {ENTRY_TYPES.map((type) => (
                <Select.Item
                  key={type}
                  value={type}
                >
                  {t(`worldInfo.entryTypes.${type}`)}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Flex>

        {entryType === CUSTOM_TYPE ? (
          <Flex
            direction="column"
            gap="1"
          >
            <Text
              as="label"
              size="2"
              color="gray"
            >
              {t("worldInfo.metaCustomType")}
            </Text>
            <TextField.Root
              value={customTypeLabel}
              disabled={disabled}
              placeholder={t("worldInfo.metaCustomTypePlaceholder")}
              onChange={(event) => setCustomTypeLabel(event.target.value)}
            />
          </Flex>
        ) : null}

        <Flex
          direction="column"
          gap="1"
        >
          <Text
            as="label"
            size="2"
            color="gray"
          >
            {t("worldInfo.metaTags")}
          </Text>
          <TextField.Root
            value={tagsInput}
            disabled={disabled}
            placeholder={t("worldInfo.metaTagsPlaceholder")}
            onChange={(event) => setTagsInput(event.target.value)}
          />
        </Flex>

        <Flex
          align="center"
          justify="between"
          gap="3"
        >
          <Flex
            direction="column"
            gap="1"
          >
            <Text
              size="2"
              weight="medium"
            >
              {t("worldInfo.metaAiVisible")}
            </Text>
            <Text
              size="1"
              color="gray"
            >
              {t("worldInfo.metaAiVisibleHint")}
            </Text>
          </Flex>
          <Switch
            checked={aiVisible}
            disabled={disabled}
            aria-label={t("worldInfo.metaAiVisible")}
            onCheckedChange={setAiVisible}
          />
        </Flex>
      </section>

      <section className="entry-meta-section">
        <Text
          size="3"
          weight="medium"
        >
          {t("worldInfo.metaLinksSection")}
        </Text>

        <div className="entry-meta-link-columns">
          <div className="entry-meta-link-column">
            <Text
              size="2"
              color="gray"
            >
              {t("worldInfo.metaLinkedCharacters")}
            </Text>
            <Box className="entry-meta-link-list">
              {characters.length > 0 ? (
                characters.map((character) => (
                  <label
                    key={character.id}
                    className="entry-meta-link-item"
                  >
                    <Checkbox
                      checked={linkedCharacterIds.includes(character.id)}
                      disabled={disabled}
                      onCheckedChange={() =>
                        setLinkedCharacterIds((current) => toggleId(current, character.id))
                      }
                    />
                    <Text size="2">{character.name}</Text>
                  </label>
                ))
              ) : (
                <Text
                  size="2"
                  color="gray"
                >
                  {t("worldInfo.metaNoCharacters")}
                </Text>
              )}
            </Box>
          </div>

          <div className="entry-meta-link-column">
            <Text
              size="2"
              color="gray"
            >
              {t("worldInfo.metaLinkedChapters")}
            </Text>
            <Box className="entry-meta-link-list">
              {chapters.length > 0 ? (
                chapters.map((chapter) => (
                  <label
                    key={chapter.id}
                    className="entry-meta-link-item"
                  >
                    <Checkbox
                      checked={linkedChapterIds.includes(chapter.id)}
                      disabled={disabled}
                      onCheckedChange={() =>
                        setLinkedChapterIds((current) => toggleId(current, chapter.id))
                      }
                    />
                    <Text size="2">{chapter.label}</Text>
                  </label>
                ))
              ) : (
                <Text
                  size="2"
                  color="gray"
                >
                  {t("worldInfo.metaNoChapters")}
                </Text>
              )}
            </Box>
          </div>
        </div>
      </section>

      <Flex justify="end">
        <Button
          size="2"
          disabled={disabled}
          onClick={() => void handleSave()}
        >
          {isSaving ? t("writing.saving") : t("worldInfo.saveMeta")}
        </Button>
      </Flex>
    </div>
  );
}
