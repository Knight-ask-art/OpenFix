import { useQuery } from "@tanstack/react-query";

import { fetchWritingDashboard } from "@/features/dashboard/lib/dashboard-api";
import { toIsoDateTime } from "@/features/dashboard/lib/dashboard-formatters";
import type {
  WritingActivitySummary,
  WritingActivityTimeSeriesPoint,
  WritingDashboardQueryParams,
  WritingDashboardResponse,
} from "@/features/dashboard/lib/dashboard.types";
import { getRecentProjects } from "@/lib/local-db";

const HOME_STATS_STALE_MS = 1000 * 60;

function formatDayBoundary(date: Date, boundary: "start" | "end"): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return toIsoDateTime(`${year}-${month}-${day}`, boundary) ?? "";
}

export function getStartOfWeek(today = new Date()): Date {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const weekday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - weekday);
  return start;
}

export interface WritingStats {
  wordDelta: number;
  activeDays: number;
}

export function sumWritingStats(response: WritingDashboardResponse): WritingStats {
  const total = (point: WritingActivityTimeSeriesPoint) =>
    point.userWordDelta + point.agentWordDelta + point.importWordDelta;

  const wordDelta = response.timeSeries.reduce(
    (sum: number, point: WritingActivityTimeSeriesPoint) => sum + total(point),
    0,
  );
  const summary: WritingActivitySummary = response.summary;
  return { wordDelta, activeDays: summary.activeDays };
}

export function buildWritingStatsQuery(range: "today" | "week", today = new Date()): WritingDashboardQueryParams {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (range === "today") {
    return {
      startAt: formatDayBoundary(today, "start"),
      endAt: formatDayBoundary(today, "end"),
      timezone,
    };
  }
  return {
    startAt: formatDayBoundary(getStartOfWeek(today), "start"),
    endAt: formatDayBoundary(today, "end"),
    timezone,
  };
}

export function useRecentProjects() {
  return useQuery({
    queryKey: ["recent-projects"],
    queryFn: getRecentProjects,
    staleTime: Infinity,
  });
}

export function useWritingStats(range: "today" | "week") {
  return useQuery({
    queryKey: ["home", "writing-stats", range],
    queryFn: async () => sumWritingStats(await fetchWritingDashboard(buildWritingStatsQuery(range))),
    staleTime: HOME_STATS_STALE_MS,
  });
}
