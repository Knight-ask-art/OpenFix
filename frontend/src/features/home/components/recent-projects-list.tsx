import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { getProjectInitial, type RecentProject } from "@/lib/recent-projects";

import "./recent-projects-list.css";

interface RecentProjectsListProps {
  projects: RecentProject[];
}

export function RecentProjectsList({ projects }: RecentProjectsListProps) {
  const { t } = useTranslation();

  if (projects.length === 0) {
    return null;
  }

  return (
    <section className="recent-projects-list">
      <h2 className="recent-projects-list__heading">{t("home.recentProjects")}</h2>
      <ul className="recent-projects-list__items">
        {projects.map((project) => (
          <li
            key={project.projectId}
            className="recent-projects-list__row"
          >
            <Link
              to={`/projects/${project.projectId}`}
              className="recent-projects-list__item"
            >
              <span
                aria-hidden="true"
                className={`recent-projects-list__badge recent-projects-list__badge--${project.color}`}
              >
                {getProjectInitial(project.title)}
              </span>
              <span
                className="recent-projects-list__title"
                title={project.title}
              >
                {project.title}
              </span>
              <ChevronRight
                className="recent-projects-list__chevron"
                size={16}
                aria-hidden="true"
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
