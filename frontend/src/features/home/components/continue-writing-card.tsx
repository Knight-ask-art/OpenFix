import { Box, Button, Flex, Text } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard, PenLine } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";

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
      <Box className="continue-writing-card continue-writing-card--empty">
        <Text
          size="4"
          weight="medium"
        >
          {t("home.continueEmptyTitle")}
        </Text>
        <Text
          size="2"
          color="gray"
        >
          {t("home.continueEmptyBody")}
        </Text>
        <Button
          asChild
          variant="soft"
          size="2"
        >
          <Link to="/projects">{t("home.goToProjects")}</Link>
        </Button>
      </Box>
    );
  }

  return (
    <Box className="continue-writing-card">
      <Flex
        align="center"
        justify="between"
      >
        <Text
          size="2"
          color="gray"
        >
          {t("home.continueLabel")}
        </Text>
        <PenLine
          size={16}
          color="var(--gray-11)"
          aria-hidden="true"
        />
      </Flex>
      <Text
        size="5"
        weight="medium"
        className="continue-writing-card__title"
      >
        {project.title}
      </Text>
      {projectDetail ? (
        <Text
          size="2"
          color="gray"
        >
          {t("home.continueMeta", {
            words: projectDetail.wordCount.toLocaleString(),
            chapters: projectDetail.chapterCount,
          })}
        </Text>
      ) : null}
      <Text
        size="1"
        color="gray"
      >
        {t("home.continueLastOpened", {
          time: project.openedAt.toLocaleString(),
        })}
      </Text>
      <Flex
        gap="2"
        wrap="wrap"
      >
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
            <LayoutDashboard size={14} />
            {t("home.openOverview")}
          </Link>
        </Button>
      </Flex>
    </Box>
  );
}
