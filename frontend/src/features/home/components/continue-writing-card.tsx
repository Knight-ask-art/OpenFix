import { Button } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, LayoutDashboard, PenLine } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { fetchProject } from "@/lib/api-client";
import type { RecentProject } from "@/lib/recent-projects";

import "./continue-writing-card.css";

interface ContinueWritingCardProps {
  project: RecentProject | undefined;
}

export function ContinueWritingCard({ project }: ContinueWritingCardProps) {
  const { t } = useTranslation();

  const { data: projectDetail } = useQuery({
    queryKey: ["project", project?.projectId],
    queryFn: () => fetchProject(project!.projectId),
    enabled: Boolean(project?.projectId),
    staleTime: 30_000,
  });

  if (!project) {
    return (
      <section className="continue-writing-card continue-writing-card--empty">
        <span
          className="continue-writing-card__empty-icon"
          aria-hidden="true"
        >
          <BookOpen size={18} />
        </span>
        <h2 className="continue-writing-card__empty-title">{t("home.continueEmptyTitle")}</h2>
        <p className="continue-writing-card__empty-body">{t("home.continueEmptyBody")}</p>
        <div className="continue-writing-card__actions">
          <Button
            asChild
            variant="soft"
            size="2"
          >
            <Link to="/projects">{t("home.goToProjects")}</Link>
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="continue-writing-card">
      <p className="continue-writing-card__label">
        <PenLine
          size={14}
          aria-hidden="true"
        />
        {t("home.continueLabel")}
      </p>

      {/* 书名可能很长，这里允许换行显示完整标题，不做截断。 */}
      <h2
        className="continue-writing-card__title"
        title={project.title}
      >
        {project.title}
      </h2>

      {/* 字数与章数是两个独立的数值区域，各自带单位，不与书名挤在同一行。 */}
      <p className="continue-writing-card__meta">
        <span className="continue-writing-card__meta-item">
          <span className="continue-writing-card__meta-value">
            {projectDetail ? projectDetail.wordCount.toLocaleString() : "--"}
          </span>
          <span className="continue-writing-card__meta-unit">{t("home.wordsUnit")}</span>
        </span>
        <span
          className="continue-writing-card__meta-separator"
          aria-hidden="true"
        >
          ·
        </span>
        <span className="continue-writing-card__meta-item">
          <span className="continue-writing-card__meta-value">
            {projectDetail ? projectDetail.chapterCount.toLocaleString() : "--"}
          </span>
          <span className="continue-writing-card__meta-unit">{t("home.chaptersUnit")}</span>
        </span>
      </p>

      <p className="continue-writing-card__opened">
        {t("home.continueLastOpened", {
          time: project.openedAt.toLocaleString(),
        })}
      </p>

      <div className="continue-writing-card__actions">
        <Button
          asChild
          size="2"
        >
          <Link to={`/projects/${project.projectId}`}>{t("home.continueAction")}</Link>
        </Button>
        <Button
          asChild
          size="2"
          variant="soft"
          color="gray"
        >
          <Link to={`/projects/${project.projectId}/overview`}>
            <LayoutDashboard
              size={14}
              aria-hidden="true"
            />
            {t("home.openOverview")}
          </Link>
        </Button>
      </div>
    </section>
  );
}
