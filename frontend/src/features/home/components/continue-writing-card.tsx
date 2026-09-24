import { Box, Button, Flex, Text } from "@radix-ui/themes";
import { PenLine } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";

import type { RecentProject } from "@/lib/recent-projects";

import "./continue-writing-card.css";

interface ContinueWritingCardProps {
  project: RecentProject | undefined;
}

export function ContinueWritingCard({ project }: ContinueWritingCardProps) {
  const { t } = useTranslation();

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
      <Button
        asChild
        size="2"
      >
        <Link to={`/projects/${project.projectId}`}>{t("home.continueAction")}</Link>
      </Button>
    </Box>
  );
}
