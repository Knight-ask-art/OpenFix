import { Badge, Box, Button, Card, Flex, Progress, Spinner, Text } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BookOpenText, Globe, ListTree, PenLine, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";

import { MobileAppSidebarTrigger, useAppShell } from "@/features/app-shell";
import { useMobileSidebarSwipe } from "@/hooks/use-mobile-sidebar-swipe";
import {
  fetchCharactersByProject,
  fetchChapters,
  fetchProject,
  fetchProjectChapterMeta,
  fetchProjectProfile,
  fetchWorldInfoByProject,
  fetchWorldInfoEntries,
} from "@/lib/api-client";
import type { ChapterStatus } from "@/lib/chapter.types";

import "./project-overview-page.css";

const STATUS_ORDER: ChapterStatus[] = ["draft", "writing", "revising", "done"];

interface StatCardProps {
  label: string;
  value: string;
}

function StatCard({ label, value }: StatCardProps) {
  return (
    <Card className="project-overview-stat">
      <Text
        size="1"
        color="gray"
      >
        {label}
      </Text>
      <Text
        size="5"
        weight="medium"
      >
        {value}
      </Text>
    </Card>
  );
}

export function ProjectOverviewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { projectId = "" } = useParams();
  const { closeSidebar, isMobile, isSidebarOpen, openSidebar } = useAppShell();
  const mobileSidebarSwipeHandlers = useMobileSidebarSwipe({
    isEnabled: isMobile,
    isOpen: isSidebarOpen,
    onOpen: openSidebar,
    onClose: closeSidebar,
  });

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => fetchProject(projectId),
    enabled: Boolean(projectId),
  });
  const profileQuery = useQuery({
    queryKey: ["project-profile", projectId],
    queryFn: () => fetchProjectProfile(projectId),
    enabled: Boolean(projectId),
  });
  const chaptersQuery = useQuery({
    queryKey: ["project-chapter-tree", projectId],
    queryFn: () => fetchChapters(projectId),
    enabled: Boolean(projectId),
  });
  const charactersQuery = useQuery({
    queryKey: ["characters", projectId],
    queryFn: () => fetchCharactersByProject(projectId),
    enabled: Boolean(projectId),
  });
  const worldInfoQuery = useQuery({
    queryKey: ["world-info-by-project", projectId],
    queryFn: () => fetchWorldInfoByProject(projectId),
    enabled: Boolean(projectId),
  });
  const worldEntriesQuery = useQuery({
    queryKey: ["world-info-entries", worldInfoQuery.data?.id],
    queryFn: () => fetchWorldInfoEntries(worldInfoQuery.data!.id),
    enabled: Boolean(worldInfoQuery.data?.id),
  });
  const chapterMetaQuery = useQuery({
    queryKey: ["project-chapter-meta", projectId],
    queryFn: () => fetchProjectChapterMeta(projectId),
    enabled: Boolean(projectId),
  });

  useEffect(() => {
    if (projectId) return;
    navigate("/projects", { replace: true });
  }, [navigate, projectId]);

  const chapters = useMemo(
    () => (chaptersQuery.data?.volumes ?? []).flatMap((volume) => volume.chapters ?? []),
    [chaptersQuery.data],
  );
  const currentVolume = useMemo(() => {
    const volumes = chaptersQuery.data?.volumes ?? [];
    return volumes.find((volume) => (volume.chapters?.length ?? 0) > 0) ?? volumes[0] ?? null;
  }, [chaptersQuery.data]);

  const statusCounts = useMemo(() => {
    const counts: Record<ChapterStatus, number> = { draft: 0, writing: 0, revising: 0, done: 0 };
    for (const meta of chapterMetaQuery.data?.items ?? []) {
      counts[meta.status] += 1;
    }
    return counts;
  }, [chapterMetaQuery.data]);

  const characters = charactersQuery.data?.items ?? [];
  const project = projectQuery.data;
  const profile = profileQuery.data;
  const worldEntryCount = worldEntriesQuery.data?.total ?? 0;

  const isLoading = projectQuery.isLoading;

  if (isLoading) {
    return (
      <Flex
        className="project-overview-page"
        align="center"
        justify="center"
      >
        <Spinner size="2" />
      </Flex>
    );
  }

  if (!project) {
    return (
      <Box className="project-overview-page">
        <Text color="gray">{t("projectOverview.notFound")}</Text>
      </Box>
    );
  }

  const target = profile?.targetWordCount ?? 0;
  const progressPercent = target > 0 ? Math.min(100, (project.wordCount / target) * 100) : 0;

  const openPage = (path: string) => navigate(`${path}?projectId=${projectId}`);

  return (
    <Box
      {...mobileSidebarSwipeHandlers}
      className="project-overview-page mobile-sidebar-swipe-surface"
    >
      <Flex
        align="center"
        gap="3"
        wrap="wrap"
        className="project-overview-header"
      >
        <MobileAppSidebarTrigger />
        <Text
          size="6"
          weight="medium"
        >
          {project.title}
        </Text>
        {profile?.genre ? <Badge variant="soft">{t(`projectForm.genres.${profile.genre}`)}</Badge> : null}
        <Button
          size="2"
          onClick={() => navigate(`/projects/${projectId}`)}
        >
          <PenLine size={14} />
          {t("projectOverview.continueWriting")}
        </Button>
      </Flex>

      {profile?.synopsis || project.description ? (
        <Text
          size="2"
          color="gray"
        >
          {profile?.synopsis || project.description}
        </Text>
      ) : null}

      <div className="project-overview-stats">
        <StatCard
          label={t("projectOverview.stats.words")}
          value={project.wordCount.toLocaleString()}
        />
        <StatCard
          label={t("projectOverview.stats.chapters")}
          value={String(project.chapterCount)}
        />
        <StatCard
          label={t("projectOverview.stats.characters")}
          value={String(characters.length)}
        />
        <StatCard
          label={t("projectOverview.stats.worldEntries")}
          value={String(worldEntryCount)}
        />
      </div>

      <Card className="project-overview-section">
        <Text
          size="3"
          weight="medium"
        >
          {t("projectOverview.progress.title")}
        </Text>
        <Text
          size="2"
          color="gray"
        >
          {currentVolume
            ? t("projectOverview.progress.volume", { title: currentVolume.title })
            : t("projectOverview.progress.noVolume")}
        </Text>
        <Text size="2">
          {target > 0
            ? t("projectOverview.progress.words", {
                current: project.wordCount.toLocaleString(),
                target: target.toLocaleString(),
              })
            : t("projectOverview.progress.noTarget")}
        </Text>
        <Progress value={progressPercent} />
      </Card>

      <Card className="project-overview-section">
        <Text
          size="3"
          weight="medium"
        >
          {t("projectOverview.chapterStatus.title")}
        </Text>
        <Flex
          gap="3"
          wrap="wrap"
        >
          {STATUS_ORDER.map((status) => (
            <Flex
              key={status}
              align="center"
              gap="2"
            >
              <Text
                size="2"
                color="gray"
              >
                {t(`writing.chapterStatus.${status}`)}
              </Text>
              <Text
                size="3"
                weight="medium"
              >
                {statusCounts[status]}
              </Text>
            </Flex>
          ))}
        </Flex>
      </Card>

      {characters.length > 0 ? (
        <Card className="project-overview-section">
          <Text
            size="3"
            weight="medium"
          >
            {t("projectOverview.recentCharacters")}
          </Text>
          <Flex
            gap="2"
            wrap="wrap"
          >
            {characters.slice(0, 6).map((character) => (
              <Badge
                key={character.id}
                variant="soft"
                color="gray"
              >
                {character.name}
              </Badge>
            ))}
          </Flex>
        </Card>
      ) : null}

      <Card className="project-overview-section">
        <Text
          size="3"
          weight="medium"
        >
          {t("projectOverview.todo.title")}
        </Text>
        <Flex
          direction="column"
          gap="2"
        >
          <Flex
            align="center"
            justify="between"
            gap="3"
          >
            <Flex
              align="center"
              gap="2"
            >
              <ShieldCheck size={14} />
              <Text size="2">
                {t("projectOverview.todo.revisingChapters", {
                  count: statusCounts.revising,
                })}
              </Text>
            </Flex>
            <Button
              size="1"
              variant="soft"
              onClick={() => openPage("/consistency")}
            >
              {t("assistant.suggestions.openConsistency")}
              <ArrowRight size={13} />
            </Button>
          </Flex>

          <Flex
            align="center"
            justify="between"
            gap="3"
          >
            <Flex
              align="center"
              gap="2"
            >
              <BookOpenText size={14} />
              <Text size="2">{t("projectOverview.todo.storyMemory")}</Text>
            </Flex>
            <Button
              size="1"
              variant="soft"
              onClick={() => openPage("/story-memory")}
            >
              {t("assistant.suggestions.openStoryMemory")}
              <ArrowRight size={13} />
            </Button>
          </Flex>

          <Flex
            align="center"
            justify="between"
            gap="3"
          >
            <Flex
              align="center"
              gap="2"
            >
              <ListTree size={14} />
              <Text size="2">{t("projectOverview.todo.aiTasks")}</Text>
            </Flex>
            <Button
              size="1"
              variant="soft"
              onClick={() => openPage("/ai")}
            >
              {t("assistant.suggestions.openAiTasks")}
              <ArrowRight size={13} />
            </Button>
          </Flex>
        </Flex>
      </Card>

      <Text
        size="1"
        color="gray"
      >
        {t("projectOverview.chapterCountNote", { count: chapters.length })}
      </Text>

      <Flex
        gap="2"
        wrap="wrap"
      >
        <Button
          size="1"
          variant="ghost"
          color="gray"
          onClick={() => openPage("/outline")}
        >
          <ListTree size={13} />
          {t("nav.outline")}
        </Button>
        <Button
          size="1"
          variant="ghost"
          color="gray"
          onClick={() => openPage("/characters")}
        >
          <UserRound size={13} />
          {t("nav.characters")}
        </Button>
        <Button
          size="1"
          variant="ghost"
          color="gray"
          onClick={() => openPage("/world-info")}
        >
          <Globe size={13} />
          {t("nav.world")}
        </Button>
      </Flex>
    </Box>
  );
}
