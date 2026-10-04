import { Box, Button } from "@radix-ui/themes";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Upload } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import { toast } from "@/components";
import { MobileAppSidebarTrigger, useAppShell } from "@/features/app-shell";
import { OnboardingWizard } from "@/features/onboarding";
import { useCreateProject } from "@/features/projects";
import { ImportDialog } from "@/features/projects/components/import-dialog";
import { ProjectFormDialog } from "@/features/projects/components/project-form-dialog";
import { useMobileSidebarSwipe } from "@/hooks/use-mobile-sidebar-swipe";
import { updateProjectProfile } from "@/lib/api-client";

import { ContinueWritingCard } from "../components/continue-writing-card";
import { RecentProjectsList } from "../components/recent-projects-list";
import { WritingStatCards } from "../components/writing-stat-cards";
import { useRecentProjects } from "../lib/home-api";

import "./home-page.css";

export function HomePage() {
  const { t } = useTranslation();
  const { closeSidebar, isMobile, isSidebarOpen, openSidebar } = useAppShell();
  const mobileSidebarSwipeHandlers = useMobileSidebarSwipe({
    isEnabled: isMobile,
    isOpen: isSidebarOpen,
    onOpen: openSidebar,
    onClose: closeSidebar,
  });
  const { data: recentProjects = [] } = useRecentProjects();
  const createMutation = useCreateProject();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);

  // 复用项目页「新建项目」的同一笔事务：先创建项目，再保存产品属性。
  // 产品属性保存失败属于部分成功，不能提示创建失败，否则用户会重复创建同一个项目。
  const handleCreateSubmit = async (data: {
    title: string;
    description?: string;
    cover?: File | null;
    genre?: string;
    targetWordCount?: number;
  }) => {
    let projectId: string | undefined;
    try {
      const created = await createMutation.mutateAsync({
        title: data.title,
        description: data.description ?? null,
        cover: data.cover ?? null,
      });
      projectId = created.id;
    } catch {
      toast.error(t("projects.createFailed"));
      return;
    }

    let isProfileSaved = true;
    if (projectId && (data.genre !== undefined || data.targetWordCount !== undefined)) {
      try {
        const savedProfile = await updateProjectProfile(projectId, {
          genre: data.genre ?? "",
          targetWordCount: data.targetWordCount ?? 0,
        });
        const profileQueryKey = ["project-profile", projectId];
        await queryClient.cancelQueries({ queryKey: profileQueryKey, exact: true });
        queryClient.setQueryData(profileQueryKey, savedProfile);
        void queryClient.invalidateQueries({ queryKey: ["project-profile", projectId] });
      } catch {
        isProfileSaved = false;
      }
    }

    setIsCreateDialogOpen(false);
    if (isProfileSaved) {
      toast.success(t("projects.projectCreated"));
    } else {
      toast.error(t("projects.profileUpdateFailed"));
    }

    // 创建成功后直接进入新项目，而不是把用户留在首页看一条提示：
    // 首页的「最近项目」只记录真正打开过的项目（见 AppSidebar 的 openRecentProject），
    // 停在首页会让刚创建的小说在最近项目里不可见，也没有可以立即开始写作的入口。
    // 产品属性保存失败属于部分成功，同样要进入该项目，否则用户会以为创建失败而重复创建。
    if (projectId) {
      navigate(`/projects/${projectId}`);
    }
  };

  return (
    <Box
      {...mobileSidebarSwipeHandlers}
      className="home-page mobile-sidebar-swipe-surface"
    >
      <div className="home-page__inner">
        <header className="home-page__header">
          <div className="home-page__heading">
            <MobileAppSidebarTrigger />
            <div className="home-page__heading-text">
              <h1 className="home-page__title">{t("home.title")}</h1>
              <p className="home-page__subtitle">{t("home.subtitle")}</p>
            </div>
          </div>

          <div className="home-page__header-actions">
            <Button
              size="2"
              onClick={() => setIsCreateDialogOpen(true)}
            >
              <Plus
                size={16}
                aria-hidden="true"
              />
              {t("home.createNovel")}
            </Button>
            <Button
              size="2"
              variant="soft"
              onClick={() => setIsImportDialogOpen(true)}
            >
              <Upload
                size={16}
                aria-hidden="true"
              />
              {t("home.importNovel")}
            </Button>
          </div>
        </header>

        <main className="home-page__body">
          <div className="home-page__overview">
            <ContinueWritingCard project={recentProjects[0]} />
            <WritingStatCards project={recentProjects[0]} />
          </div>

          <RecentProjectsList projects={recentProjects} />

          <div className="home-page__footer">
            <Button
              asChild
              variant="soft"
              size="2"
            >
              <Link to="/projects">{t("home.goToProjects")}</Link>
            </Button>
          </div>
        </main>
      </div>

      <ProjectFormDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        onSubmit={handleCreateSubmit}
        loading={createMutation.isPending}
      />

      <ImportDialog
        open={isImportDialogOpen}
        onOpenChange={setIsImportDialogOpen}
        onSuccess={() => {
          // 导入会写入写作活动记录，首页的写作统计需要重新取数。
          void queryClient.invalidateQueries({ queryKey: ["home"] });
        }}
      />

      <OnboardingWizard />
    </Box>
  );
}
