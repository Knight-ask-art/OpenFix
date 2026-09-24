import { Box, Button, Container, Flex, Text } from "@radix-ui/themes";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";

import { MobileAppSidebarTrigger, useAppShell } from "@/features/app-shell";
import { useMobileSidebarSwipe } from "@/hooks/use-mobile-sidebar-swipe";

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

  return (
    <Box
      {...mobileSidebarSwipeHandlers}
      className="home-page mobile-sidebar-swipe-surface"
    >
      <Container
        size="4"
        px="5"
      >
        <Flex
          className="home-page__header"
          align="center"
          gap="3"
        >
          <MobileAppSidebarTrigger />
          <Text
            size="5"
            weight="medium"
          >
            {t("home.title")}
          </Text>
        </Flex>
      </Container>

      <Container
        size="4"
        px="5"
        py="5"
        className="home-page__body"
      >
        <Flex
          direction="column"
          gap="5"
        >
          <Flex
            gap="4"
            wrap="wrap"
            align="stretch"
          >
            <Box className="home-page__continue">
              <ContinueWritingCard project={recentProjects[0]} />
            </Box>
            <WritingStatCards />
          </Flex>

          <RecentProjectsList projects={recentProjects} />

          <Button
            asChild
            variant="soft"
            size="2"
            className="home-page__all-projects"
          >
            <Link to="/projects">{t("home.goToProjects")}</Link>
          </Button>
        </Flex>
      </Container>
    </Box>
  );
}
