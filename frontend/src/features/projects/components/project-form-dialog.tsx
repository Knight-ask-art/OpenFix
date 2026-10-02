/**
 * ProjectFormDialog Component
 *
 * 创建/编辑项目对话框，使用 React Hook Form + Zod 验证，支持封面上传。
 */

import { zodResolver } from "@hookform/resolvers/zod";
import { Dialog, Button, Flex, Select, Text, TextField, TextArea, Box } from "@radix-ui/themes";
import { useEffect, useState } from "react";
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
  /** 提交表单回调 */
  onSubmit: (data: ProjectFormSubmitData) => void;
  /** 编辑模式时传入现有项目 */
  project?: Project | null;
  /** 编辑模式时传入现有产品属性 */
  profile?: ProjectProfile | null;
  /** 产品属性是否仍在加载（加载完成前不提交类型与预计字数，避免覆盖已保存的值） */
  profileLoading?: boolean;
  /** 是否处于加载状态 */
  loading?: boolean;
}

export function ProjectFormDialog({
  open,
  onOpenChange,
  onSubmit,
  project,
  profile,
  profileLoading = false,
  loading = false,
}: ProjectFormDialogProps) {
  const { t } = useTranslation();
  const isEditMode = !!project;
  const isProfilePending = isEditMode && profileLoading;
  const [cover, setCover] = useState<File | null>(null);
  const [genre, setGenre] = useState<string>("");
  const [targetWordCount, setTargetWordCount] = useState<string>("");

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

  useEffect(() => {
    if (!open) return;
    setGenre(profile?.genre ?? "");
    setTargetWordCount(
      profile && profile.targetWordCount > 0 ? String(profile.targetWordCount) : "",
    );
  }, [open, profile]);

  const handleOpenChange = (nextOpen: boolean) => {
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

  const handleFormSubmit = handleSubmit((data) => {
    const parsedTarget = Number.parseInt(targetWordCount, 10);
    onSubmit({
      ...data,
      cover,
      // 产品属性未加载完成时保持原值不变。
      ...(isProfilePending
        ? {}
        : {
            genre,
            targetWordCount: Number.isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : 0,
          }),
    });
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
                  disabled={isProfilePending}
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
                  disabled={isProfilePending}
                  placeholder={t("projectForm.targetWordCountPlaceholder")}
                  onChange={(event) =>
                    setTargetWordCount(event.target.value.replace(/[^0-9]/g, ""))
                  }
                />
              </Box>
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
                disabled={loading}
              >
                {t("common.cancel")}
              </Button>
            </Dialog.Close>
            <Button
              type="submit"
              loading={loading}
            >
              {isEditMode ? t("common.save") : t("common.create")}
            </Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
