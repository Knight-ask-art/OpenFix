import { Box, Button, Flex, Select, TextArea, Text, TextField } from "@radix-ui/themes";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { VolumeWithChapters } from "@/lib/chapter.types";

import {
  type OutlineLevel,
  type OutlineNode,
  type OutlineUpdatePayload,
} from "../lib/outline-api";

import "./outline-editor.css";

interface OutlineEditorProps {
  node: OutlineNode;
  isSaving: boolean;
  labels: {
    title: string;
    content: string;
    contentHint: string;
    level: string;
    levelHint: string;
    associations: string;
    volume: string;
    chapter: string;
    notLinked: string;
    volumeOption: (order: number, title: string) => string;
    chapterOption: (
      volumeOrder: number,
      volumeTitle: string,
      chapterOrder: number,
      chapterTitle: string,
    ) => string;
    save: string;
    saveShortcut: string;
    untitled: string;
  };
  levelLabels: Record<OutlineLevel, string>;
  allowedLevels: OutlineLevel[];
  volumes: VolumeWithChapters[];
  onDirtyChange: (dirty: boolean) => void;
  onSave: (payload: OutlineUpdatePayload) => void;
}

export function OutlineEditor({
  node,
  isSaving,
  labels,
  levelLabels,
  allowedLevels,
  volumes,
  onDirtyChange,
  onSave,
}: OutlineEditorProps) {
  const [title, setTitle] = useState(node.title);
  const [content, setContent] = useState(node.content);
  const [level, setLevel] = useState<OutlineLevel>(node.level);
  const [volumeId, setVolumeId] = useState<string | null>(node.volume_id);
  const [chapterId, setChapterId] = useState<string | null>(node.chapter_id);
  const contentRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setTitle(node.title);
    setContent(node.content);
    setLevel(node.level);
    setVolumeId(node.volume_id);
    setChapterId(node.chapter_id);
  }, [node.id, node.title, node.content, node.level, node.volume_id, node.chapter_id]);

  const isDirty = useMemo(
    () =>
      title !== node.title ||
      content !== node.content ||
      level !== node.level ||
      volumeId !== node.volume_id ||
      chapterId !== node.chapter_id,
    [title, content, level, volumeId, chapterId, node],
  );

  const chapterChoices = useMemo(
    () =>
      volumes.flatMap((volume) =>
        volume.chapters
          .filter((chapter) => !volumeId || chapter.volumeId === volumeId)
          .map((chapter) => ({
            id: chapter.id,
            volumeId: volume.id,
            label: labels.chapterOption(
              volume.order,
              volume.title,
              chapter.order,
              chapter.title || labels.untitled,
            ),
          })),
      ),
    [labels, volumeId, volumes],
  );
  const selectableLevels = allowedLevels.length > 0 ? allowedLevels : [node.level];

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const handleSave = () => {
    if (!isDirty || isSaving) return;
    onSave({
      title: title.trim(),
      content,
      level,
      volume_id: volumeId,
      chapter_id: chapterId,
    });
  };

  const handleShortcut = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      handleSave();
    }
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    handleShortcut(event);
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      contentRef.current?.focus();
    }
  };

  return (
    <Box className="outline-editor">
      <Flex
        direction="column"
        gap="3"
      >
        <Flex
          gap="3"
          wrap="wrap"
        >
          <Box style={{ flex: 1, minWidth: 200 }}>
            <Text
              size="1"
              color="gray"
              as="label"
              htmlFor={`outline-title-${node.id}`}
            >
              {labels.title}
            </Text>
            <TextField.Root
              id={`outline-title-${node.id}`}
              value={title}
              disabled={isSaving}
              aria-label={labels.title}
              placeholder={labels.untitled}
                autoFocus={!node.title.trim()}
              onChange={(event) => setTitle(event.target.value)}
                onKeyDown={handleTitleKeyDown}
            />
          </Box>
          <Box>
            <Text
              size="1"
              color="gray"
            >
              {labels.level}
            </Text>
            <Select.Root
              value={level}
              disabled={isSaving || selectableLevels.length <= 1}
              onValueChange={(value) => setLevel(value as OutlineLevel)}
            >
              <Select.Trigger variant="soft" aria-label={labels.level} />
              <Select.Content>
                {selectableLevels.map((item) => (
                  <Select.Item
                    key={item}
                    value={item}
                  >
                    {levelLabels[item]}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            {selectableLevels.length <= 1 ? (
              <Text size="1" color="gray" className="outline-editor__level-hint">
                {labels.levelHint}
              </Text>
            ) : null}
          </Box>
        </Flex>

        <Box>
          <Text
            size="1"
            color="gray"
            as="label"
            htmlFor={`outline-content-${node.id}`}
          >
            {labels.content}
          </Text>
          <Text size="1" color="gray" as="p" className="outline-editor__content-hint">
            {labels.contentHint}
          </Text>
          <TextArea
            ref={contentRef}
            id={`outline-content-${node.id}`}
            value={content}
            disabled={isSaving}
            aria-label={labels.content}
            rows={12}
            resize="vertical"
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={handleShortcut}
          />
        </Box>

        <Box className="outline-editor__associations">
          <Text size="1" color="gray">
            {labels.associations}
          </Text>
          <Flex gap="3" wrap="wrap" mt="1">
            <Box className="outline-editor__association-field">
              <Text size="1" color="gray">
                {labels.volume}
              </Text>
              <Select.Root
                value={volumeId ?? "__openfix_unlinked__"}
                disabled={isSaving}
                onValueChange={(value) => {
                  const nextVolumeId = value === "__openfix_unlinked__" ? null : value;
                  setVolumeId(nextVolumeId);
                  setChapterId((current) =>
                    current && volumes.some(
                      (volume) =>
                        volume.id === nextVolumeId &&
                        volume.chapters.some((chapter) => chapter.id === current),
                    )
                      ? current
                      : null,
                  );
                }}
              >
                <Select.Trigger
                  variant="soft"
                  aria-label={labels.volume}
                />
                <Select.Content>
                  <Select.Item value="__openfix_unlinked__">{labels.notLinked}</Select.Item>
                  {volumes.map((volume) => (
                    <Select.Item key={volume.id} value={volume.id}>
                      {labels.volumeOption(volume.order, volume.title || labels.untitled)}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Box>
            <Box className="outline-editor__association-field">
              <Text size="1" color="gray">
                {labels.chapter}
              </Text>
              <Select.Root
                value={chapterId ?? "__openfix_unlinked__"}
                disabled={isSaving}
                onValueChange={(value) => {
                  if (value === "__openfix_unlinked__") {
                    setChapterId(null);
                    return;
                  }
                  const chapter = chapterChoices.find((item) => item.id === value);
                  if (!chapter) return;
                  setChapterId(chapter.id);
                  setVolumeId(chapter.volumeId);
                }}
              >
                <Select.Trigger
                  variant="soft"
                  aria-label={labels.chapter}
                />
                <Select.Content>
                  <Select.Item value="__openfix_unlinked__">{labels.notLinked}</Select.Item>
                  {chapterChoices.map((chapter) => (
                    <Select.Item key={chapter.id} value={chapter.id}>
                      {chapter.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Box>
          </Flex>
        </Box>

        <Flex
          className="outline-editor__footer"
          justify="end"
          align="center"
          gap="3"
        >
          <Flex align="center" gap="3">
            <Text size="1" color="gray" className="outline-editor__shortcut-hint">
              {labels.saveShortcut}
            </Text>
            <Button
              size="2"
              disabled={!isDirty || isSaving}
              loading={isSaving}
              onClick={handleSave}
            >
              {labels.save}
            </Button>
          </Flex>
        </Flex>
      </Flex>
    </Box>
  );
}
