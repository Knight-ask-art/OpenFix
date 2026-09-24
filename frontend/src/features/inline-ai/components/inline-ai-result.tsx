import { Box, Button, Flex, Text } from "@radix-ui/themes";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { buildInlineAiDiffRows } from "../lib/inline-ai-diff";

import "./inline-ai-result.css";

interface InlineAiResultProps {
  original: string;
  result: string;
  model: string;
  onAccept: () => void;
  onReject: () => void;
}

export function InlineAiResult({ original, result, model, onAccept, onReject }: InlineAiResultProps) {
  const { t } = useTranslation();
  const rows = useMemo(() => buildInlineAiDiffRows(original, result), [original, result]);

  return (
    <Box className="inline-ai-result">
      <Flex
        align="center"
        justify="between"
        className="inline-ai-result__header"
      >
        <Text
          size="2"
          weight="medium"
        >
          {t("inlineAi.resultTitle")}
        </Text>
        <Text
          size="1"
          color="gray"
        >
          {model}
        </Text>
      </Flex>

      <div
        className="inline-ai-result__diff"
        role="region"
        aria-label={t("inlineAi.resultTitle")}
      >
        {rows.map((row, index) => (
          <div
            key={index}
            className={`inline-ai-result__line inline-ai-result__line--${row.type}`}
          >
            <span
              className="inline-ai-result__prefix"
              aria-hidden="true"
            >
              {row.type === "removed" ? "-" : row.type === "added" ? "+" : " "}
            </span>
            <span className="inline-ai-result__text">{row.text || " "}</span>
          </div>
        ))}
      </div>

      <Flex
        gap="2"
        justify="end"
        className="inline-ai-result__footer"
      >
        <Button
          size="2"
          variant="soft"
          color="gray"
          onClick={onReject}
        >
          {t("inlineAi.reject")}
        </Button>
        <Button
          size="2"
          onClick={onAccept}
        >
          {t("inlineAi.accept")}
        </Button>
      </Flex>
    </Box>
  );
}
