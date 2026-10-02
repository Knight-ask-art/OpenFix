import { Badge, Box, Button, Flex, Select, Spinner, Text, TextArea } from "@radix-ui/themes";
import {
  Activity,
  AlertCircle,
  Check,
  FileText,
  ListTree,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ChapterListItem } from "@/lib/chapter.types";

import {
  checkOutlinePacing,
  improveOutline,
  splitOutlineIntoChapters,
  updateOutlineFromChapter,
  type OutlineAiDraftSuggestion,
  type OutlineAiPacingSuggestion,
  type OutlineAiSplitItem,
  type OutlineAiSplitSuggestion,
} from "../lib/outline-ai-api";
import type { OutlineNode } from "../lib/outline-api";

import "./outline-ai-actions.css";

type OutlineAiAction = "improve" | "pacing" | "split" | "fromChapter";

type OutlineAiResult =
  | { kind: "draft"; data: OutlineAiDraftSuggestion }
  | { kind: "pacing"; data: OutlineAiPacingSuggestion }
  | { kind: "split"; data: OutlineAiSplitSuggestion };

interface OutlineAiActionsProps {
  projectId: string;
  node: OutlineNode;
  chapters: ChapterListItem[];
  isApplying: boolean;
  hasUnsavedChanges: boolean;
  onApplyDraft: (draft: { title: string; content: string }) => Promise<void>;
  onApplySplit: (items: OutlineAiSplitItem[]) => Promise<void>;
}

const SEVERITY_COLORS: Record<string, "gray" | "orange" | "red"> = {
  info: "gray",
  warning: "orange",
  high: "red",
};

function readErrorDetail(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const response = (error as { response?: { data?: { detail?: unknown } } }).response;
    if (typeof response?.data?.detail === "string") return response.data.detail;
  }
  return "";
}

function readCompletedSplitCount(error: unknown): number {
  if (typeof error !== "object" || error === null || !("completedCount" in error)) {
    return 0;
  }
  const count = (error as { completedCount?: unknown }).completedCount;
  return typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 0;
}

/**
 * 大纲 AI 动作条（PRD §14）。
 *
 * 四个动作都只请求候选内容，结果先在面板中展示；
 * 只有用户点击「采纳」/「创建为子节点」后，才通过回调写入大纲。
 */
export function OutlineAiActions({
  projectId,
  node,
  chapters,
  isApplying,
  hasUnsavedChanges,
  onApplyDraft,
  onApplySplit,
}: OutlineAiActionsProps) {
  const { t } = useTranslation();
  const [action, setAction] = useState<OutlineAiAction | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OutlineAiResult | null>(null);
  const [chapterId, setChapterId] = useState<string>(node.chapter_id ?? "");

  // 切换大纲节点时清空上一次的候选结果，避免误采纳到别的节点。
  useEffect(() => {
    setAction(null);
    setResult(null);
    setError(null);
    setChapterId(node.chapter_id ?? "");
  }, [node.id, node.chapter_id]);

  const chapterOptions = useMemo(
    () => chapters.map((chapter) => ({
      id: chapter.id,
      label: t("outline.ai.chapterOption", {
        order: chapter.order,
        title: chapter.title || t("outline.untitled"),
      }),
    })),
    [chapters, t],
  );

  const run = async (next: OutlineAiAction) => {
    if (isLoading || isApplying || hasUnsavedChanges) return;
    setAction(next);
    setError(null);
    setResult(null);

    const fallbackChapterId = node.chapter_id || chapterId;
    if (next === "fromChapter") {
      if (!fallbackChapterId) {
        if (chapterOptions.length === 0) setError(t("outline.ai.noChapters"));
        return;
      }
    }

    setIsLoading(true);
    try {
      if (next === "improve") {
        setResult({ kind: "draft", data: await improveOutline(projectId, node.id) });
      } else if (next === "pacing") {
        setResult({ kind: "pacing", data: await checkOutlinePacing(projectId, node.id) });
      } else if (next === "split") {
        setResult({ kind: "split", data: await splitOutlineIntoChapters(projectId, node.id) });
      } else {
        setResult({
          kind: "draft",
          data: await updateOutlineFromChapter(projectId, node.id, fallbackChapterId),
        });
      }
    } catch (caught) {
      const detail = readErrorDetail(caught);
      setError(detail || t("outline.ai.failed"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleApplyDraft = async () => {
    if (!result || result.kind !== "draft") return;
    if (hasUnsavedChanges || isApplying) return;
    setError(null);
    try {
      await onApplyDraft({ title: result.data.title, content: result.data.content });
      setResult(null);
      setAction(null);
    } catch (caught) {
      setError(readErrorDetail(caught) || t("outline.ai.applyFailed"));
    }
  };

  const handleApplySplit = async () => {
    if (!result || result.kind !== "split") return;
    if (hasUnsavedChanges || isApplying) return;
    setError(null);
    try {
      await onApplySplit(result.data.items);
      setResult(null);
      setAction(null);
    } catch (caught) {
      const completedCount = Math.min(
        result.data.items.length,
        readCompletedSplitCount(caught),
      );
      if (completedCount > 0) {
        setResult((current) =>
          current?.kind === "split"
            ? {
                ...current,
                data: {
                  ...current.data,
                  items: current.data.items.slice(completedCount),
                },
              }
            : current,
        );
      }
      setError(
        completedCount > 0
          ? t("outline.ai.applySplitPartial", { count: completedCount })
          : readErrorDetail(caught) || t("outline.ai.applySplitFailed"),
      );
    }
  };

  const handleDismiss = () => {
    setResult(null);
    setAction(null);
    setError(null);
  };

  const needsChapterPicker = action === "fromChapter" && !node.chapter_id;

  return (
    <Box className="outline-ai">
      {hasUnsavedChanges ? (
        <Text size="1" color="orange" role="status">
          {t("outline.ai.saveBeforeUsing")}
        </Text>
      ) : null}
      {node.level !== "volume" ? (
        <Text size="1" color="gray" role="status">
          {t("outline.ai.splitRequiresVolume")}
        </Text>
      ) : null}
      <Flex
        align="center"
        gap="2"
        wrap="wrap"
      >
        <Button
          size="2"
          variant="soft"
          disabled={isLoading || isApplying || hasUnsavedChanges}
          onClick={() => void run("improve")}
        >
          <Sparkles size={14} />
          {t("outline.ai.improve")}
        </Button>
        <Button
          size="2"
          variant="soft"
          disabled={isLoading || isApplying || hasUnsavedChanges}
          onClick={() => void run("pacing")}
        >
          <Activity size={14} />
          {t("outline.ai.checkPacing")}
        </Button>
        <Button
          size="2"
          variant="soft"
          disabled={isLoading || isApplying || hasUnsavedChanges || node.level !== "volume"}
          onClick={() => void run("split")}
        >
          <ListTree size={14} />
          {t("outline.ai.splitChapters")}
        </Button>
        <Button
          size="2"
          variant="soft"
          disabled={isLoading || isApplying || hasUnsavedChanges}
          onClick={() => void run("fromChapter")}
        >
          <FileText size={14} />
          {t("outline.ai.updateFromChapter")}
        </Button>
        {isLoading ? <Spinner size="1" /> : null}
      </Flex>

      {needsChapterPicker ? (
        <Box className="outline-ai__picker">
          <Text
            size="1"
            color="gray"
          >
            {t("outline.ai.pickChapter")}
          </Text>
          {chapterOptions.length === 0 ? (
            <Text
              size="1"
              color="gray"
            >
              {t("outline.ai.noChapters")}
            </Text>
          ) : (
            <Select.Root
              value={chapterId}
              onValueChange={setChapterId}
            >
              <Select.Trigger
                variant="soft"
                aria-label={t("outline.ai.pickChapter")}
              />
              <Select.Content>
                {chapterOptions.map((option) => (
                  <Select.Item
                    key={option.id}
                    value={option.id}
                  >
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          )}
        </Box>
      ) : null}

      {error ? (
        <Flex
          gap="2"
          align="start"
          className="outline-ai__error"
        >
          <AlertCircle
            size={15}
            aria-hidden="true"
          />
          <Text size="2">{error}</Text>
        </Flex>
      ) : null}

      {result ? (
        <Box className="outline-ai__result">
          {result.kind === "draft" ? (
            <Flex
              direction="column"
              gap="2"
            >
              <Text
                size="2"
                weight="medium"
              >
                {t("outline.ai.candidateTitle")}
              </Text>
              <Text size="2">{result.data.title || t("outline.untitled")}</Text>
              <Text
                size="2"
                weight="medium"
              >
                {t("outline.ai.candidateContent")}
              </Text>
              <TextArea
                value={result.data.content}
                rows={8}
                readOnly
                className="outline-ai__readonly"
              />
              {result.data.notes ? (
                <Text
                  size="1"
                  color="gray"
                >
                  {t("outline.ai.notes", { notes: result.data.notes })}
                </Text>
              ) : null}
            </Flex>
          ) : null}

          {result.kind === "pacing" ? (
            <Flex
              direction="column"
              gap="2"
            >
              <Text
                size="2"
                weight="medium"
              >
                {t("outline.ai.pacingResult")}
              </Text>
              <Text size="2">{result.data.summary}</Text>
              {result.data.issues.length === 0 ? (
                <Text
                  size="1"
                  color="gray"
                >
                  {t("outline.ai.pacingNoIssues")}
                </Text>
              ) : (
                <Flex
                  direction="column"
                  gap="2"
                >
                  {result.data.issues.map((issue, index) => (
                    <Box
                      key={`${issue.message}-${index}`}
                      className="outline-ai__issue"
                    >
                      <Flex
                        align="center"
                        gap="2"
                      >
                        <Badge color={SEVERITY_COLORS[issue.severity] ?? "orange"}>
                          {t(`outline.ai.severity.${issue.severity}`)}
                        </Badge>
                        <Text size="2">{issue.message}</Text>
                      </Flex>
                      {issue.evidence.length > 0 ? (
                        <ul className="outline-ai__evidence">
                          {issue.evidence.map((item, evidenceIndex) => (
                            <li key={`${item}-${evidenceIndex}`}>
                              <Text
                                size="1"
                                color="gray"
                              >
                                {item}
                              </Text>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {issue.suggestion ? (
                        <Text
                          size="1"
                          color="gray"
                        >
                          {issue.suggestion}
                        </Text>
                      ) : null}
                    </Box>
                  ))}
                </Flex>
              )}
              <Text
                size="1"
                color="gray"
              >
                {t("outline.ai.pacingDisclaimer")}
              </Text>
            </Flex>
          ) : null}

          {result.kind === "split" ? (
            <Flex
              direction="column"
              gap="2"
            >
              <Text
                size="2"
                weight="medium"
              >
                {t("outline.ai.splitResult", { count: result.data.items.length })}
              </Text>
              <ol className="outline-ai__split-list">
                {result.data.items.map((item, index) => (
                  <li key={`${item.title}-${index}`}>
                    <Text size="2">{item.title || t("outline.untitled")}</Text>
                    {item.content ? (
                      <Text
                        size="1"
                        color="gray"
                        as="p"
                      >
                        {item.content}
                      </Text>
                    ) : null}
                  </li>
                ))}
              </ol>
            </Flex>
          ) : null}

          <Flex
            gap="2"
            mt="3"
            wrap="wrap"
          >
            {result.kind === "draft" ? (
              <Button
                size="2"
                loading={isApplying}
                disabled={isApplying || hasUnsavedChanges}
                onClick={() => void handleApplyDraft()}
              >
                <Check size={14} />
                {t("outline.ai.apply")}
              </Button>
            ) : null}
            {result.kind === "split" ? (
              <Button
                size="2"
                loading={isApplying}
                disabled={isApplying || hasUnsavedChanges}
                onClick={() => void handleApplySplit()}
              >
                <Check size={14} />
                {t("outline.ai.applySplit")}
              </Button>
            ) : null}
            <Button
              size="2"
              variant="soft"
              color="gray"
              disabled={isLoading}
              onClick={() => void run(action ?? "improve")}
            >
              <RefreshCw size={14} />
              {t("outline.ai.regenerate")}
            </Button>
            <Button
              size="2"
              variant="ghost"
              color="gray"
              disabled={isApplying}
              onClick={handleDismiss}
            >
              <X size={14} />
              {t("outline.ai.dismiss")}
            </Button>
          </Flex>
        </Box>
      ) : null}
    </Box>
  );
}
