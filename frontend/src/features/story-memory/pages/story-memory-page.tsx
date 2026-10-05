import { Box, Badge, Button, Flex, Select, Spinner, Text } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpenText,
  Brain,
  FileText,
  Globe,
  Layers,
  RefreshCw,
  Settings2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";

import { toast } from "@/components";
import { MobileAppSidebarTrigger, useAppShell } from "@/features/app-shell";
import { useProjectSelection } from "@/features/projects/hooks/use-project-selection";
import { useMobileSidebarSwipe } from "@/hooks/use-mobile-sidebar-swipe";
import { getRecentProjects } from "@/lib/local-db";

import {
  fetchStoryMemoryStatus,
  rebuildStoryMemory,
  type StoryMemoryStatus,
} from "../lib/story-memory-api";

import "./story-memory-page.css";

const STORY_MEMORY_PROJECT_STORAGE_KEY = "openfix.storyMemory.projectId";

function readStoredProject(): string | null {
  try {
    return localStorage.getItem(STORY_MEMORY_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeProject(projectId: string): void {
  try {
    localStorage.setItem(STORY_MEMORY_PROJECT_STORAGE_KEY, projectId);
  } catch {
    // Only affects convenience of remembering the last project.
  }
}

interface SourceCardProps {
  icon: LucideIcon;
  label: string;
  count: number;
}

function SourceCard({ icon: Icon, label, count }: SourceCardProps) {
  return (
    <Box className="story-memory-card">
      <Flex
        align="center"
        gap="2"
      >
        <Icon
          size={14}
          color="var(--gray-11)"
          aria-hidden="true"
        />
        <Text
          size="2"
          color="gray"
        >
          {label}
        </Text>
      </Flex>
      <Text
        size="5"
        weight="medium"
      >
        {count}
      </Text>
    </Box>
  );
}

function statusBadge(status: StoryMemoryStatus, t: (key: string) => string) {
  const map: Record<string, { color: "gray" | "green" | "orange" | "red"; label: string }> = {
    not_created: { color: "gray", label: t("storyMemory.status.notCreated") },
    registered: { color: "orange", label: t("storyMemory.status.waiting") },
    building: { color: "orange", label: t("storyMemory.status.building") },
    ready: { color: "green", label: t("storyMemory.status.ready") },
    stale: { color: "orange", label: t("storyMemory.status.stale") },
    failed: { color: "red", label: t("storyMemory.status.failed") },
    needs_rebuild: { color: "orange", label: t("storyMemory.status.needsRebuild") },
  };
  const entry = map[status.index_status] ?? { color: "gray" as const, label: status.index_status };
  return (
    <Badge color={entry.color}>
      {entry.label}
    </Badge>
  );
}

export function StoryMemoryPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { closeSidebar, isMobile, isSidebarOpen, openSidebar, openSettings } = useAppShell();
  const queryClient = useQueryClient();
  const mobileSidebarSwipeHandlers = useMobileSidebarSwipe({
    isEnabled: isMobile,
    isOpen: isSidebarOpen,
    onOpen: openSidebar,
    onClose: closeSidebar,
  });

  const [projectId, setProjectId] = useState<string | null>(null);
  // 立即读取的当前项目：URL 校验与偏好回退的异步续跑必须与它比较，不能依赖渲染快照。
  const projectIdRef = useRef<string | null>(null);

  // 只有真正切换项目才更新状态并写入既有本地偏好 key，
  // 使列表外项目在页面重挂载后仍能经接口校验恢复。
  const setCurrentProject = useCallback((nextProjectId: string | null) => {
    if (projectIdRef.current === nextProjectId) return;
    projectIdRef.current = nextProjectId;
    setProjectId(nextProjectId);
    if (nextProjectId) storeProject(nextProjectId);
  }, []);

  const getCurrentProjectId = useCallback(() => projectIdRef.current, []);

  const { data: recentProjects = [], isPending: isRecentProjectsPending } = useQuery({
    queryKey: ["recent-projects"],
    queryFn: getRecentProjects,
    staleTime: Infinity,
  });

  const readProjectCandidates = useCallback(
    () =>
      Promise.resolve([
        readStoredProject(),
        ...recentProjects.map((recentProject) => recentProject.projectId),
      ]),
    [recentProjects],
  );

  // 当前项目初始化（第一页列表 + URL 深层链接 + 本地偏好/最近项目回退）统一由共享 hook 负责，
  // 页面不再自行解析 URL 或从原始参数初始化，避免未校验 id 直接驱动故事记忆请求。
  const { projects, isLoadingProjects, selectProjectManually } = useProjectSelection({
    urlProjectId: searchParams.get("projectId"),
    getCurrentProjectId,
    setCurrentProject,
    isPreferenceReady: !isRecentProjectsPending,
    getPreferenceCandidates: readProjectCandidates,
  });

  const { data: status, isLoading: isLoadingStatus } = useQuery({
    queryKey: ["story-memory-status", projectId],
    queryFn: () => fetchStoryMemoryStatus(projectId ?? ""),
    enabled: Boolean(projectId),
    refetchInterval: (query) =>
      query.state.data?.rebuild_job_status || query.state.data?.index_status === "building"
        ? 2000
        : false,
  });

  const rebuildMutation = useMutation({
    mutationFn: () => rebuildStoryMemory(projectId ?? ""),
    onSuccess: () => {
      toast.success(t("storyMemory.rebuildEnqueued"));
      void queryClient.invalidateQueries({ queryKey: ["story-memory-status", projectId] });
    },
    onError: (error: unknown) => {
      const detail =
        error && typeof error === "object" && "response" in error
          ? (
              (error as { response?: { data?: { detail?: unknown } } }).response?.data?.detail
            )
          : null;
      toast.error(
        typeof detail === "string" ? detail : t("storyMemory.rebuildFailed"),
      );
    },
  });

  // 下拉框手动选择交给共享 hook：推进手动选择版本号，
  // 同时由 setCurrentProject 负责本地偏好写入。
  const handleProjectChange = (value: string) => {
    selectProjectManually(value);
  };

  const isRebuilding = Boolean(status?.rebuild_job_status) || status?.index_status === "building";

  return (
    <Box
      {...mobileSidebarSwipeHandlers}
      className="story-memory-page mobile-sidebar-swipe-surface"
    >
      <Box className="story-memory-page__header">
        <Flex
          align="center"
          gap="3"
          wrap="wrap"
        >
          <MobileAppSidebarTrigger />
          <Text
            size="5"
            weight="medium"
          >
            {t("storyMemory.title")}
          </Text>
          <Box className="story-memory-page__project-select">
            {isLoadingProjects ? (
              <Spinner size="2" />
            ) : (
              <Select.Root
                value={projectId ?? ""}
                onValueChange={handleProjectChange}
              >
                <Select.Trigger variant="soft" />
                <Select.Content>
                  {projects.map((project) => (
                    <Select.Item
                      key={project.id}
                      value={project.id}
                    >
                      {project.title}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            )}
          </Box>
        </Flex>
      </Box>

      <Box className="story-memory-page__body">
        {!status ? (
          <Flex
            className="story-memory-page__empty"
            align="center"
            justify="center"
          >
            {isLoadingStatus ? (
              <Spinner size="2" />
            ) : (
              <Text color="gray">{t("storyMemory.noProject")}</Text>
            )}
          </Flex>
        ) : (
          <>
            <Text
              size="2"
              color="gray"
            >
              {t("storyMemory.description")}
            </Text>
            {status.index_status === "failed" && status.last_error ? (
              <Box className="story-memory-page__notice">
                <Text
                  size="2"
                  color="red"
                >
                  {status.last_error}
                </Text>
              </Box>
            ) : null}
            <Box className="story-memory-page__sources">
              <SourceCard
                icon={BookOpenText}
                label={t("storyMemory.sources.chapters")}
                count={status.counts.chapters}
              />
              <SourceCard
                icon={UserRound}
                label={t("storyMemory.sources.characters")}
                count={status.counts.characters}
              />
              <SourceCard
                icon={Globe}
                label={t("storyMemory.sources.worldEntries")}
                count={status.counts.world_entries}
              />
              <SourceCard
                icon={Layers}
                label={t("storyMemory.sources.outlines")}
                count={status.counts.outlines}
              />
              <SourceCard
                icon={FileText}
                label={t("storyMemory.sources.notes")}
                count={status.counts.notes}
              />
            </Box>
            <section
              className="story-memory-page__index-panel"
              aria-labelledby="story-memory-index-heading"
            >
              <Flex
                align="center"
                justify="between"
                gap="4"
                wrap="wrap"
              >
                <Box>
                  <Flex
                    align="center"
                    gap="2"
                    wrap="wrap"
                  >
                    <Text
                      id="story-memory-index-heading"
                      as="div"
                      role="heading"
                      aria-level={2}
                      size="2"
                      weight="medium"
                    >
                      {t("storyMemory.indexTitle")}
                    </Text>
                    {statusBadge(status, t)}
                  </Flex>
                  {status.last_ready_at ? (
                    <Text
                      as="p"
                      size="1"
                      color="gray"
                      className="story-memory-page__last-updated"
                    >
                      {t("storyMemory.lastUpdated", {
                        time: new Date(status.last_ready_at).toLocaleString(),
                      })}
                    </Text>
                  ) : null}
                </Box>
                <Flex
                  align="center"
                  gap="3"
                  wrap="wrap"
                >
                  {isRebuilding ? (
                    <Text
                      size="1"
                      color="gray"
                    >
                      {t("storyMemory.rebuilding")}
                    </Text>
                  ) : null}
                  <Button
                    size="2"
                    disabled={!projectId || isRebuilding || !status.embedding_configured}
                    loading={rebuildMutation.isPending || isRebuilding}
                    onClick={() => rebuildMutation.mutate()}
                  >
                    <RefreshCw size={14} />
                    {t("storyMemory.rebuild")}
                  </Button>
                </Flex>
              </Flex>
              {!status.embedding_configured ? (
                <Box className="story-memory-page__embedding-notice">
                  <Flex
                    align="center"
                    justify="between"
                    gap="3"
                    wrap="wrap"
                  >
                    <Text
                      size="2"
                      className="story-memory-page__embedding-copy"
                    >
                      {t("storyMemory.embeddingMissing")}
                    </Text>
                    <Button
                      size="2"
                      variant="soft"
                      onClick={() =>
                        openSettings({ category: "models", modelTab: "embedding" })
                      }
                    >
                      <Settings2 size={14} />
                      {t("storyMemory.configureEmbedding")}
                    </Button>
                  </Flex>
                </Box>
              ) : null}
            </section>
            <Flex
              align="center"
              gap="2"
              mt="4"
            >
              <Brain
                size={14}
                color="var(--gray-11)"
                aria-hidden="true"
              />
              <Text
                size="1"
                color="gray"
              >
                {t("storyMemory.footerHint")}
              </Text>
            </Flex>
          </>
        )}
      </Box>
    </Box>
  );
}
