import { Box, Button, Checkbox, Dialog, Flex, Select, Text, TextArea, TextField } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  BookOpenText,
  ExternalLink,
  Lightbulb,
  RefreshCw,
  Sparkles,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { toast } from "@/components";
import { ImportDialog } from "@/features/projects/components/import-dialog";
import { ProjectFormDialog } from "@/features/projects/components/project-form-dialog";
import { PROJECT_GENRES } from "@/features/projects/lib/project-genres";
import { useCreateProject, useProjects } from "@/features/projects";
import { isBackgroundModelUnavailableError, readHttpErrorDetail } from "@/lib/ai-error";
import {
  apiClient,
  createCharacter,
  createProject,
  createWorldInfoEntry,
  fetchModels,
  fetchWorldInfoByProject,
  updateCharacterProfile,
  updateProjectProfile,
} from "@/lib/api-client";

import { hasCompletedOnboarding, markOnboardingCompleted } from "../lib/onboarding-state";

import "./onboarding-wizard.css";

type WizardStep = "welcome" | "start" | "ai" | "inspire";

// ============================================
// AI 辅助搭建（PRD §5）：输入灵感 → 生成草案 → 逐项确认 → 创建后写入
//
// 生成阶段只调用 /story-setup/draft 并展示草案，不写入任何数据；
// 只有用户点击「创建项目并保存所选内容」后，才通过既有 API 逐项持久化。
// ============================================

/** 与后端 MaxStorySetupDraftInspiration 保持一致。 */
const MAX_INSPIRATION_CHARS = 6000;

type StorySetupItemKey =
  | "synopsis"
  | "world_background"
  | "protagonist"
  | "core_conflict"
  | "initial_outline";

const STORY_SETUP_ITEM_I18N: Record<StorySetupItemKey, string> = {
  synopsis: "synopsis",
  world_background: "worldBackground",
  protagonist: "protagonist",
  core_conflict: "coreConflict",
  initial_outline: "initialOutline",
};

interface StorySetupProtagonistDraft {
  name: string;
  description: string;
  identity: string;
  motivation: string;
  goal: string;
}

interface StorySetupOutlineItem {
  title: string;
  content: string;
}

interface StorySetupDraft {
  title: string | null;
  genre: string | null;
  synopsis: string | null;
  world_background: string | null;
  protagonist: StorySetupProtagonistDraft | null;
  core_conflict: string | null;
  initial_outline: StorySetupOutlineItem[];
  model: string;
}

/** 持久化进度：已成功的写入会记录 ID，重试时跳过，避免重复创建。 */
interface StorySetupProgress {
  projectId?: string;
  profileDone?: boolean;
  worldEntryId?: string;
  characterId?: string;
  characterProfileDone?: boolean;
  conflictOutlineId?: string;
  initialOutlineId?: string;
}

interface StorySetupSelection {
  synopsis: string;
  worldBackground: string;
  protagonist: StorySetupProtagonistDraft;
  coreConflict: string;
  initialOutline: string;
}

async function generateStorySetupDraft(inspiration: string): Promise<StorySetupDraft> {
  const response = await apiClient.post<StorySetupDraft>(
    "/story-setup/draft",
    { inspiration },
    { timeout: 180000 },
  );
  return response.data;
}

/** 把草案里的结构化大纲条目拍平成可编辑文本（每条「标题换行内容」）。 */
function outlineItemsToText(items: StorySetupOutlineItem[]): string {
  return items
    .map((item) => [item.title.trim(), item.content.trim()].filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n\n");
}

async function createOutlineNode(
  projectId: string,
  title: string,
  content: string,
): Promise<string> {
  const response = await apiClient.post<{ id: string }>(`/projects/${projectId}/outlines`, {
    level: "book",
    title,
    content,
    parent_id: null,
    volume_id: null,
    chapter_id: null,
  });
  return response.data.id;
}

/**
 * 按用户确认的条目写入项目。
 *
 * 使用调用方传入的 progress 对象记录已完成步骤，失败后再次调用只补做未完成部分，
 * 不会重复创建已存在的项目 / 人物 / 世界观条目 / 大纲节点。
 */
async function persistStorySetup(params: {
  title: string;
  genre: string;
  targetWordCount: number;
  accepted: Record<StorySetupItemKey, boolean>;
  selection: StorySetupSelection;
  progress: StorySetupProgress;
}): Promise<{ progress: StorySetupProgress; failed: StorySetupItemKey[]; error: string | null }> {
  const { progress, accepted, selection } = params;
  const failed: StorySetupItemKey[] = [];
  let error: string | null = null;

  if (!progress.projectId) {
    try {
      const project = await createProject({ title: params.title, description: null });
      progress.projectId = project.id;
    } catch {
      return { progress, failed, error: "project" };
    }
  }
  const projectId = progress.projectId;
  if (!projectId) {
    return { progress, failed, error: "project" };
  }

  if (!progress.profileDone) {
    try {
      await updateProjectProfile(projectId, {
        genre: params.genre,
        synopsis: accepted.synopsis ? selection.synopsis : "",
        targetWordCount: params.targetWordCount,
      });
      progress.profileDone = true;
    } catch {
      error = "profile";
    }
  }

  if (accepted.world_background && !progress.worldEntryId && selection.worldBackground) {
    try {
      const worldInfo = await fetchWorldInfoByProject(projectId);
      const entry = await createWorldInfoEntry(worldInfo.id, {
        name: "世界背景",
        content: selection.worldBackground,
      });
      progress.worldEntryId = entry.id;
    } catch {
      failed.push("world_background");
    }
  }

  if (accepted.protagonist && selection.protagonist.name) {
    if (!progress.characterId) {
      try {
        const character = await createCharacter(projectId, {
          name: selection.protagonist.name,
          description: selection.protagonist.description,
        });
        progress.characterId = character.id;
      } catch {
        failed.push("protagonist");
      }
    }
    if (progress.characterId && !progress.characterProfileDone) {
      try {
        await updateCharacterProfile(progress.characterId, {
          alias: "",
          age: "",
          gender: "",
          identity: selection.protagonist.identity,
          faction: "",
          personality: "",
          appearance: "",
          background: selection.protagonist.description,
          goal: selection.protagonist.goal,
          motivation: selection.protagonist.motivation,
          fear: "",
          secret: "",
          abilities: "",
          weakness: "",
          arc: "",
        });
        progress.characterProfileDone = true;
      } catch {
        failed.push("protagonist");
      }
    }
  }

  if (accepted.core_conflict && !progress.conflictOutlineId && selection.coreConflict) {
    try {
      progress.conflictOutlineId = await createOutlineNode(
        projectId,
        "核心冲突",
        selection.coreConflict,
      );
    } catch {
      failed.push("core_conflict");
    }
  }

  if (accepted.initial_outline && !progress.initialOutlineId && selection.initialOutline) {
    try {
      progress.initialOutlineId = await createOutlineNode(
        projectId,
        "初始大纲",
        selection.initialOutline,
      );
    } catch {
      failed.push("initial_outline");
    }
  }

  return { progress, failed: Array.from(new Set(failed)), error };
}

interface StorySetupPanelProps {
  onBack: () => void;
  onUseBlankCreate: () => void;
  onOpenProject: (projectId: string) => void;
}

function draftItemPresent(draft: StorySetupDraft | null, key: StorySetupItemKey): boolean {
  if (!draft) return false;
  switch (key) {
    case "synopsis":
      return draft.synopsis !== null;
    case "world_background":
      return draft.world_background !== null;
    case "protagonist":
      return draft.protagonist !== null;
    case "core_conflict":
      return draft.core_conflict !== null;
    case "initial_outline":
      return draft.initial_outline.length > 0;
  }
}

function StorySetupPanel({ onBack, onUseBlankCreate, onOpenProject }: StorySetupPanelProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"input" | "review">("input");
  const [inspiration, setInspiration] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [draft, setDraft] = useState<StorySetupDraft | null>(null);

  const [accepted, setAccepted] = useState<Record<StorySetupItemKey, boolean>>({
    synopsis: false,
    world_background: false,
    protagonist: false,
    core_conflict: false,
    initial_outline: false,
  });
  const [synopsis, setSynopsis] = useState("");
  const [worldBackground, setWorldBackground] = useState("");
  const [protagonistName, setProtagonistName] = useState("");
  const [protagonistDescription, setProtagonistDescription] = useState("");
  const [protagonistIdentity, setProtagonistIdentity] = useState("");
  const [protagonistGoal, setProtagonistGoal] = useState("");
  const [protagonistMotivation, setProtagonistMotivation] = useState("");
  const [coreConflict, setCoreConflict] = useState("");
  const [initialOutline, setInitialOutline] = useState("");

  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [targetWordCount, setTargetWordCount] = useState("");

  const [saving, setSaving] = useState(false);
  const [failedItems, setFailedItems] = useState<StorySetupItemKey[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const progressRef = useRef<StorySetupProgress>({});

  const locked = projectId !== null;
  const selectedItemKeys = (Object.keys(accepted) as StorySetupItemKey[]).filter(
    (key) => accepted[key] && draftItemPresent(draft, key),
  );

  const handleGenerate = async () => {
    const text = inspiration.trim();
    if (!text || generating) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const next = await generateStorySetupDraft(text);
      const outlineText = outlineItemsToText(next.initial_outline);
      setDraft(next);
      setAccepted({
        synopsis: next.synopsis !== null,
        world_background: next.world_background !== null,
        protagonist: next.protagonist !== null,
        core_conflict: next.core_conflict !== null,
        initial_outline: outlineText.length > 0,
      });
      setSynopsis(next.synopsis ?? "");
      setWorldBackground(next.world_background ?? "");
      setProtagonistName(next.protagonist?.name ?? "");
      setProtagonistDescription(next.protagonist?.description ?? "");
      setProtagonistIdentity(next.protagonist?.identity ?? "");
      setProtagonistGoal(next.protagonist?.goal ?? "");
      setProtagonistMotivation(next.protagonist?.motivation ?? "");
      setCoreConflict(next.core_conflict ?? "");
      setInitialOutline(outlineText);
      if (next.title && !title.trim()) setTitle(next.title.trim());
      if (next.genre && PROJECT_GENRES.includes(next.genre)) setGenre(next.genre);
      setPhase("review");
    } catch (error) {
      setGenerateError(
        isBackgroundModelUnavailableError(error)
          ? t("onboarding.storySetup.modelMissing")
          : t("onboarding.storySetup.generateFailed", {
              reason: readHttpErrorDetail(error) ?? t("onboarding.storySetup.unknownError"),
            }),
      );
    } finally {
      setGenerating(false);
    }
  };

  const handleCreate = async () => {
    if (!title.trim()) {
      setSaveError("title");
      return;
    }
    setSaving(true);
    setSaveError(null);
    const parsedTarget = Number.parseInt(targetWordCount, 10);
    try {
      const result = await persistStorySetup({
        title: title.trim(),
        genre,
        targetWordCount: Number.isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : 0,
        accepted,
        selection: {
          synopsis: synopsis.trim(),
          worldBackground: worldBackground.trim(),
          protagonist: {
            name: protagonistName.trim(),
            description: protagonistDescription.trim(),
            identity: protagonistIdentity.trim(),
            goal: protagonistGoal.trim(),
            motivation: protagonistMotivation.trim(),
          },
          coreConflict: coreConflict.trim(),
          initialOutline: initialOutline.trim(),
        },
        progress: progressRef.current,
      });
      setProjectId(result.progress.projectId ?? null);
      setFailedItems(result.failed);
      setSaveError(result.error);
      if (result.progress.projectId && !result.error && result.failed.length === 0) {
        onOpenProject(result.progress.projectId);
      }
    } finally {
      setSaving(false);
    }
  };

  const renderItemBlock = (key: StorySetupItemKey, label: string, body: ReactNode) => (
    <Box
      key={key}
      className="onboarding-story-item"
    >
      <Flex
        align="center"
        gap="2"
      >
        <Checkbox
          checked={accepted[key]}
          disabled={locked}
          aria-label={label}
          onCheckedChange={(checked) =>
            setAccepted((previous) => ({ ...previous, [key]: checked === true }))
          }
        />
        <Text
          size="3"
          weight="medium"
        >
          {label}
        </Text>
      </Flex>
      <Box className="onboarding-story-item-body">{body}</Box>
    </Box>
  );

  const partialMessage =
    failedItems.length > 0
      ? t("onboarding.storySetup.partialSaved", {
          items: failedItems
            .map((key) => t(`onboarding.storySetup.item.${STORY_SETUP_ITEM_I18N[key]}`))
            .join(t("onboarding.storySetup.itemSeparator")),
        })
      : t("onboarding.storySetup.createFailed");

  if (phase === "input") {
    return (
      <Flex
        direction="column"
        gap="3"
        className="onboarding-step"
      >
        <Text
          size="5"
          weight="medium"
        >
          {t("onboarding.storySetup.title")}
        </Text>
        <Text
          size="2"
          color="gray"
        >
          {t("onboarding.storySetup.intro")}
        </Text>
        <Box>
          <Text
            as="label"
            size="2"
            weight="medium"
            mb="1"
            style={{ display: "block" }}
          >
            {t("onboarding.storySetup.inspirationLabel")}
          </Text>
          <TextArea
            value={inspiration}
            rows={5}
            maxLength={MAX_INSPIRATION_CHARS}
            disabled={generating}
            placeholder={t("onboarding.storySetup.inspirationPlaceholder")}
            onChange={(event) => setInspiration(event.target.value)}
          />
          <Text
            size="1"
            color="gray"
          >
            {t("onboarding.storySetup.charCount", {
              count: inspiration.length,
              max: MAX_INSPIRATION_CHARS,
            })}
          </Text>
        </Box>
        {generateError ? (
          <Flex
            gap="2"
            align="start"
            className="onboarding-story-error"
          >
            <AlertCircle
              size={16}
              aria-hidden="true"
            />
            <Text size="2">{generateError}</Text>
          </Flex>
        ) : null}
        <Flex
          justify="between"
          align="center"
          mt="1"
        >
          <Button
            size="2"
            variant="ghost"
            color="gray"
            disabled={generating}
            onClick={onBack}
          >
            <ArrowLeft
              size={16}
              aria-hidden="true"
            />
            {t("common.back")}
          </Button>
          <Flex gap="2">
            {generateError ? (
              <Button
                size="2"
                variant="soft"
                color="gray"
                onClick={onUseBlankCreate}
              >
                {t("onboarding.storySetup.backToCreate")}
              </Button>
            ) : null}
            <Button
              size="2"
              loading={generating}
              disabled={!inspiration.trim()}
              onClick={() => void handleGenerate()}
            >
              <Sparkles
                size={16}
                aria-hidden="true"
              />
              {t("onboarding.storySetup.generate")}
            </Button>
          </Flex>
        </Flex>
      </Flex>
    );
  }

  return (
    <Flex
      direction="column"
      gap="3"
      className="onboarding-step"
    >
      <Flex
        justify="between"
        align="center"
      >
        <Text
          size="5"
          weight="medium"
        >
          {t("onboarding.storySetup.reviewTitle")}
        </Text>
        <Text
          size="1"
          color="gray"
        >
          {t("onboarding.storySetup.model", { model: draft?.model ?? "" })}
        </Text>
      </Flex>
      <Text
        size="2"
        color="gray"
      >
        {t("onboarding.storySetup.reviewHint")}
      </Text>

      <Flex
        direction="column"
        gap="3"
        className="onboarding-story-items"
      >
        {draft?.synopsis !== null && draft
          ? renderItemBlock(
              "synopsis",
              t("onboarding.storySetup.item.synopsis"),
              <TextArea
                value={synopsis}
                rows={3}
                disabled={locked}
                onChange={(event) => setSynopsis(event.target.value)}
              />,
            )
          : null}
        {draft?.world_background !== null && draft
          ? renderItemBlock(
              "world_background",
              t("onboarding.storySetup.item.worldBackground"),
              <TextArea
                value={worldBackground}
                rows={5}
                disabled={locked}
                onChange={(event) => setWorldBackground(event.target.value)}
              />,
            )
          : null}
        {draft?.protagonist !== null && draft
          ? renderItemBlock(
              "protagonist",
              t("onboarding.storySetup.item.protagonist"),
              <>
                <TextField.Root
                  value={protagonistName}
                  disabled={locked}
                  placeholder={t("onboarding.storySetup.protagonistNamePlaceholder")}
                  aria-label={t("onboarding.storySetup.protagonistName")}
                  onChange={(event) => setProtagonistName(event.target.value)}
                />
                <TextArea
                  value={protagonistDescription}
                  rows={3}
                  disabled={locked}
                  placeholder={t("onboarding.storySetup.protagonistDescription")}
                  aria-label={t("onboarding.storySetup.protagonistDescription")}
                  onChange={(event) => setProtagonistDescription(event.target.value)}
                />
                <TextField.Root
                  value={protagonistIdentity}
                  disabled={locked}
                  placeholder={t("onboarding.storySetup.protagonistIdentity")}
                  aria-label={t("onboarding.storySetup.protagonistIdentity")}
                  onChange={(event) => setProtagonistIdentity(event.target.value)}
                />
                <TextField.Root
                  value={protagonistGoal}
                  disabled={locked}
                  placeholder={t("onboarding.storySetup.protagonistGoal")}
                  aria-label={t("onboarding.storySetup.protagonistGoal")}
                  onChange={(event) => setProtagonistGoal(event.target.value)}
                />
                <TextArea
                  value={protagonistMotivation}
                  rows={2}
                  disabled={locked}
                  placeholder={t("onboarding.storySetup.protagonistMotivation")}
                  aria-label={t("onboarding.storySetup.protagonistMotivation")}
                  onChange={(event) => setProtagonistMotivation(event.target.value)}
                />
              </>,
            )
          : null}
        {draft?.core_conflict !== null && draft
          ? renderItemBlock(
              "core_conflict",
              t("onboarding.storySetup.item.coreConflict"),
              <TextArea
                value={coreConflict}
                rows={4}
                disabled={locked}
                onChange={(event) => setCoreConflict(event.target.value)}
              />,
            )
          : null}
        {draft && draft.initial_outline.length > 0
          ? renderItemBlock(
              "initial_outline",
              t("onboarding.storySetup.item.initialOutline"),
              <TextArea
                value={initialOutline}
                rows={5}
                disabled={locked}
                onChange={(event) => setInitialOutline(event.target.value)}
              />,
            )
          : null}
        {selectedItemKeys.length === 0 ? (
          <Text
            size="1"
            color="gray"
          >
            {t("onboarding.storySetup.nothingSelected")}
          </Text>
        ) : null}
      </Flex>

      <Flex
        direction="column"
        gap="3"
        className="onboarding-story-meta"
      >
        <Text
          size="4"
          weight="medium"
        >
          {t("onboarding.storySetup.projectSection")}
        </Text>
        <Box>
          <Text
            as="label"
            size="2"
            weight="medium"
            mb="1"
            style={{ display: "block" }}
          >
            {t("onboarding.storySetup.projectTitle")} <Text color="red">*</Text>
          </Text>
          <TextField.Root
            value={title}
            disabled={locked}
            placeholder={t("onboarding.storySetup.projectTitlePlaceholder")}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Box>
        <Flex gap="3">
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Text
              as="label"
              size="2"
              weight="medium"
              mb="1"
              style={{ display: "block" }}
            >
              {t("onboarding.storySetup.genre")}
            </Text>
            <Select.Root
              value={genre || "unset"}
              disabled={locked}
              onValueChange={(value) => setGenre(value === "unset" ? "" : value)}
            >
              <Select.Trigger
                variant="surface"
                style={{ width: "100%" }}
                aria-label={t("onboarding.storySetup.genre")}
              />
              <Select.Content>
                <Select.Item value="unset">{t("projectForm.genreUnset")}</Select.Item>
                {PROJECT_GENRES.map((value) => (
                  <Select.Item
                    key={value}
                    value={value}
                  >
                    {t(`projectForm.genres.${value}`)}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Box>
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Text
              as="label"
              size="2"
              weight="medium"
              mb="1"
              style={{ display: "block" }}
            >
              {t("onboarding.storySetup.targetWordCount")}
            </Text>
            <TextField.Root
              value={targetWordCount}
              inputMode="numeric"
              disabled={locked}
              placeholder={t("projectForm.targetWordCountPlaceholder")}
              onChange={(event) =>
                setTargetWordCount(event.target.value.replace(/[^0-9]/g, ""))
              }
            />
          </Box>
        </Flex>
      </Flex>

      {saveError || failedItems.length > 0 ? (
        <Flex
          direction="column"
          gap="2"
          className="onboarding-story-error"
        >
          <Flex
            gap="2"
            align="start"
          >
            <AlertCircle
              size={16}
              aria-hidden="true"
            />
            <Text size="2">
              {saveError === "title"
                ? t("onboarding.storySetup.projectTitleRequired")
                : saveError === "profile"
                  ? t("onboarding.storySetup.profileFailed")
                  : partialMessage}
            </Text>
          </Flex>
          {projectId ? (
            <Flex gap="2">
              <Button
                size="2"
                variant="soft"
                disabled={saving}
                onClick={() => void handleCreate()}
              >
                <RefreshCw
                  size={16}
                  aria-hidden="true"
                />
                {t("onboarding.storySetup.retry")}
              </Button>
              <Button
                size="2"
                variant="soft"
                color="gray"
                onClick={() => onOpenProject(projectId)}
              >
                <ExternalLink
                  size={16}
                  aria-hidden="true"
                />
                {t("onboarding.storySetup.openProject")}
              </Button>
            </Flex>
          ) : null}
        </Flex>
      ) : null}

      <Flex
        justify="between"
        align="center"
        mt="1"
      >
        <Button
          size="2"
          variant="ghost"
          color="gray"
          disabled={saving || locked}
          onClick={() => setPhase("input")}
        >
          <ArrowLeft
            size={16}
            aria-hidden="true"
          />
          {t("onboarding.storySetup.regenerate")}
        </Button>
        <Flex gap="2">
          {!locked ? (
            <Button
              size="2"
              variant="soft"
              color="gray"
              disabled={saving}
              onClick={onUseBlankCreate}
            >
              {t("onboarding.storySetup.backToCreate")}
            </Button>
          ) : null}
          <Button
            size="2"
            loading={saving}
            disabled={locked && failedItems.length === 0 && !saveError}
            onClick={() => void handleCreate()}
          >
            {t("onboarding.storySetup.create")}
          </Button>
        </Flex>
      </Flex>
    </Flex>
  );
}

export function OnboardingWizard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [completed, setCompleted] = useState(() => hasCompletedOnboarding());
  const [step, setStep] = useState<WizardStep>("welcome");
  // 用户一旦主动进入向导，就不再按「已有项目 / 已有模型」自动跳过。
  // 否则「从灵感开始」创建项目后项目数变化会提前关闭向导，打断尚未保存完的搭建结果。
  const [engaged, setEngaged] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const createMutation = useCreateProject();

  const { data: projectsPage, isFetched } = useProjects({ page: 1, pageSize: 1 });
  const { data: models } = useQuery({
    queryKey: ["models", "onboarding"],
    queryFn: fetchModels,
    staleTime: 30_000,
  });

  const hasChatModel = (models ?? []).some((model) => model.taskType === "llm");

  useEffect(() => {
    if (!isFetched || completed || engaged) return;
    if ((projectsPage?.total ?? 0) > 0 || hasChatModel) {
      markOnboardingCompleted();
      setCompleted(true);
    }
  }, [completed, engaged, isFetched, hasChatModel, projectsPage]);

  const beginWizard = () => {
    setEngaged(true);
    setStep("start");
  };

  const finish = () => {
    markOnboardingCompleted();
    setCompleted(true);
  };

  const handleCreateSubmit = async (data: {
    title: string;
    description?: string;
    cover?: File | null;
    genre?: string;
    targetWordCount?: number;
  }) => {
    let project: { id: string };
    try {
      project = await createMutation.mutateAsync({
        title: data.title,
        description: data.description ?? null,
        cover: data.cover ?? null,
      });
    } catch {
      toast.error(t("projects.createFailed"));
      return;
    }

    // 项目已创建：产品属性保存失败属于部分成功，不能提示「创建失败」，
    // 否则用户重试会创建出重复项目。
    let isProfileSaved = true;
    if (data.genre || (data.targetWordCount ?? 0) > 0) {
      try {
        await updateProjectProfile(project.id, {
          genre: data.genre ?? "",
          targetWordCount: data.targetWordCount ?? 0,
        });
      } catch {
        isProfileSaved = false;
      }
    }
    setCreateOpen(false);
    finish();
    if (isProfileSaved) {
      toast.success(t("onboarding.created"));
    } else {
      toast.error(t("projects.profileUpdateFailed"));
    }
    navigate(`/projects/${project.id}`);
  };

  const handleStorySetupCreated = (projectId: string) => {
    finish();
    toast.success(t("onboarding.created"));
    navigate(`/projects/${projectId}`);
  };

  const open = !completed;

  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) finish();
        }}
      >
        <Dialog.Content
          className="onboarding-dialog"
          maxWidth={step === "inspire" ? "760px" : "560px"}
        >
          {step === "welcome" ? (
            <Flex
              direction="column"
              gap="4"
              align="center"
              className="onboarding-step"
            >
              <Box className="onboarding-badge">
                <BookOpenText
                  size={26}
                  aria-hidden="true"
                />
              </Box>
              <Text
                size="6"
                weight="medium"
              >
                {t("onboarding.title")}
              </Text>
              <Text
                size="2"
                color="gray"
                align="center"
              >
                {t("onboarding.subtitle")}
              </Text>
              <Button
                size="3"
                onClick={beginWizard}
              >
                {t("onboarding.begin")}
              </Button>
              <Button
                size="2"
                variant="ghost"
                color="gray"
                onClick={finish}
              >
                {t("onboarding.skip")}
              </Button>
            </Flex>
          ) : null}

          {step === "start" ? (
            <Flex
              direction="column"
              gap="3"
              className="onboarding-step"
            >
              <Text
                size="5"
                weight="medium"
              >
                {t("onboarding.chooseTitle")}
              </Text>
              <button
                type="button"
                className="onboarding-choice"
                onClick={() => setCreateOpen(true)}
              >
                <Sparkles
                  size={18}
                  aria-hidden="true"
                />
                <Box>
                  <Text
                    size="3"
                    weight="medium"
                  >
                    {t("onboarding.create")}
                  </Text>
                  <Text
                    size="1"
                    color="gray"
                  >
                    {t("onboarding.createDesc")}
                  </Text>
                </Box>
              </button>
              <button
                type="button"
                className="onboarding-choice"
                onClick={() => setImportOpen(true)}
              >
                <Upload
                  size={18}
                  aria-hidden="true"
                />
                <Box>
                  <Text
                    size="3"
                    weight="medium"
                  >
                    {t("onboarding.import")}
                  </Text>
                  <Text
                    size="1"
                    color="gray"
                  >
                    {t("onboarding.importDesc")}
                  </Text>
                </Box>
              </button>
              <button
                type="button"
                className="onboarding-choice"
                onClick={() => setStep("inspire")}
              >
                <Lightbulb
                  size={18}
                  aria-hidden="true"
                />
                <Box>
                  <Text
                    size="3"
                    weight="medium"
                  >
                    {t("onboarding.inspire")}
                  </Text>
                  <Text
                    size="1"
                    color="gray"
                  >
                    {t("onboarding.inspireDesc")}
                  </Text>
                </Box>
              </button>
              <Flex
                justify="between"
                align="center"
                mt="1"
              >
                <Button
                  size="2"
                  variant="ghost"
                  color="gray"
                  onClick={() => setStep("ai")}
                >
                  {t("onboarding.connectAI")}
                </Button>
                <Button
                  size="2"
                  variant="ghost"
                  color="gray"
                  onClick={finish}
                >
                  {t("onboarding.skip")}
                </Button>
              </Flex>
            </Flex>
          ) : null}

          {step === "ai" ? (
            <Flex
              direction="column"
              gap="3"
              className="onboarding-step"
            >
              <Text
                size="5"
                weight="medium"
              >
                {t("onboarding.aiTitle")}
              </Text>
              <Text
                size="2"
                color="gray"
              >
                {t("onboarding.aiRecommend")}
              </Text>
              <Text
                size="2"
                color="gray"
              >
                {t("onboarding.aiPath")}
              </Text>
              {hasChatModel ? (
                <Text
                  size="1"
                  color="gray"
                >
                  {t("onboarding.aiAlreadyConfigured")}
                </Text>
              ) : (
                <Text
                  size="1"
                  color="gray"
                >
                  {t("onboarding.aiOptional")}
                </Text>
              )}
              <Flex
                justify="end"
                gap="2"
              >
                <Button
                  size="2"
                  variant="soft"
                  color="gray"
                  onClick={() => setStep("start")}
                >
                  {t("common.back")}
                </Button>
                <Button
                  size="2"
                  onClick={finish}
                >
                  {t("onboarding.gotIt")}
                </Button>
              </Flex>
            </Flex>
          ) : null}

          {step === "inspire" ? (
            <StorySetupPanel
              onBack={() => setStep("start")}
              onUseBlankCreate={() => {
                setStep("start");
                setCreateOpen(true);
              }}
              onOpenProject={handleStorySetupCreated}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Root>

      <ProjectFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        // 返回 Promise，让对话框等待创建与产品属性保存整笔完成后再解除提交锁。
        onSubmit={handleCreateSubmit}
        loading={createMutation.isPending}
      />
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onSuccess={finish}
      />
    </>
  );
}
