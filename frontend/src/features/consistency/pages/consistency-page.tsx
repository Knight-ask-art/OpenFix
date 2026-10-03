import { Box, Button, Flex, Select, Spinner, Text } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";

import { toast } from "@/components";
import { MobileAppSidebarTrigger, useAppShell } from "@/features/app-shell";
import { useProjectSelection } from "@/features/projects/hooks/use-project-selection";
import { useMobileSidebarSwipe } from "@/hooks/use-mobile-sidebar-swipe";
import { fetchChapters } from "@/lib/api-client";
import { getRecentProjects } from "@/lib/local-db";

import { IssueCard } from "../components/issue-card";
import {
  runConsistencyCheck,
  type ConsistencyCheckResult,
  type ConsistencyScope,
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

const SCOPE_OPTIONS: ConsistencyScope[] = ["chapter", "volume", "book"];

interface CheckTarget {
  projectId: string | null;
  scope: ConsistencyScope;
  chapterId: string | null;
  volumeId: string | null;
}

export function ConsistencyPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { closeSidebar, isMobile, isSidebarOpen, openSidebar } = useAppShell();
  const mobileSidebarSwipeHandlers = useMobileSidebarSwipe({
    isEnabled: isMobile,
    isOpen: isSidebarOpen,
    onOpen: openSidebar,
    onClose: closeSidebar,
  });

  const { data: recentProjects = [], isPending: isRecentProjectsPending } = useQuery({
    queryKey: ["recent-projects"],
    queryFn: getRecentProjects,
    staleTime: Infinity,
  });

  const [projectId, setProjectId] = useState<string | null>(null);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [volumeId, setVolumeId] = useState<string | null>(null);
  const [scope, setScope] = useState<ConsistencyScope>("chapter");
  const [result, setResult] = useState<ConsistencyCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const projectIdRef = useRef<string | null>(null);
  const checkTargetRef = useRef<CheckTarget>({
    projectId: null,
    scope: "chapter",
    chapterId: null,
    volumeId: null,
  });
  const checkRevisionRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      checkRevisionRef.current += 1;
    };
  }, []);

  // Invalidate synchronously, including A -> B -> A before an old request settles.
  // Only the selected scope's target affects the check; hidden chapter/volume choices do not.
  const updateCheckTarget = useCallback((changes: Partial<CheckTarget>) => {
    const current = checkTargetRef.current;
    const next = { ...current, ...changes };
    checkTargetRef.current = next;
    if (
      current.projectId === next.projectId &&
      current.scope === next.scope &&
      (next.scope !== "chapter" || current.chapterId === next.chapterId) &&
      (next.scope !== "volume" || current.volumeId === next.volumeId)
    ) return;
    checkRevisionRef.current += 1;
    setResult(null);
    setIsChecking(false);
  }, []);

  const setCurrentProject = useCallback((nextProjectId: string | null) => {
    if (projectIdRef.current === nextProjectId) return;
    projectIdRef.current = nextProjectId;
    updateCheckTarget({ projectId: nextProjectId, chapterId: null, volumeId: null });
    setProjectId(nextProjectId);
    setChapterId(null);
    setVolumeId(null);
    if (!nextProjectId) return;
    try {
      localStorage.setItem(CONSISTENCY_PROJECT_STORAGE_KEY, nextProjectId);
    } catch {
      // Only affects remembering the last project.
    }
  }, [updateCheckTarget]);

  const getCurrentProjectId = useCallback(() => projectIdRef.current, []);
  const readProjectCandidates = useCallback(
    () => Promise.resolve([
      readStoredProject(),
      ...recentProjects.map((recentProject) => recentProject.projectId),
    ]),
    [recentProjects],
  );
  const { projects, isLoadingProjects, selectProjectManually } = useProjectSelection({
    urlProjectId: searchParams.get("projectId"),
    getCurrentProjectId,
    setCurrentProject,
    isPreferenceReady: !isRecentProjectsPending,
    getPreferenceCandidates: readProjectCandidates,
  });

  const setCurrentChapter = useCallback((nextChapterId: string) => {
    updateCheckTarget({ chapterId: nextChapterId });
    setChapterId(nextChapterId);
  }, [updateCheckTarget]);
  const setCurrentVolume = useCallback((nextVolumeId: string) => {
    updateCheckTarget({ volumeId: nextVolumeId });
    setVolumeId(nextVolumeId);
  }, [updateCheckTarget]);

  const { data: tree } = useQuery({
    queryKey: ["project-chapter-tree", projectId],
    queryFn: () => fetchChapters(projectId ?? ""),
    enabled: Boolean(projectId),
  });
  const volumes = useMemo(() => tree?.volumes ?? [], [tree]);
  const chapters = useMemo(
    () => (tree?.volumes ?? []).flatMap((volume) => volume.chapters ?? []),
    [tree],
  );

  useEffect(() => {
    if (projectIdRef.current !== projectId) return;
    if (!chapterId && chapters.length > 0) {
      setCurrentChapter(chapters[0].id);
    }
  }, [chapterId, chapters, projectId, setCurrentChapter]);

  useEffect(() => {
    if (projectIdRef.current !== projectId) return;
    if (!chapterId) return;
    const containingVolume = chapters.find((chapter) => chapter.id === chapterId);
    if (containingVolume) {
      setCurrentVolume(containingVolume.volumeId);
    }
  }, [chapterId, chapters, projectId, setCurrentVolume]);

  useEffect(() => {
    if (projectIdRef.current !== projectId) return;
    if (volumeId) return;
    if (volumes.length === 0) return;
    setCurrentVolume(volumes[0].id);
  }, [projectId, setCurrentVolume, volumeId, volumes]);

  const handleProjectChange = (value: string) => {
    selectProjectManually(value);
  };

  const hasRequiredTarget =
    scope === "chapter" ? Boolean(chapterId) : scope === "volume" ? Boolean(volumeId) : true;

  const handleCheck = useCallback(async () => {
    const target = checkTargetRef.current;
    if (!target.projectId) return;
    if (target.scope === "chapter" && !target.chapterId) return;
    if (target.scope === "volume" && !target.volumeId) return;
    const revision = ++checkRevisionRef.current;
    const isCurrentRequest = () =>
      mountedRef.current && checkRevisionRef.current === revision;
    setIsChecking(true);
    setResult(null);
    try {
      const checked = await runConsistencyCheck(target.projectId, {
        scope: target.scope,
        chapterId: target.scope === "chapter" ? target.chapterId : null,
        volumeId: target.scope === "volume" ? target.volumeId : null,
      });
      if (isCurrentRequest()) setResult(checked);
    } catch (error) {
      if (!isCurrentRequest()) return;
      const detail =
        error && typeof error === "object" && "response" in error
          ? (
              (error as { response?: { data?: { detail?: unknown } } }).response?.data?.detail
            )
          : null;
      toast.error(typeof detail === "string" ? detail : t("consistency.checkFailed"));
    } finally {
      if (isCurrentRequest()) setIsChecking(false);
    }
  }, [t]);

  const issues = result?.issues ?? [];
  const failedSegments = result?.failed_segments ?? [];

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
              value={scope}
              onValueChange={(value) => {
                updateCheckTarget({ scope: value as ConsistencyScope });
                setScope(value as ConsistencyScope);
              }}
            >
              <Select.Trigger
                variant="soft"
                aria-label={t("consistency.scopeLabel")}
              />
              <Select.Content>
                {SCOPE_OPTIONS.map((option) => (
                  <Select.Item
                    key={option}
                    value={option}
                  >
                    {t(`consistency.scope.${option}`)}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Box>
          {scope === "chapter" ? (
            <Box className="consistency-page__select">
              <Select.Root
                value={chapterId ?? ""}
                onValueChange={setCurrentChapter}
              >
                <Select.Trigger
                  variant="soft"
                  aria-label={t("consistency.scope.chapter")}
                />
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
          ) : scope === "volume" ? (
            <Box className="consistency-page__select">
              <Select.Root
                value={volumeId ?? ""}
                onValueChange={setCurrentVolume}
              >
                <Select.Trigger
                  variant="soft"
                  aria-label={t("consistency.scope.volume")}
                />
                <Select.Content>
                  {volumes.map((volume) => (
                    <Select.Item
                      key={volume.id}
                      value={volume.id}
                    >
                      {volume.title || t("summary.untitledVolume")}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Box>
          ) : null}
          <Button
            size="2"
            disabled={!projectId || !hasRequiredTarget || isChecking}
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
            {failedSegments.length > 0 ? (
              <Box role="status">
                <Text size="2" color="amber">
                  {t("consistency.partialResultWarning", {
                    count: failedSegments.length,
                    segments: failedSegments.join(", "),
                  })}
                </Text>
              </Box>
            ) : null}
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
                {t("consistency.resultSummaryScoped", {
                  scope: t(`consistency.scope.${result.scope}`),
                  label: result.label,
                  chapters: result.chapter_count,
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
                  projectId={projectId ?? ""}
                  scope={result.scope}
                  chapterId={result.chapter_id}
                  volumeId={result.volume_id}
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
