/**
 * ProjectFormDialog Component
 *
 * 创建/编辑项目对话框，使用 React Hook Form + Zod 验证，支持封面上传。
 */

import { zodResolver } from "@hookform/resolvers/zod";
import { Dialog, Button, Flex, Select, Text, TextField, TextArea, Box } from "@radix-ui/themes";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import type { Project, ProjectProfile } from "@/lib/project.types";

import { PROJECT_GENRES } from "../lib/project-genres";
import { CoverCropper } from "./cover-cropper";

import "./project-form-dialog.css";

interface ProjectFormSubmitData {
  title: string;
  description?: string;
  cover?: File | null;
  genre?: string;
  targetWordCount?: number;
}

interface ProjectFormDialogProps {
  /** 是否打开对话框 */
  open: boolean;
  /** 关闭对话框回调 */
  onOpenChange: (open: boolean) => void;
  /** 提交表单回调；返回 Promise 时，对话框会等待整笔创建/更新事务完成 */
  onSubmit: (data: ProjectFormSubmitData) => void | Promise<void>;
  /** 编辑模式时传入现有项目 */
  project?: Project | null;
  /** 编辑模式时传入现有产品属性 */
  profile?: ProjectProfile | null;
  /** 产品属性是否仍在加载（加载完成前不提交类型与预计字数，避免覆盖已保存的值） */
  profileLoading?: boolean;
  /** 编辑模式下产品属性读取失败时重试 */
  onRetryProfile?: () => void;
  /** 是否处于加载状态 */
  loading?: boolean;
}

/** 未打开对话框时的会话标记；打开后按项目 id 或新建会话区分。 */
const NO_PROFILE_SESSION = null;
const CREATE_PROFILE_SESSION = "create";

export function ProjectFormDialog({
  open,
  onOpenChange,
  onSubmit,
  project,
  profile,
  profileLoading = false,
  onRetryProfile,
  loading = false,
}: ProjectFormDialogProps) {
  const { t } = useTranslation();
  const isEditMode = !!project;
  const projectId = project?.id ?? null;
  const isProfilePending = Boolean(projectId) && profileLoading;
  // 只有确实属于当前项目的产品属性才算读取成功：查询失败后 pending 会变为 false，
  // 此时既不能继续显示加载状态，也不能把空值当成用户意图提交。
  const hasLoadedProfile = Boolean(projectId) && profile?.projectId === projectId;
  const isProfileUnavailable = Boolean(projectId) && !profileLoading && !hasLoadedProfile;
  const isProfileBlocked = isProfilePending || isProfileUnavailable;
  const [cover, setCover] = useState<File | null>(null);
  const [genre, setGenre] = useState<string>("");
  const [targetWordCount, setTargetWordCount] = useState<string>("");
  // 已填充过产品属性的项目：后台刷新/重新读取不会覆盖用户正在编辑的值。
  const hydratedProfileProjectIdRef = useRef<string | null>(null);
  const profileSessionRef = useRef<string | null>(NO_PROFILE_SESSION);
  // 同步拦截重复提交（Enter、双击、产品属性保存期间的二次提交）。
  const isSubmittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isBusy = isSubmitting || loading;

  /** 表单验证 Schema */
  const projectFormSchema = z.object({
    title: z
      .string()
      .min(1, t("projectForm.titleRequired"))
      .max(200, t("projectForm.titleTooLong")),
    description: z.string().optional(),
  });

  type ProjectFormData = z.infer<typeof projectFormSchema>;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ProjectFormData>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: {
      title: "",
      description: "",
    },
  });

  // 编辑模式时填充表单
  useEffect(() => {
    if (open && project) {
      reset({
        title: project.title,
        description: project.description ?? "",
      });
    } else if (open && !project) {
      reset({
        title: "",
        description: "",
      });
    }
  }, [open, project, reset]);

  // 打开或切换项目时先清空，避免沿用上一个项目的残留值；
  // 产品属性只在首次读取成功时填充，之后的后台刷新不覆盖用户编辑。
  const profileSession = open ? (projectId ?? CREATE_PROFILE_SESSION) : NO_PROFILE_SESSION;

  useEffect(() => {
    // 逐会话的表单值（封面、类型、预计字数）与「已填充」标记一起清空。
    const clearSessionValues = () => {
      hydratedProfileProjectIdRef.current = null;
      setCover(null);
      setGenre("");
      setTargetWordCount("");
    };

    if (profileSession === NO_PROFILE_SESSION) {
      // 关闭即结束当前会话。父组件在保存成功后会直接关闭对话框（不经过 handleOpenChange），
      // 所以这里必须把会话标记一起复位：否则下一次「新建项目」会重新命中同一个 "create"
      // 会话，沿用上一次填写的类型与预计字数。
      profileSessionRef.current = NO_PROFILE_SESSION;
      clearSessionValues();
      return;
    }

    if (profileSessionRef.current !== profileSession) {
      // 新建 -> 编辑、编辑 A -> 编辑 B：会话切换后从空值重新开始。
      profileSessionRef.current = profileSession;
      clearSessionValues();
    }

    if (!projectId || !hasLoadedProfile) return;
    if (hydratedProfileProjectIdRef.current === projectId) return;

    hydratedProfileProjectIdRef.current = projectId;
    setGenre(profile?.genre ?? "");
    setTargetWordCount(
      profile && profile.targetWordCount > 0 ? String(profile.targetWordCount) : "",
    );
  }, [profileSession, projectId, hasLoadedProfile, profile]);

  const handleOpenChange = (nextOpen: boolean) => {
    // 创建/更新（含产品属性保存）完成前不接受关闭请求，避免事务被中途打断。
    if (!nextOpen && isBusy) return;

    if (!nextOpen) {
      setCover(null);
      setGenre("");
      setTargetWordCount("");
      reset({
        title: "",
        description: "",
      });
    }

    onOpenChange(nextOpen);
  };

  const handleFormSubmit = handleSubmit(async (data) => {
    // 同一笔事务完成前只允许提交一次：产品属性 PUT 在途时 loading 可能已回到 false，
    // 若没有这道同步防线，Enter 或双击会再次创建同一个项目。
    if (isSubmittingRef.current) return;

    isSubmittingRef.current = true;
    setIsSubmitting(true);

    const parsedTarget = Number.parseInt(targetWordCount, 10);
    try {
      await onSubmit({
        ...data,
        cover,
        // 产品属性未成功读取时保持原值不变，避免用空值覆盖已保存的设置。
        ...(isEditMode && !hasLoadedProfile
          ? {}
          : {
              genre,
              targetWordCount:
                Number.isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : 0,
            }),
      });
    } catch {
      // 失败提示由调用方负责；这里只保证提交状态回到可重试。
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  });

  return (
    <Dialog.Root
      open={open}
      onOpenChange={handleOpenChange}
      key={open ? "open" : "closed"}
    >
      <Dialog.Content maxWidth="600px">
        <Dialog.Title>
          {isEditMode ? t("projectForm.editProject") : t("projectForm.newProject")}
        </Dialog.Title>
        <Dialog.Description
          size="2"
          color="gray"
        >
          {isEditMode ? t("projectForm.editDescription") : t("projectForm.createDescription")}
        </Dialog.Description>

        <form onSubmit={handleFormSubmit}>
          <Flex
            gap="5"
            mt="4"
            className="project-form-dialog-fields"
          >
            {/* 左侧：封面 */}
            <Box className="project-form-dialog-cover">
              <CoverCropper
                value={cover}
                onChange={setCover}
                previewUrl={project?.coverUrl}
              />
            </Box>

            {/* 右侧：项目信息 */}
            <Flex
              direction="column"
              gap="4"
              style={{ flex: 1, minWidth: 0 }}
            >
              {/* 标题 */}
              <Box>
                <Text
                  as="label"
                  size="2"
                  weight="medium"
                  mb="1"
                  style={{ display: "block" }}
                >
                  {t("projectForm.titleLabel")} <Text color="red">*</Text>
                </Text>
                <TextField.Root
                  placeholder={t("projectForm.titlePlaceholder")}
                  {...register("title")}
                />
                {errors.title && (
                  <Text
                    size="1"
                    color="red"
                    mt="1"
                  >
                    {errors.title.message}
                  </Text>
                )}
              </Box>

              {/* 简介 */}
              <Box>
                <Text
                  as="label"
                  size="2"
                  weight="medium"
                  mb="1"
                  style={{ display: "block" }}
                >
                  {t("projectForm.descriptionLabel")}
                </Text>
                <TextArea
                  placeholder={t("projectForm.descriptionPlaceholder")}
                  rows={5}
                  {...register("description")}
                />
              </Box>

              {/* 类型 */}
              <Box>
                <Text
                  as="label"
                  size="2"
                  weight="medium"
                  mb="1"
                  style={{ display: "block" }}
                >
                  {t("projectForm.genreLabel")}
                </Text>
                <Select.Root
                  value={genre || "unset"}
                  disabled={isProfileBlocked}
                  onValueChange={(value) => setGenre(value === "unset" ? "" : value)}
                >
                  <Select.Trigger
                    variant="surface"
                    style={{ width: "100%" }}
                    aria-label={t("projectForm.genreLabel")}
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

              {/* 预计字数 */}
              <Box>
                <Text
                  as="label"
                  size="2"
                  weight="medium"
                  mb="1"
                  style={{ display: "block" }}
                >
                  {t("projectForm.targetWordCountLabel")}
                </Text>
                <TextField.Root
                  value={targetWordCount}
                  inputMode="numeric"
                  disabled={isProfileBlocked}
                  placeholder={t("projectForm.targetWordCountPlaceholder")}
                  onChange={(event) =>
                    setTargetWordCount(event.target.value.replace(/[^0-9]/g, ""))
                  }
                />
              </Box>

              {/* 产品属性读取失败：明确提示并提供重试，而不是停留在假的加载状态 */}
              {isProfileUnavailable && (
                <Flex
                  align="center"
                  justify="between"
                  gap="2"
                  wrap="wrap"
                >
                  <Text
                    size="1"
                    color="red"
                    style={{ flex: 1, minWidth: "160px" }}
                  >
                    {t("projectForm.profileUnavailable")}
                  </Text>
                  {onRetryProfile ? (
                    <Button
                      type="button"
                      size="1"
                      variant="soft"
                      color="gray"
                      onClick={onRetryProfile}
                    >
                      {t("projectForm.profileRetry")}
                    </Button>
                  ) : null}
                </Flex>
              )}
            </Flex>
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
                disabled={isBusy}
              >
                {t("common.cancel")}
              </Button>
            </Dialog.Close>
            <Button
              type="submit"
              loading={isBusy}
              disabled={isBusy}
            >
              {isEditMode ? t("common.save") : t("common.create")}
            </Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
