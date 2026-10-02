import { Box, Card, Flex, Select, Spinner, Text } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import {
  Brain,
  Clapperboard,
  GitBranch,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  UserRound,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";

import { toast } from "@/components";
import { AssistantSidebarHost, MobileAppSidebarTrigger, useAppShell } from "@/features/app-shell";
import { useProjects } from "@/features/projects";
import { useMobileSidebarSwipe } from "@/hooks/use-mobile-sidebar-swipe";
import { getRecentProjects } from "@/lib/local-db";
import type { RecentProject } from "@/lib/recent-projects";

import "./ai-tasks-page.css";

const AI_PROJECT_STORAGE_KEY = "openfix.ai.projectId";

interface PresetTask {
  id: string;
  icon: LucideIcon;
  titleKey: string;
  descriptionKey: string;
  promptKey: string;
  href?: string;
}

const PRESET_TASKS: PresetTask[] = [
  {
    id: "continue-writing",
    icon: Wand2,
    titleKey: "aiTasks.presets.continueWriting.title",
    descriptionKey: "aiTasks.presets.continueWriting.description",
    promptKey: "aiTasks.presets.continueWriting.prompt",
  },
  {
    id: "analyze-plot",
    icon: Clapperboard,
    titleKey: "aiTasks.presets.analyzePlot.title",
    descriptionKey: "aiTasks.presets.analyzePlot.description",
    promptKey: "aiTasks.presets.analyzePlot.prompt",
  },
  {
    id: "design-character",
    icon: UserRound,
    titleKey: "aiTasks.presets.designCharacter.title",
    descriptionKey: "aiTasks.presets.designCharacter.description",
    promptKey: "aiTasks.presets.designCharacter.prompt",
  },
  {
    id: "build-world",
    icon: ScrollText,
    titleKey: "aiTasks.presets.buildWorld.title",
    descriptionKey: "aiTasks.presets.buildWorld.description",
    promptKey: "aiTasks.presets.buildWorld.prompt",
  },
  {
    id: "check-consistency",
    icon: ShieldCheck,
    titleKey: "aiTasks.presets.checkConsistency.title",
    descriptionKey: "aiTasks.presets.checkConsistency.description",
    promptKey: "aiTasks.presets.checkConsistency.prompt",
    href: "/consistency",
  },
  {
    id: "summarize-chapter",
    icon: RefreshCw,
    titleKey: "aiTasks.presets.summarizeChapter.title",
    descriptionKey: "aiTasks.presets.summarizeChapter.description",
    promptKey: "aiTasks.presets.summarizeChapter.prompt",
  },
  {
    id: "analyze-relationships",
    icon: GitBranch,
    titleKey: "aiTasks.presets.analyzeRelationships.title",
    descriptionKey: "aiTasks.presets.analyzeRelationships.description",
    promptKey: "aiTasks.presets.analyzeRelationships.prompt",
  },
  {
    id: "brainstorm",
    icon: Brain,
    titleKey: "aiTasks.presets.brainstorm.title",
    descriptionKey: "aiTasks.presets.brainstorm.description",
    promptKey: "aiTasks.presets.brainstorm.prompt",
  },
];

function readStoredProject(): string | null {
  try {
    return localStorage.getItem(AI_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistProject(value: string) {
  try {
    localStorage.setItem(AI_PROJECT_STORAGE_KEY, value);
  } catch {
    // 仅影响「记住上次项目」的便利性。
  }
}

function isKnownProject(projects: { id: string }[], value: string | null) {
  return Boolean(value) && projects.some((project) => project.id === value);
}

export function AiTasksPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { appendToAssistant, closeSidebar, isMobile, isSidebarOpen, openAssistantSidebar, openSidebar } =
    useAppShell();
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

  const [searchParams, setSearchParams] = useSearchParams();
  const queryProjectId = searchParams.get("projectId");

  const [projectId, setProjectId] = useState<string | null>(() => readStoredProject());
  const consumedQueryProjectRef = useRef<string | null>(null);

  // URL 中的 projectId 只在项目列表加载完成后应用一次，避免覆盖用户之后的手动选择。
  useEffect(() => {
    if (isLoadingProjects) return;
    if (projects.length === 0) return;
    if (!queryProjectId) return;
    if (consumedQueryProjectRef.current === queryProjectId) return;
    consumedQueryProjectRef.current = queryProjectId;

    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("projectId");
        return next;
      },
      { replace: true },
    );

    if (isKnownProject(projects, queryProjectId)) {
      setProjectId(queryProjectId);
    }
  }, [isLoadingProjects, projects, queryProjectId, setSearchParams]);

  // 无有效选中项时回退到最近项目或首个项目；已有有效选中项则保持不变。
  useEffect(() => {
    if (isLoadingProjects) return;
    if (projects.length === 0) return;
    const preferred =
      (recentProjects as RecentProject[]).find((item) =>
        projects.some((project) => project.id === item.projectId),
      )?.projectId ?? projects[0].id;
    setProjectId((current) => (isKnownProject(projects, current) ? current : preferred));
  }, [isLoadingProjects, projects, recentProjects]);

  // 只持久化仍然有效的项目 id，避免把已删除的项目写回本地存储。
  useEffect(() => {
    if (projectId && isKnownProject(projects, projectId)) {
      persistProject(projectId);
    }
  }, [projectId, projects]);

  const handleProjectChange = useCallback((value: string) => {
    setProjectId(value);
  }, []);

  const handleSelect = useCallback(
    (task: PresetTask) => {
      if (!projectId) {
        toast.error(t("aiTasks.noProject"));
        return;
      }
      if (task.href) {
        navigate(`${task.href}?projectId=${projectId}`);
        return;
      }
      appendToAssistant(t(task.promptKey));
      if (isMobile) openAssistantSidebar();
      toast.success(t("aiTasks.promptInserted"));
    },
    [appendToAssistant, isMobile, navigate, openAssistantSidebar, projectId, t],
  );

  return (
    <Box
      {...mobileSidebarSwipeHandlers}
      className="ai-tasks-page mobile-sidebar-swipe-surface"
    >
      <Box className="ai-tasks-page__header">
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
            {t("aiTasks.title")}
          </Text>
          <Box className="ai-tasks-page__project-select">
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
        <Text
          size="2"
          color="gray"
        >
          {t("aiTasks.description")}
        </Text>
      </Box>

      <Box className="ai-tasks-page__body">
        {projects.length === 0 && !isLoadingProjects ? (
          <Flex
            className="ai-tasks-page__empty"
            align="center"
            justify="center"
          >
            <Text color="gray">{t("aiTasks.noProject")}</Text>
          </Flex>
        ) : (
          <>
            <div className="ai-tasks-grid">
              {PRESET_TASKS.map((task) => {
                const Icon = task.icon;
                return (
                  <Card
                    key={task.id}
                    className="ai-task-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelect(task)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleSelect(task);
                      }
                    }}
                  >
                    <Flex
                      align="center"
                      gap="2"
                    >
                      <Icon
                        size={16}
                        aria-hidden="true"
                      />
                      <Text
                        size="3"
                        weight="medium"
                      >
                        {t(task.titleKey)}
                      </Text>
                    </Flex>
                    <Text
                      size="2"
                      color="gray"
                    >
                      {t(task.descriptionKey)}
                    </Text>
                  </Card>
                );
              })}
            </div>

            <Text
              size="1"
              color="gray"
            >
              {t("aiTasks.footnote")}
            </Text>
          </>
        )}
      </Box>

      {projectId ? (
        <Box className="ai-tasks-page__assistant">
          <AssistantSidebarHost
            projectId={projectId}
            isMobileOverlay={isMobile}
          />
        </Box>
      ) : null}
    </Box>
  );
}
