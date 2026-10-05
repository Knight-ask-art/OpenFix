import { Box, Flex, Switch, Text } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Spinner, toast } from "@/components";

import { fetchSettings, updateSettings } from "../lib/settings-api";
import type { Settings, SettingsUpdateRequest } from "../lib/settings.types";

export function ContextSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
  });
  const updateMutation = useMutation({
    mutationFn: updateSettings,
    onMutate: async (patch: SettingsUpdateRequest) => {
      await queryClient.cancelQueries({ queryKey: ["settings"] });
      const previousSettings = queryClient.getQueryData<Settings>(["settings"]);

      if (previousSettings) {
        queryClient.setQueryData<Settings>(["settings"], {
          ...previousSettings,
          ...(patch.compress_system_prompts !== undefined
            ? { compressSystemPrompts: patch.compress_system_prompts }
            : {}),
          ...(patch.context_soft_gc_tool_results !== undefined
            ? { contextSoftGcToolResults: patch.context_soft_gc_tool_results }
            : {}),
        });
      }

      return { previousSettings };
    },
    onSuccess: (nextSettings) => {
      queryClient.setQueryData(["settings"], nextSettings);
      toast.success(t("settings.saved"));
    },
    onError: (_error, _patch, context) => {
      if (context?.previousSettings) {
        queryClient.setQueryData(["settings"], context.previousSettings);
      }
      toast.error(t("settings.saveFailed"));
    },
  });

  if (isLoading || !settings) {
    return (
      <Flex
        align="center"
        justify="center"
        style={{ height: "100%" }}
      >
        <Spinner size={18} />
      </Flex>
    );
  }

  return (
    <Box>
      <Flex
        align="center"
        justify="between"
        gap="4"
      >
        <Flex
          direction="column"
          gap="1"
        >
          <Text
            size="2"
            weight="medium"
          >
            {t("settings.contextCompressSystemPrompts")}
          </Text>
          <Text
            size="1"
            color="gray"
          >
            {t("settings.contextCompressSystemPromptsHint")}
          </Text>
        </Flex>
        <Switch
          checked={settings.compressSystemPrompts}
          aria-label={t("settings.contextCompressSystemPrompts")}
          onCheckedChange={(checked) => {
            updateMutation.mutate({ compress_system_prompts: checked });
          }}
        />
      </Flex>
      <Flex
        align="center"
        justify="between"
        gap="4"
        mt="5"
      >
        <Flex
          direction="column"
          gap="1"
        >
          <Text
            size="2"
            weight="medium"
          >
            {t("settings.contextSoftGcToolResults")}
          </Text>
          <Text
            size="1"
            color="gray"
          >
            {t("settings.contextSoftGcToolResultsHint")}
          </Text>
        </Flex>
        <Switch
          checked={settings.contextSoftGcToolResults}
          aria-label={t("settings.contextSoftGcToolResults")}
          onCheckedChange={(checked) => {
            updateMutation.mutate({ context_soft_gc_tool_results: checked });
          }}
        />
      </Flex>
    </Box>
  );
}
