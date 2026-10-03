import { Badge, Box, Button, Dialog, Flex, Spinner, Text } from "@radix-ui/themes";
import { FileText, Quote, Sparkles } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components";
import { resolveAiErrorMessage } from "@/lib/ai-error";

import type { ConsistencyIssue } from "../lib/consistency-api";
import { analyzeConsistencyIssue, type ConsistencyScope } from "../lib/consistency-api";

import "./issue-card.css";

interface IssueCardProps {
  issue: ConsistencyIssue;
  projectId: string;
  scope: ConsistencyScope;
  chapterId: string | null;
  volumeId: string | null;
}

export function IssueCard({ issue, projectId, scope, chapterId, volumeId }: IssueCardProps) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysis, setAnalysis] = useState("");
  const [analysisModel, setAnalysisModel] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const mountedRef = useRef(false);
  const analysisRevisionRef = useRef(0);

  // Revoke publication during the unmount commit, before passive effects run.
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      analysisRevisionRef.current += 1;
    };
  }, []);

  if (dismissed) {
    return (
      <Box className="consistency-issue consistency-issue--dismissed">
        <Text
          size="1"
          color="gray"
        >
          {t("consistency.dismissed")}
        </Text>
        <Button
          size="1"
          variant="ghost"
          color="gray"
          onClick={() => setDismissed(false)}
        >
          {t("consistency.restore")}
        </Button>
      </Box>
    );
  }

  const severityLabel = t(`consistency.severity.${issue.severity}`);

  const handleAnalyze = async () => {
    const revision = ++analysisRevisionRef.current;
    const isCurrentRequest = () =>
      mountedRef.current && analysisRevisionRef.current === revision;
    setAnalysisOpen(true);
    setAnalysis("");
    setAnalysisModel("");
    setIsAnalyzing(true);
    try {
      const result = await analyzeConsistencyIssue(projectId, {
        scope,
        chapterId,
        volumeId,
        issue,
      });
      if (!isCurrentRequest()) return;
      setAnalysis(result.analysis);
      setAnalysisModel(result.model);
    } catch (error) {
      if (!isCurrentRequest()) return;
      toast.error(resolveAiErrorMessage(error, t, t("consistency.analysisFailed")));
      setAnalysisOpen(false);
    } finally {
      if (isCurrentRequest()) setIsAnalyzing(false);
    }
  };

  const handleDismiss = () => {
    analysisRevisionRef.current += 1;
    setIsAnalyzing(false);
    setAnalysis("");
    setAnalysisModel("");
    setAnalysisOpen(false);
    setDismissed(true);
  };

  return (
    <Box className="consistency-issue">
      <Flex
        align="center"
        gap="2"
        wrap="wrap"
      >
        <Badge
          color={issue.severity === "high" ? "red" : issue.severity === "warning" ? "amber" : "gray"}
        >
          {severityLabel}
        </Badge>
        <Text
          size="1"
          color="gray"
        >
          {t(`consistency.types.${issue.type}`, issue.type)}
        </Text>
      </Flex>
      <Text
        size="2"
        className="consistency-issue__message"
      >
        {issue.message}
      </Text>
      {issue.evidence.length > 0 ? (
        <Box className="consistency-issue__evidence">
          {issue.evidence.map((entry, index) => (
            <Flex
              key={index}
              gap="2"
              align="baseline"
            >
              <Quote
                size={12}
                color="var(--gray-11)"
                aria-hidden="true"
              />
              <Text
                size="1"
                color="gray"
              >
                {entry}
              </Text>
            </Flex>
          ))}
        </Box>
      ) : null}
      {issue.suggestion ? (
        <Text
          size="1"
          className="consistency-issue__suggestion"
        >
          {t("consistency.suggestionPrefix")}
          {issue.suggestion}
        </Text>
      ) : null}
      <Flex
        justify="end"
        mt="1"
        gap="2"
        wrap="wrap"
      >
        <Button
          size="1"
          variant="soft"
          color="gray"
          disabled={issue.sources.length === 0}
          title={issue.sources.length === 0 ? t("consistency.sourceUnavailable") : undefined}
          onClick={() => setShowSources((value) => !value)}
        >
          <FileText size={13} />
          {showSources ? t("consistency.hideOriginal") : t("consistency.viewOriginal")}
        </Button>
        <Dialog.Root open={analysisOpen} onOpenChange={setAnalysisOpen}>
          <Button
            size="1"
            variant="soft"
            onClick={() => void handleAnalyze()}
            disabled={isAnalyzing}
          >
            <Sparkles size={13} />
            {t("consistency.analyze")}
          </Button>
          <Dialog.Content maxWidth="560px">
            <Dialog.Title>{t("consistency.analysisTitle")}</Dialog.Title>
            <Dialog.Description mb="3">{issue.message}</Dialog.Description>
            {isAnalyzing ? (
              <Flex align="center" gap="2" py="3">
                <Spinner size="2" />
                <Text size="2" color="gray">{t("consistency.analyzingIssue")}</Text>
              </Flex>
            ) : (
              <Box className="consistency-issue__analysis">
                <Text size="2" style={{ whiteSpace: "pre-wrap" }}>{analysis}</Text>
                {analysisModel ? (
                  <Text size="1" color="gray" mt="2" as="p">
                    {t("consistency.analysisModel", { model: analysisModel })}
                  </Text>
                ) : null}
              </Box>
            )}
            <Flex justify="end" mt="4">
              <Dialog.Close>
                <Button size="2" variant="soft">{t("consistency.close")}</Button>
              </Dialog.Close>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
        <Button
          size="1"
          variant="ghost"
          color="gray"
          onClick={handleDismiss}
        >
          {t("consistency.dismiss")}
        </Button>
      </Flex>
      {showSources ? (
        <Box className="consistency-issue__sources">
          {issue.sources.map((source, index) => (
            <Box key={`${source.chapter_id}-${index}`} className="consistency-issue__source">
              <Text size="1" weight="medium">
                {t("consistency.sourceChapter", {
                  order: source.chapter_order,
                  title: source.chapter_title || t("consistency.untitledChapter"),
                })}
              </Text>
              <Text size="2" as="p" style={{ whiteSpace: "pre-wrap" }}>
                {source.excerpt}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
