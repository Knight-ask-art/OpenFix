import { Box, Button, Flex, Text, TextArea } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { apiClient } from "@/lib/api-client";

interface WritingCandidate {
  child_run_id: string;
  content: string;
  content_sha256: string;
  word_count: number;
  within_contract_range: boolean;
  measurement_attempt: number;
  measurement_limit: number;
  failure_reason: string;
  approved: false;
}

export function WritingRecoveryPanel({ childRunId }: { childRunId: string }) {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const query = useQuery({
    queryKey: ["writing-candidate", childRunId],
    queryFn: async ({ signal }) => {
      const response = await apiClient.get<WritingCandidate>(
        `/agent/subagents/${encodeURIComponent(childRunId)}/writing-candidate`,
        { signal },
      );
      return response.data;
    },
    enabled: false,
    retry: false,
    gcTime: 0,
  });
  const copy = async () => {
    if (!query.data) return;
    try {
      await navigator.clipboard.writeText(query.data.content);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  return (
    <Box p="3" role="region" aria-label={t("assistant.writingRecovery.title")}>
      <Flex direction="column" gap="2">
        <Text size="2">{t("assistant.writingRecovery.notice")}</Text>
        <Button size="1" variant="soft" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {t(query.isFetching ? "assistant.writingRecovery.loading" : "assistant.writingRecovery.load")}
        </Button>
        {query.isError ? (
          <Text size="2" role="alert">
            {t(isAxiosError(query.error) && query.error.response?.status === 404
              ? "assistant.writingRecovery.empty" : "assistant.writingRecovery.error")}
          </Text>
        ) : null}
        {query.data ? (
          <>
            <Text size="2">{t("assistant.writingRecovery.wordCount", { count: query.data.word_count })}</Text>
            <Text size="1" style={{ overflowWrap: "anywhere" }}>{query.data.content_sha256}</Text>
            <TextArea readOnly value={query.data.content} rows={8} aria-label={t("assistant.writingRecovery.title")} />
            <Button size="1" variant="soft" onClick={() => void copy()}>
              {t(copyState === "copied" ? "assistant.writingRecovery.copied" : "assistant.writingRecovery.copy")}
            </Button>
            {copyState === "error" ? <Text size="2" role="alert">{t("assistant.writingRecovery.copyError")}</Text> : null}
          </>
        ) : null}
      </Flex>
    </Box>
  );
}
