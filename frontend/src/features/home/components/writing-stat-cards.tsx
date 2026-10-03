import {
  Box,
  Button,
  Dialog,
  Flex,
  IconButton,
  Progress,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Pencil, RefreshCw, Target } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components";
import { fetchWritingDashboard } from "@/features/dashboard/lib/dashboard-api";
import { fetchProjectProfile, updateProjectProfile } from "@/lib/api-client";
import type { RecentProject } from "@/lib/recent-projects";

import type { WritingStats } from "../lib/home-api";
import { buildWritingStatsQuery, sumWritingStats, useWritingStats } from "../lib/home-api";

import "./writing-stat-cards.css";

/** 每日目标卡片的缓存时长，与首页其它写作统计保持一致。 */
const DAILY_GOAL_STALE_MS = 1000 * 60;

/**
 * 每日字数目标上限，与后端 project_profile_service.MAX_TARGET_WORD_COUNT 保持一致。
 *
 * 超过上限的写入会被后端以 400 永久拒绝，所以必须在提交前拦下来，
 * 不能让它落进面向临时故障的「保存失败，请重试」。
 */
const MAX_DAILY_WORD_GOAL = 100_000_000;

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

interface DailyGoalCardProps {
  project: RecentProject;
}

/**
 * 解析对话框里的每日目标：留空表示取消目标（0）；超过后端上限或不是安全整数时返回 null。
 * 输入框已经过滤掉非数字字符，所以这里只会拿到空串或数字串。
 */
function parseDailyGoalInput(value: string): number | null {
  if (value === "") return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_DAILY_WORD_GOAL) return null;
  return parsed;
}

/**
 * 每日写作目标卡片。
 *
 * 目标按项目保存（项目产品属性的 daily_word_goal），所以当日字数也按同一个项目统计，
 * 不能复用跨项目的「今日写作」数字，否则进度会与目标不是同一个范围。
 */
function DailyGoalCard({ project }: DailyGoalCardProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [goalInput, setGoalInput] = useState("");
  const [hasSaveFailed, setHasSaveFailed] = useState(false);

  // 与项目页编辑对话框共用同一个查询键，避免两处读到不同的产品属性。
  const profileQueryKey = ["project-profile", project.projectId];

  const {
    data: profile,
    isError: hasProfileError,
    isFetching: isProfileFetching,
    refetch: refetchProfile,
  } = useQuery({
    queryKey: profileQueryKey,
    queryFn: () => fetchProjectProfile(project.projectId),
  });

  const dailyWordGoal = profile?.dailyWordGoal ?? 0;

  // 没有设置目标时不显示进度，也就不必统计当日字数。
  const { data: todayStats, isError: hasTodayStatsError } = useQuery({
    queryKey: ["home", "writing-stats", "today", project.projectId],
    queryFn: async () =>
      sumWritingStats(
        await fetchWritingDashboard({
          ...buildWritingStatsQuery("today"),
          projectId: project.projectId,
        }),
      ),
    enabled: dailyWordGoal > 0,
    staleTime: DAILY_GOAL_STALE_MS,
  });

  const saveGoal = useMutation({
    mutationFn: (nextGoal: number) =>
      updateProjectProfile(project.projectId, { dailyWordGoal: nextGoal }),
    onSuccess: (savedProfile) => {
      queryClient.setQueryData(profileQueryKey, savedProfile);
    },
  });

  // 进度只能来自真实的项目当日统计：读取中与读取失败都不能按 0 计算，
  // 否则「还不知道」会被显示成「今天一个字都没写」。
  const progressPercent =
    todayStats && dailyWordGoal > 0
      ? Math.min(100, Math.max(0, Math.round((todayStats.wordDelta / dailyWordGoal) * 100)))
      : null;

  const parsedGoalInput = parseDailyGoalInput(goalInput);
  const isGoalInputTooLarge = parsedGoalInput === null;

  // 读取失败且没有可用的已保存值时，说明原因并给出重试；有数据时继续显示真实目标。
  const hasProfileLoadFailed = hasProfileError && !profile;
  // 同理：只有拿不到当日字数时才报错，避免在真实数字旁边叠加矛盾的文案。
  const hasTodayStatsLoadFailed = hasTodayStatsError && !todayStats;

  const handleOpenDialog = () => {
    setGoalInput(dailyWordGoal > 0 ? String(dailyWordGoal) : "");
    setHasSaveFailed(false);
    setIsDialogOpen(true);
  };

  const handleDialogOpenChange = (open: boolean) => {
    // 保存未完成时不接受关闭请求，避免用户以为目标已经保存。
    if (!open && saveGoal.isPending) return;
    setIsDialogOpen(open);
  };

  const handleSaveGoal = async () => {
    const nextGoal = parsedGoalInput;
    // 超过上限属于永久性校验失败：对话框里已经给出提示，这里直接返回，不发请求。
    if (nextGoal === null) return;
    setHasSaveFailed(false);
    try {
      // 留空表示取消目标（0）；只写入 daily_word_goal，其它产品属性保持不变。
      await saveGoal.mutateAsync(nextGoal);
      setIsDialogOpen(false);
      toast.success(t("home.dailyGoalSaved"));
    } catch {
      setHasSaveFailed(true);
    }
  };

  return (
    <Box className="writing-stat-card">
      <Flex
        align="center"
        justify="between"
        gap="2"
      >
        <Flex
          align="center"
          gap="2"
        >
          <Target
            size={14}
            color="var(--gray-11)"
            aria-hidden="true"
          />
          <Text
            size="2"
            color="gray"
          >
            {t("home.dailyGoal")}
          </Text>
        </Flex>
        {/* 读取成功前不允许编辑，避免用空值覆盖已保存的目标。 */}
        <Tooltip content={t("home.dailyGoalEdit")}>
          <IconButton
            size="1"
            variant="ghost"
            color="gray"
            disabled={!profile}
            aria-label={t("home.dailyGoalEdit")}
            onClick={handleOpenDialog}
          >
            <Pencil
              size={13}
              aria-hidden="true"
            />
          </IconButton>
        </Tooltip>
      </Flex>

      {/* 目标按项目保存，卡片里必须标出是哪个项目；标题过长时截断并保留完整提示。 */}
      <Text
        size="1"
        color="gray"
        truncate
        title={project.title}
        style={{ maxWidth: 160 }}
      >
        {project.title}
      </Text>

      {hasProfileLoadFailed ? (
        <Flex
          direction="column"
          align="start"
          gap="2"
        >
          <Text
            size="1"
            color="red"
          >
            {t("home.dailyGoalProfileFailed")}
          </Text>
          {/* 读取失败时用同一个查询重试，而不是让编辑入口一直不可用。 */}
          <Button
            size="1"
            variant="soft"
            color="gray"
            loading={isProfileFetching}
            onClick={() => void refetchProfile()}
          >
            <RefreshCw
              size={13}
              aria-hidden="true"
            />
            {t("home.dailyGoalProfileRetry")}
          </Button>
        </Flex>
      ) : dailyWordGoal > 0 ? (
        <>
          <Text
            size="5"
            weight="medium"
          >
            {todayStats
              ? t("home.dailyGoalProgress", {
                  current: todayStats.wordDelta.toLocaleString(),
                  target: dailyWordGoal.toLocaleString(),
                })
              : "--"}
          </Text>
          {/* 没有真实数字时不画进度条：0% 会被读成「今天一个字都没写」。 */}
          {progressPercent === null ? null : (
            <Progress
              value={progressPercent}
              size="1"
            />
          )}
          {hasTodayStatsLoadFailed ? (
            <Text
              size="1"
              color="red"
            >
              {t("home.dailyGoalStatsFailed")}
            </Text>
          ) : null}
        </>
      ) : (
        <Text
          size="5"
          weight="medium"
          color="gray"
        >
          {profile ? t("home.dailyGoalUnset") : "--"}
        </Text>
      )}

      <Dialog.Root
        open={isDialogOpen}
        onOpenChange={handleDialogOpenChange}
      >
        <Dialog.Content maxWidth="380px">
          <Dialog.Title>{t("home.dailyGoalTitle")}</Dialog.Title>
          <Dialog.Description
            size="2"
            color="gray"
          >
            {t("home.dailyGoalDescription", { title: project.title })}
          </Dialog.Description>

          <Flex
            direction="column"
            gap="2"
            mt="4"
          >
            <Text
              size="2"
              weight="medium"
            >
              {t("home.dailyGoalLabel")}
            </Text>
            <TextField.Root
              aria-label={t("home.dailyGoalLabel")}
              placeholder={t("home.dailyGoalPlaceholder")}
              inputMode="numeric"
              value={goalInput}
              onChange={(event) => setGoalInput(event.target.value.replace(/[^0-9]/g, ""))}
            />
            {isGoalInputTooLarge ? (
              <Text
                size="1"
                color="red"
              >
                {t("home.dailyGoalTooLarge", { max: MAX_DAILY_WORD_GOAL.toLocaleString() })}
              </Text>
            ) : hasSaveFailed ? (
              <Text
                size="1"
                color="red"
              >
                {t("home.dailyGoalSaveFailed")}
              </Text>
            ) : null}
          </Flex>

          <Flex
            gap="3"
            mt="5"
            justify="end"
          >
            <Dialog.Close>
              <Button
                variant="soft"
                color="gray"
                disabled={saveGoal.isPending}
              >
                {t("common.cancel")}
              </Button>
            </Dialog.Close>
            <Button
              loading={saveGoal.isPending}
              disabled={saveGoal.isPending || isGoalInputTooLarge}
              onClick={() => void handleSaveGoal()}
            >
              {t("common.save")}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Box>
  );
}

interface WritingStatCardsProps {
  /** 首页正在续写的项目；每日目标按项目保存，没有最近项目时就没有可展示的目标。 */
  project?: RecentProject;
}

export function WritingStatCards({ project }: WritingStatCardsProps) {
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
      {project ? (
        <DailyGoalCard
          key={project.projectId}
          project={project}
        />
      ) : null}
    </Flex>
  );
}
