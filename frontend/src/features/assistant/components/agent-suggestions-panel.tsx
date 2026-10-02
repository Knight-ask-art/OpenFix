import { Box, Button, Flex, Spinner, Text } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { useAppShell } from "@/features/app-shell";
import type { SettingsDialogRoute } from "@/features/settings/lib/settings-route";
import { fetchStoryMemoryStatus } from "@/features/story-memory/lib/story-memory-api";

import "./agent-suggestions-panel.css";

interface AgentSuggestionsPanelProps {
  projectId: string;
  onNavigate?: () => void;
}

interface SuggestionItem {
  id: string;
  message: string;
  actionLabel: string;
  /** 页面跳转目标（会带上当前 projectId）。 */
  href?: string;
  /** 就地打开设置弹窗的目标类目。 */
  settingsRoute?: SettingsDialogRoute;
}

export function AgentSuggestionsPanel({ projectId, onNavigate }: AgentSuggestionsPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { openSettings } = useAppShell();

  const {
    data: status,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ["story-memory-status", projectId],
    queryFn: () => fetchStoryMemoryStatus(projectId),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });

  const suggestions = useMemo<SuggestionItem[]>(() => {
    if (!status) return [];
    const items: SuggestionItem[] = [];
    const counts = status.counts;

    if (status.index_status !== "ready") {
      items.push({
        id: "story-memory-index",
        message:
          status.index_status === "not_created"
            ? t("assistant.suggestions.storyMemoryNotIndexed")
            : t("assistant.suggestions.storyMemoryStale"),
        actionLabel: t("assistant.suggestions.openStoryMemory"),
        href: "/story-memory",
      });
    }

    if (status.embedding_configured === false) {
      items.push({
        id: "embedding-model",
        message: t("assistant.suggestions.embeddingMissing"),
        actionLabel: t("assistant.suggestions.openSettings"),
        settingsRoute: { category: "index" },
      });
    }

    if (counts.chapters > 0 && counts.characters === 0) {
      items.push({
        id: "no-characters",
        message: t("assistant.suggestions.noCharacters"),
        actionLabel: t("assistant.suggestions.openCharacters"),
        href: "/characters",
      });
    }

    if (counts.chapters > 0 && counts.world_entries === 0) {
      items.push({
        id: "no-world-entries",
        message: t("assistant.suggestions.noWorldEntries"),
        actionLabel: t("assistant.suggestions.openWorld"),
        href: "/world-info",
      });
    }

    if (counts.chapters > 0 && counts.outlines === 0) {
      items.push({
        id: "no-outlines",
        message: t("assistant.suggestions.noOutlines"),
        actionLabel: t("assistant.suggestions.openOutline"),
        href: "/outline",
      });
    }

    if (counts.chapters > 0) {
      items.push({
        id: "consistency",
        message: t("assistant.suggestions.consistencyHint"),
        actionLabel: t("assistant.suggestions.openConsistency"),
        href: "/consistency",
      });
    }

    items.push({
      id: "ai-tasks",
      message: t("assistant.suggestions.aiTasksHint"),
      actionLabel: t("assistant.suggestions.openAiTasks"),
      href: "/ai",
    });

    return items;
  }, [status, t]);

  const handleNavigate = (item: SuggestionItem) => {
    if (item.settingsRoute) {
      openSettings(item.settingsRoute);
    } else if (item.href) {
      navigate(`${item.href}?projectId=${projectId}`);
    }
    onNavigate?.();
  };

  return (
    <div
      className="agent-suggestions-panel"
      role="region"
      aria-label={t("assistant.suggestions.panelLabel")}
    >
      <p className="agent-suggestions-panel__description">
        {t("assistant.suggestions.description")}
      </p>

      {isLoading ? (
        <Flex
          align="center"
          gap="2"
          className="agent-suggestions-panel__loading"
        >
          <Spinner size="2" />
          <Text
            size="2"
            color="gray"
          >
            {t("assistant.suggestions.loading")}
          </Text>
        </Flex>
      ) : isError && suggestions.length === 0 ? (
        <Flex
          direction="column"
          align="start"
          gap="2"
          className="agent-suggestions-panel__loading"
        >
          <Text
            size="2"
            color="gray"
          >
            {t("assistant.suggestions.loadFailed")}
          </Text>
          <Button
            size="1"
            variant="soft"
            loading={isFetching}
            onClick={() => void refetch()}
          >
            <RefreshCw size={13} />
            {t("assistant.suggestions.retry")}
          </Button>
        </Flex>
      ) : suggestions.length > 0 ? (
        <ul className="agent-suggestions-list">
          {suggestions.map((item) => (
            <li
              className="agent-suggestion-item"
              key={item.id}
            >
              <Text
                size="2"
                className="agent-suggestion-item__message"
              >
                {item.message}
              </Text>
              <Button
                size="1"
                variant="soft"
                onClick={() => handleNavigate(item)}
              >
                {item.actionLabel}
                <ArrowRight size={13} />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <Text
          size="2"
          color="gray"
        >
          {t("assistant.suggestions.empty")}
        </Text>
      )}

      <Box className="agent-suggestions-panel__scope-note">
        <Text
          size="1"
          color="gray"
        >
          {t("assistant.suggestions.scopeNotice")}
        </Text>
      </Box>
    </div>
  );
}
