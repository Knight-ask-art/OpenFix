import { Box, Flex, Text } from "@radix-ui/themes";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";

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
    <Box className="recent-projects-list">
      <Text
        size="2"
        weight="medium"
        color="gray"
      >
        {t("home.recentProjects")}
      </Text>
      <Flex
        direction="column"
        gap="2"
      >
        {projects.map((project) => (
          <Link
            key={project.projectId}
            to={`/projects/${project.projectId}`}
            className="recent-projects-list__item"
          >
            <span
              aria-hidden="true"
              className={`recent-projects-list__badge recent-projects-list__badge--${project.color}`}
            >
              {getProjectInitial(project.title)}
            </span>
            <Text
              size="2"
              weight="medium"
              className="recent-projects-list__title"
            >
              {project.title}
            </Text>
          </Link>
        ))}
      </Flex>
    </Box>
  );
}
