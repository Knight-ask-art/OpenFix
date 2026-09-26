import { Box, Badge, Button, Flex, Select, Spinner, Text } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpenText,
  Brain,
  FileText,
  Globe,
  Layers,
  RefreshCw,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components";
import { MobileAppSidebarTrigger, useAppShell } from "@/features/app-shell";
import { useProjects } from "@/features/projects";
import { useMobileSidebarSwipe } from "@/hooks/use-mobile-sidebar-swipe";
import { getRecentProjects } from "@/lib/local-db";
import type { RecentProject } from "@/lib/recent-projects";

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
  const { closeSidebar, isMobile, isSidebarOpen, openSidebar } = useAppShell();
  const queryClient = useQueryClient();
  const mobileSidebarSwipeHandlers = useMobileSidebarSwipe({
    isEnabled: isMobile,
    isOpen: isSidebarOpen,
    onOpen: openSidebar,
    onClose: closeSidebar,
  });

  const { data: projectsData, isLoading: isLoadingProjects } = useProjects({
    page: 1,
    pageSize: 100,
  });
  const projects = useMemo(() => projectsData?.items ?? [], [projectsData]);
  const { data: recentProjects = [] } = useQuery({
    queryKey: ["recent-projects"],
    queryFn: getRecentProjects,
    staleTime: Infinity,
  });

  const [projectId, setProjectId] = useState<string | null>(() => readStoredProject());

  useEffect(() => {
    if (projectId) return;
    if (projects.length === 0) return;
    const preferred =
      (recentProjects as RecentProject[]).find((item) =>
        projects.some((project) => project.id === item.projectId),
      )?.projectId ?? projects[0].id;
    setProjectId(preferred);
  }, [projectId, projects, recentProjects]);

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

  const handleProjectChange = (value: string) => {
    setProjectId(value);
    try {
      localStorage.setItem(STORY_MEMORY_PROJECT_STORAGE_KEY, value);
    } catch {
      // Only affects convenience of remembering the last project.
    }
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
          {status ? (
            <Flex
              align="center"
              gap="2"
            >
              {statusBadge(status, t)}
              {status.last_ready_at ? (
                <Text
                  size="1"
                  color="gray"
                >
                  {t("storyMemory.lastUpdated", {
                    time: new Date(status.last_ready_at).toLocaleString(),
                  })}
                </Text>
              ) : null}
            </Flex>
          ) : null}
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
            {!status.embedding_configured ? (
              <Box className="story-memory-page__notice">
                <Text
                  size="2"
                  color="amber"
                >
                  {t("storyMemory.embeddingMissing")}
                </Text>
              </Box>
            ) : null}
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
            <Flex
              wrap="wrap"
              gap="3"
              mt="2"
            >
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
            </Flex>
            <Flex
              align="center"
              gap="3"
              mt="4"
            >
              <Button
                size="2"
                disabled={!projectId || isRebuilding || !status.embedding_configured}
                loading={rebuildMutation.isPending || isRebuilding}
                onClick={() => rebuildMutation.mutate()}
              >
                <RefreshCw size={14} />
                {t("storyMemory.rebuild")}
              </Button>
              {isRebuilding ? (
                <Text
                  size="1"
                  color="gray"
                >
                  {t("storyMemory.rebuilding")}
                </Text>
              ) : null}
            </Flex>
            <Flex
              align="center"
              gap="2"
              mt="5"
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
