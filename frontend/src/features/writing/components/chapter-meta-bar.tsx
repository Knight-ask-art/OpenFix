import { Flex, Select, Text, TextField } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchChapterMeta, updateChapterMeta } from "@/lib/api-client";
import type { ChapterMeta, ChapterStatus } from "@/lib/chapter.types";

import "./chapter-meta-bar.css";

const CHAPTER_STATUSES: ChapterStatus[] = ["draft", "writing", "revising", "done"];

interface ChapterMetaBarProps {
  chapterId: string;
  wordCount: number;
  isLocked?: boolean;
}

export function ChapterMetaBar({ chapterId, wordCount, isLocked = false }: ChapterMetaBarProps) {
  const { t } = useTranslation();
  const [meta, setMeta] = useState<ChapterMeta | null>(null);
  const [targetInput, setTargetInput] = useState("");

  const { data } = useQuery({
    queryKey: ["chapter-meta", chapterId],
    queryFn: () => fetchChapterMeta(chapterId),
    enabled: Boolean(chapterId),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!data) return;
    setMeta(data);
    setTargetInput(data.targetWordCount > 0 ? String(data.targetWordCount) : "");
  }, [data]);

  const handleStatusChange = useCallback(
    async (status: ChapterStatus) => {
      try {
        const updated = await updateChapterMeta(chapterId, { status });
        setMeta(updated);
      } catch {
        // 失败时保持原状态，不阻断写作。
      }
    },
    [chapterId],
  );

  const commitTarget = useCallback(async () => {
    const parsed = Number.parseInt(targetInput, 10);
    const nextTarget = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    if (meta && meta.targetWordCount === nextTarget) return;
    try {
      const updated = await updateChapterMeta(chapterId, { targetWordCount: nextTarget });
      setMeta(updated);
      setTargetInput(updated.targetWordCount > 0 ? String(updated.targetWordCount) : "");
    } catch {
      // 目标字数保存失败不阻断写作。
    }
  }, [chapterId, meta, targetInput]);

  const target = meta?.targetWordCount ?? 0;

  return (
    <Flex
      align="center"
      gap="3"
      className="chapter-meta-bar"
    >
      <Flex
        align="center"
        gap="2"
      >
        <Text
          size="1"
          color="gray"
        >
          {t("writing.chapterStatus.label")}
        </Text>
        <Select.Root
          value={meta?.status ?? "draft"}
          onValueChange={(value) => void handleStatusChange(value as ChapterStatus)}
          disabled={isLocked}
        >
          <Select.Trigger
            variant="ghost"
            className="chapter-meta-bar__status-trigger"
            aria-label={t("writing.chapterStatus.label")}
          />
          <Select.Content>
            {CHAPTER_STATUSES.map((status) => (
              <Select.Item
                key={status}
                value={status}
              >
                {t(`writing.chapterStatus.${status}`)}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </Flex>

      <Flex
        align="center"
        gap="2"
      >
        <Text
          size="1"
          color="gray"
        >
          {t("writing.chapterTarget")}
        </Text>
        <TextField.Root
          className="chapter-meta-bar__target-input"
          value={targetInput}
          disabled={isLocked}
          inputMode="numeric"
          placeholder="0"
          aria-label={t("writing.chapterTarget")}
          onChange={(event) => setTargetInput(event.target.value.replace(/[^0-9]/g, ""))}
          onBlur={() => void commitTarget()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
        />
        {target > 0 ? (
          <Text
            size="1"
            color="gray"
          >
            {t("writing.chapterTargetProgress", { current: wordCount, target })}
          </Text>
        ) : null}
      </Flex>
    </Flex>
  );
}
