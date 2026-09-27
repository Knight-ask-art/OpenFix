import { Badge, Box, Button, Flex, Text } from "@radix-ui/themes";
import { Quote } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ConsistencyIssue } from "../lib/consistency-api";

import "./issue-card.css";

interface IssueCardProps {
  issue: ConsistencyIssue;
}

export function IssueCard({ issue }: IssueCardProps) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);

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
      >
        <Button
          size="1"
          variant="ghost"
          color="gray"
          onClick={() => setDismissed(true)}
        >
          {t("consistency.dismiss")}
        </Button>
      </Flex>
    </Box>
  );
}
