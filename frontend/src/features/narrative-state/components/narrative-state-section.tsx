import { Badge, Box, Button, Flex, Spinner, Tabs, Text } from "@radix-ui/themes";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchNarrativePage, narrativeQueryKey } from "../lib/narrative-state-api";
import {
  NARRATIVE_KINDS,
  pageCount,
  type NarrativeItem,
  type NarrativeKind,
} from "../lib/narrative-state-model";
import { NarrativeCandidateForm } from "./narrative-candidate-form";
import { NarrativeItemRow, type NarrativeConflict } from "./narrative-item-row";

import "./narrative-state.css";

interface NarrativeStateSectionProps {
  projectId: string | null;
}

interface NarrativeResourceListProps {
  kind: NarrativeKind;
  projectId: string;
  conflicts: Record<string, NarrativeConflict>;
  onConflict: (item: NarrativeItem) => void;
  onConflictCleared: (item: NarrativeItem) => void;
}

function conflictKey(item: NarrativeItem): string {
  return `${item.kind}:${item.id}`;
}

function NarrativeResourceList({
  kind,
  projectId,
  conflicts,
  onConflict,
  onConflictCleared,
}: NarrativeResourceListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);

  // 切换项目后必须回到第一页，避免把上一个项目的偏移量带到新项目。
  useEffect(() => {
    setPage(1);
  }, [projectId]);

  const query = useQuery({
    queryKey: narrativeQueryKey(kind, projectId, page),
    queryFn: ({ signal }) => fetchNarrativePage(kind, projectId, page, signal),
    staleTime: 10_000,
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const lastPage = pageCount(total);

  // 数据变少（例如确认后过滤掉已确认项）时把页码收回到最后一页。
  useEffect(() => {
    if (query.data && page > lastPage) setPage(lastPage);
  }, [page, lastPage, query.data]);

  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: narrativeQueryKey(kind, projectId) });
  }, [kind, projectId, queryClient]);

  return (
    <Box className="narrative-state__resource">
      <Flex
        align="center"
        justify="between"
        gap="3"
        wrap="wrap"
      >
        <Text
          size="1"
          color="gray"
        >
          {t("narrativeState.recordCount", { count: total })}
        </Text>
        <Flex
          align="center"
          gap="2"
          wrap="wrap"
        >
          {kind === "worldFacts" || kind === "plotlines" ? (
            <NarrativeCandidateForm
              kind={kind}
              projectId={projectId}
              onCreated={handleRefresh}
            />
          ) : (
            <Text
              size="1"
              color="gray"
            >
              {t("narrativeState.readOnlyNotice")}
            </Text>
          )}
          <Button
            size="1"
            variant="ghost"
            color="gray"
            loading={query.isFetching}
            onClick={handleRefresh}
          >
            <RefreshCw size={13} />
            {t("narrativeState.refresh")}
          </Button>
        </Flex>
      </Flex>

      {query.isPending ? (
        <Flex
          align="center"
          gap="2"
          className="narrative-state__status"
        >
          <Spinner size="1" />
          <Text
            size="1"
            color="gray"
          >
            {t("narrativeState.loading")}
          </Text>
        </Flex>
      ) : query.isError ? (
        <Box className="narrative-state__status narrative-state__error">
          <Text
            size="1"
            color="red"
            as="p"
          >
            {t("narrativeState.loadFailed")}
          </Text>
          <Button
            size="1"
            variant="soft"
            color="gray"
            onClick={() => void query.refetch()}
          >
            {t("narrativeState.retry")}
          </Button>
        </Box>
      ) : items.length === 0 ? (
        <Box className="narrative-state__status">
          <Text
            size="1"
            color="gray"
            as="p"
          >
            {t(`narrativeState.empty.${kind}`)}
          </Text>
        </Box>
      ) : (
        <Box className="narrative-state__rows">
          {items.map((item) => (
            <NarrativeItemRow
              key={item.id}
              item={item}
              projectId={projectId}
              conflict={conflicts[conflictKey(item)] ?? null}
              onConflict={onConflict}
              onConflictCleared={onConflictCleared}
            />
          ))}
        </Box>
      )}

      {lastPage > 1 ? (
        <Flex
          align="center"
          justify="between"
          gap="2"
          className="narrative-state__pagination"
        >
          <Text
            size="1"
            color="gray"
          >
            {t("narrativeState.pageStatus", { page, total: lastPage })}
          </Text>
          <Flex gap="2">
            <Button
              size="1"
              variant="soft"
              color="gray"
              aria-label={t("narrativeState.prevPage")}
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft size={13} />
            </Button>
            <Button
              size="1"
              variant="soft"
              color="gray"
              aria-label={t("narrativeState.nextPage")}
              disabled={page >= lastPage}
              onClick={() => setPage((current) => Math.min(lastPage, current + 1))}
            >
              <ChevronRight size={13} />
            </Button>
          </Flex>
        </Flex>
      ) : null}
    </Box>
  );
}

/**
 * 叙事状态的用户确认入口。
 *
 * 只做读取、确认与手工录入候选：不触发任何自动提取，也不存在静默写入路径。
 */
export function NarrativeStateSection({ projectId }: NarrativeStateSectionProps) {
  const { t } = useTranslation();
  const [activeKind, setActiveKind] = useState<NarrativeKind>("worldFacts");
  const [conflicts, setConflicts] = useState<Record<string, NarrativeConflict>>({});

  const handleConflict = useCallback((item: NarrativeItem) => {
    setConflicts((previous) => ({
      ...previous,
      [conflictKey(item)]: { previous: item },
    }));
  }, []);

  const handleConflictCleared = useCallback((item: NarrativeItem) => {
    setConflicts((previous) => {
      const key = conflictKey(item);
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }, []);

  // 项目切换后旧的冲突快照不再对应当前数据，直接丢弃。
  useEffect(() => {
    setConflicts({});
  }, [projectId]);

  return (
    <section
      className="narrative-state"
      aria-labelledby="narrative-state-heading"
    >
      <Flex
        align="center"
        gap="2"
        wrap="wrap"
      >
        <Text
          id="narrative-state-heading"
          as="div"
          role="heading"
          aria-level={2}
          size="2"
          weight="medium"
        >
          {t("narrativeState.title")}
        </Text>
        <Badge
          variant="soft"
          color="gray"
        >
          {t("narrativeState.badge")}
        </Badge>
      </Flex>
      <Text
        size="1"
        color="gray"
        as="p"
        className="narrative-state__description"
      >
        {t("narrativeState.description")}
      </Text>
      <Text
        size="1"
        color="gray"
        as="p"
        className="narrative-state__description"
      >
        {t("narrativeState.disclaimer")}
      </Text>

      {projectId ? (
        <Tabs.Root
          value={activeKind}
          onValueChange={(value) => setActiveKind(value as NarrativeKind)}
        >
          <Tabs.List>
            {NARRATIVE_KINDS.map((kind) => (
              <Tabs.Trigger
                key={kind}
                value={kind}
              >
                {t(`narrativeState.tabs.${kind}`)}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <Box pt="3">
            {NARRATIVE_KINDS.map((kind) => (
              <Tabs.Content
                key={kind}
                value={kind}
              >
                {kind === activeKind ? (
                  <NarrativeResourceList
                    kind={kind}
                    projectId={projectId}
                    conflicts={conflicts}
                    onConflict={handleConflict}
                    onConflictCleared={handleConflictCleared}
                  />
                ) : null}
              </Tabs.Content>
            ))}
          </Box>
        </Tabs.Root>
      ) : (
        <Box className="narrative-state__status">
          <Text
            size="1"
            color="gray"
          >
            {t("narrativeState.noProject")}
          </Text>
        </Box>
      )}
    </section>
  );
}
