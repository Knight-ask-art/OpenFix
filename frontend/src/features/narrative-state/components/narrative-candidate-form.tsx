import { Box, Button, Flex, Text, TextArea, TextField } from "@radix-ui/themes";
import { useMutation } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components";

import { createPlotlineCandidate, createWorldFactCandidate } from "../lib/narrative-state-api";
import { errorDetail } from "../lib/narrative-state-model";

/** 只有世界事实与情节线支持手工录入候选；两类都只能产生「候选」状态。 */
export type CandidateKind = "worldFacts" | "plotlines";

interface NarrativeCandidateFormProps {
  kind: CandidateKind;
  projectId: string;
  onCreated: () => void;
}

export function NarrativeCandidateForm({
  kind,
  projectId,
  onCreated,
}: NarrativeCandidateFormProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [primary, setPrimary] = useState("");
  const [secondary, setSecondary] = useState("");

  const mutation = useMutation({
    mutationFn: () => {
      const trimmedPrimary = primary.trim();
      const trimmedSecondary = secondary.trim();
      if (kind === "worldFacts") {
        return createWorldFactCandidate(projectId, {
          statement: trimmedPrimary,
          subjectRef: trimmedSecondary,
        });
      }
      return createPlotlineCandidate(projectId, {
        title: trimmedPrimary,
        description: trimmedSecondary,
      });
    },
    onSuccess: () => {
      toast.success(t("narrativeState.createSuccess"));
      setPrimary("");
      setSecondary("");
      setIsOpen(false);
      onCreated();
    },
    onError: (error: unknown) => {
      toast.error(errorDetail(error) ?? t("narrativeState.createFailed"));
    },
  });

  const primaryLabel =
    kind === "worldFacts" ? t("narrativeState.field.statement") : t("narrativeState.field.title");
  const secondaryLabel =
    kind === "worldFacts"
      ? t("narrativeState.field.subjectRef")
      : t("narrativeState.field.description");
  const canSubmit = primary.trim().length > 0 && !mutation.isPending;

  if (!isOpen) {
    return (
      <Button
        size="1"
        variant="soft"
        color="gray"
        onClick={() => setIsOpen(true)}
      >
        <Plus size={13} />
        {kind === "worldFacts" ? t("narrativeState.addWorldFact") : t("narrativeState.addPlotline")}
      </Button>
    );
  }

  return (
    <Box
      className="narrative-state__form"
      asChild
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) mutation.mutate();
        }}
      >
        <Text
          size="1"
          color="gray"
          as="p"
        >
          {t("narrativeState.form.manualHint")}
        </Text>
        <Flex
          direction="column"
          gap="1"
        >
          <Text
            as="label"
            size="1"
            color="gray"
            htmlFor={`narrative-candidate-${kind}-primary`}
          >
            {primaryLabel}
          </Text>
          <TextField.Root
            id={`narrative-candidate-${kind}-primary`}
            value={primary}
            placeholder={t(
              kind === "worldFacts"
                ? "narrativeState.form.statementPlaceholder"
                : "narrativeState.form.titlePlaceholder",
            )}
            onChange={(event) => setPrimary(event.target.value)}
          />
        </Flex>
        <Flex
          direction="column"
          gap="1"
        >
          <Text
            as="label"
            size="1"
            color="gray"
            htmlFor={`narrative-candidate-${kind}-secondary`}
          >
            {secondaryLabel}
          </Text>
          {kind === "worldFacts" ? (
            <TextField.Root
              id={`narrative-candidate-${kind}-secondary`}
              value={secondary}
              placeholder={t("narrativeState.form.subjectRefPlaceholder")}
              onChange={(event) => setSecondary(event.target.value)}
            />
          ) : (
            <TextArea
              id={`narrative-candidate-${kind}-secondary`}
              value={secondary}
              rows={2}
              resize="vertical"
              placeholder={t("narrativeState.form.descriptionPlaceholder")}
              onChange={(event) => setSecondary(event.target.value)}
            />
          )}
        </Flex>
        <Flex
          gap="2"
          justify="end"
        >
          <Button
            type="button"
            size="1"
            variant="ghost"
            color="gray"
            disabled={mutation.isPending}
            onClick={() => {
              setIsOpen(false);
              setPrimary("");
              setSecondary("");
            }}
          >
            <X size={13} />
            {t("narrativeState.cancel")}
          </Button>
          <Button
            type="submit"
            size="1"
            disabled={!canSubmit}
            loading={mutation.isPending}
          >
            {t("narrativeState.createSubmit")}
          </Button>
        </Flex>
      </form>
    </Box>
  );
}
