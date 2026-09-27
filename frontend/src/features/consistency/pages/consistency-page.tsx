import { Box, Button, Flex, Select, Spinner, Text } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components";
import { MobileAppSidebarTrigger, useAppShell } from "@/features/app-shell";
import { useProjects } from "@/features/projects";
import { useMobileSidebarSwipe } from "@/hooks/use-mobile-sidebar-swipe";
import { fetchChapters } from "@/lib/api-client";
import { getRecentProjects } from "@/lib/local-db";
import type { RecentProject } from "@/lib/recent-projects";

import { IssueCard } from "../components/issue-card";
import {
  runConsistencyCheck,
  type ConsistencyCheckResult,
} from "../lib/consistency-api";

import "./consistency-page.css";

const CONSISTENCY_PROJECT_STORAGE_KEY = "openfix.consistency.projectId";

function readStoredProject(): string | null {
  try {
    return localStorage.getItem(CONSISTENCY_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function ConsistencyPage() {
  const { t } = useTranslation();
  const { closeSidebar, isMobile, isSidebarOpen, openSidebar } = useAppShell();
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
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [result, setResult] = useState<ConsistencyCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  useEffect(() => {
    if (projectId) return;
    if (projects.length === 0) return;
    const preferred =
      (recentProjects as RecentProject[]).find((item) =>
        projects.some((project) => project.id === item.projectId),
      )?.projectId ?? projects[0].id;
    setProjectId(preferred);
  }, [projectId, projects, recentProjects]);

  const { data: tree } = useQuery({
    queryKey: ["project-chapter-tree", projectId],
    queryFn: () => fetchChapters(projectId ?? ""),
    enabled: Boolean(projectId),
  });
  const chapters = useMemo(
    () => (tree?.volumes ?? []).flatMap((volume) => volume.chapters ?? []),
    [tree],
  );

  useEffect(() => {
    if (!chapterId && chapters.length > 0) {
      setChapterId(chapters[0].id);
    }
  }, [chapterId, chapters]);

  const handleProjectChange = (value: string) => {
    setProjectId(value);
    setChapterId(null);
    setResult(null);
    try {
      localStorage.setItem(CONSISTENCY_PROJECT_STORAGE_KEY, value);
    } catch {
      // Only affects remembering the last project.
    }
  };

  const handleCheck = useCallback(async () => {
    if (!projectId || !chapterId) return;
    setIsChecking(true);
    setResult(null);
    try {
      const checked = await runConsistencyCheck(projectId, chapterId);
      setResult(checked);
    } catch (error) {
      const detail =
        error && typeof error === "object" && "response" in error
          ? (
              (error as { response?: { data?: { detail?: unknown } } }).response?.data?.detail
            )
          : null;
      toast.error(typeof detail === "string" ? detail : t("consistency.checkFailed"));
    } finally {
      setIsChecking(false);
    }
  }, [chapterId, projectId, t]);

  const issues = result?.issues ?? [];

  return (
    <Box
      {...mobileSidebarSwipeHandlers}
      className="consistency-page mobile-sidebar-swipe-surface"
    >
      <Box className="consistency-page__header">
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
            {t("consistency.title")}
          </Text>
          <Box className="consistency-page__select">
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
          <Box className="consistency-page__select">
            <Select.Root
              value={chapterId ?? ""}
              onValueChange={(value) => {
                setChapterId(value);
                setResult(null);
              }}
            >
              <Select.Trigger variant="soft" />
              <Select.Content>
                {chapters.map((chapter) => (
                  <Select.Item
                    key={chapter.id}
                    value={chapter.id}
                  >
                    {chapter.title || t("consistency.untitledChapter")}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Box>
          <Button
            size="2"
            disabled={!projectId || !chapterId || isChecking}
            loading={isChecking}
            onClick={() => void handleCheck()}
          >
            <Search size={14} />
            {t("consistency.check")}
          </Button>
        </Flex>
      </Box>

      <Box className="consistency-page__body">
        {isChecking ? (
          <Flex
            className="consistency-page__status"
            align="center"
            gap="3"
          >
            <Spinner size="2" />
            <Text
              size="2"
              color="gray"
            >
              {t("consistency.checking")}
            </Text>
          </Flex>
        ) : !result ? (
          <Flex
            className="consistency-page__status"
            direction="column"
            align="center"
            justify="center"
            gap="2"
          >
            <Text
              size="2"
              color="gray"
            >
              {t("consistency.idleHint")}
            </Text>
            <Text
              size="1"
              color="gray"
            >
              {t("consistency.disclaimer")}
            </Text>
          </Flex>
        ) : (
          <Flex
            direction="column"
            gap="3"
          >
            <Flex
              align="center"
              justify="between"
              wrap="wrap"
              gap="2"
            >
              <Text
                size="1"
                color="gray"
              >
                {t("consistency.resultSummary", {
                  count: issues.length,
                  model: result.model,
                })}
              </Text>
              <Text
                size="1"
                color="gray"
              >
                {result.context_source === "story_memory"
                  ? t("consistency.contextStoryMemory")
                  : t("consistency.contextInventory")}
              </Text>
            </Flex>
            {issues.length === 0 ? (
              <Box className="consistency-page__clean">
                <Text size="2">{t("consistency.noIssues")}</Text>
              </Box>
            ) : (
              issues.map((issue, index) => (
                <IssueCard
                  key={`${issue.type}-${index}`}
                  issue={issue}
                />
              ))
            )}
            <Flex justify="end">
              <Button
                size="1"
                variant="ghost"
                color="gray"
                onClick={() => void handleCheck()}
              >
                {t("consistency.recheck")}
              </Button>
            </Flex>
          </Flex>
        )}
      </Box>
    </Box>
  );
}
