import { Box, Flex, Text } from "@radix-ui/themes";
import { CalendarDays } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { WritingStats } from "../lib/home-api";
import { useWritingStats } from "../lib/home-api";

import "./writing-stat-cards.css";

interface WritingStatCardProps {
  label: string;
  stats: WritingStats | undefined;
  isLoading: boolean;
}

function formatWordDelta(value: number): string {
  if (Math.abs(value) >= 10000) {
    return `${(value / 10000).toFixed(1)}w`;
  }
  return value.toLocaleString();
}

function WritingStatCard({ label, stats, isLoading }: WritingStatCardProps) {
  const { t } = useTranslation();

  return (
    <Box className="writing-stat-card">
      <Flex
        align="center"
        gap="2"
      >
        <CalendarDays
          size={14}
          color="var(--gray-11)"
          aria-hidden="true"
        />
        <Text
          size="2"
          color="gray"
        >
          {label}
        </Text>
      </Flex>
      {isLoading || !stats ? (
        <Text
          size="5"
          color="gray"
        >
          --
        </Text>
      ) : (
        <>
          <Text
            size="5"
            weight="medium"
          >
            {formatWordDelta(stats.wordDelta)}
            <Text
              size="1"
              color="gray"
              ml="1"
            >
              {t("home.wordsUnit")}
            </Text>
          </Text>
          <Text
            size="1"
            color="gray"
          >
            {t("home.activeDays", { count: stats.activeDays })}
          </Text>
        </>
      )}
    </Box>
  );
}

export function WritingStatCards() {
  const { t } = useTranslation();
  const { data: todayStats, isLoading: isTodayLoading } = useWritingStats("today");
  const { data: weekStats, isLoading: isWeekLoading } = useWritingStats("week");

  return (
    <Flex
      gap="3"
      wrap="wrap"
    >
      <WritingStatCard
        label={t("home.todayWriting")}
        stats={todayStats}
        isLoading={isTodayLoading}
      />
      <WritingStatCard
        label={t("home.thisWeekWriting")}
        stats={weekStats}
        isLoading={isWeekLoading}
      />
    </Flex>
  );
}
