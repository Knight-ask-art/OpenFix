import { Box, Button, Dialog, Flex, Text } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import { BookOpenText, Lightbulb, Sparkles, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { toast } from "@/components";
import { ImportDialog } from "@/features/projects/components/import-dialog";
import { ProjectFormDialog } from "@/features/projects/components/project-form-dialog";
import { useCreateProject, useProjects } from "@/features/projects";
import { fetchModels } from "@/lib/api-client";

import { hasCompletedOnboarding, markOnboardingCompleted } from "../lib/onboarding-state";

import "./onboarding-wizard.css";

type WizardStep = "welcome" | "start" | "ai";

export function OnboardingWizard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [completed, setCompleted] = useState(() => hasCompletedOnboarding());
  const [step, setStep] = useState<WizardStep>("welcome");
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
    if (!isFetched || completed) return;
    if ((projectsPage?.total ?? 0) > 0 || hasChatModel) {
      markOnboardingCompleted();
      setCompleted(true);
    }
  }, [completed, isFetched, hasChatModel, projectsPage]);

  const finish = () => {
    markOnboardingCompleted();
    setCompleted(true);
  };

  const handleCreateSubmit = async (data: {
    title: string;
    description?: string;
    cover?: File | null;
  }) => {
    try {
      const project = await createMutation.mutateAsync({
        title: data.title,
        description: data.description ?? null,
        cover: data.cover ?? null,
      });
      setCreateOpen(false);
      finish();
      toast.success(t("onboarding.created"));
      navigate(`/projects/${project.id}`);
    } catch {
      toast.error(t("projects.createFailed"));
    }
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
          maxWidth="560px"
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
                onClick={() => setStep("start")}
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
                onClick={() => {
                  finish();
                  navigate("/outline");
                }}
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
        </Dialog.Content>
      </Dialog.Root>

      <ProjectFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={(data) => void handleCreateSubmit(data)}
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
