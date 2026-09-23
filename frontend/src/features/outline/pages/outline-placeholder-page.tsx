import { Box, Flex, Text } from "@radix-ui/themes";
import { ListTree } from "lucide-react";
import { useTranslation } from "react-i18next";

import { MobileAppSidebarTrigger, useAppShell } from "@/features/app-shell";
import { useMobileSidebarSwipe } from "@/hooks/use-mobile-sidebar-swipe";

import "./outline-placeholder-page.css";

export function OutlinePlaceholderPage() {
  const { t } = useTranslation();
  const { closeSidebar, isMobile, isSidebarOpen, openSidebar } = useAppShell();
  const mobileSidebarSwipeHandlers = useMobileSidebarSwipe({
    isEnabled: isMobile,
    isOpen: isSidebarOpen,
    onOpen: openSidebar,
    onClose: closeSidebar,
  });

  return (
    <Box
      {...mobileSidebarSwipeHandlers}
      className="outline-placeholder-page mobile-sidebar-swipe-surface"
    >
      <Flex
        className="outline-placeholder-page__header"
        align="center"
        gap="3"
      >
        <MobileAppSidebarTrigger />
        <Text
          size="5"
          weight="medium"
        >
          {t("nav.outline")}
        </Text>
      </Flex>

      <Flex
        className="outline-placeholder-page__body"
        direction="column"
        align="center"
        justify="center"
        gap="3"
      >
        <Box className="outline-placeholder-page__icon">
          <ListTree
            size={28}
            aria-hidden="true"
          />
        </Box>
        <Text
          size="4"
          weight="medium"
        >
          {t("nav.outlinePlaceholderTitle")}
        </Text>
        <Text
          size="2"
          color="gray"
          align="center"
          className="outline-placeholder-page__description"
        >
          {t("nav.outlinePlaceholderBody")}
        </Text>
      </Flex>
    </Box>
  );
}
