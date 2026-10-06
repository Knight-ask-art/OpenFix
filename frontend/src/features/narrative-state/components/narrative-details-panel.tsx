import { Box, Text } from "@radix-ui/themes";
import { useTranslation } from "react-i18next";

import { serializeNarrativeRecord, type NarrativeItem } from "../lib/narrative-state-model";
import { detailValueLines, fieldLabel } from "./narrative-field-labels";

interface NarrativeDetailsPanelProps {
  id: string;
  item: NarrativeItem;
}

/**
 * 确认前可展开的完整字段视图。
 *
 * 确认接口接收的是整行，所以这里把 `item.details` 的每个字段逐条展示，
 * 并附上整行记录的 JSON 原文。内容只读，不提供任何编辑或写回入口。
 */
export function NarrativeDetailsPanel({ id, item }: NarrativeDetailsPanelProps) {
  const { t } = useTranslation();

  return (
    <Box
      id={id}
      className="narrative-state__details"
    >
      {item.details.map((detail) => {
        const lines = detailValueLines(detail.key, detail.value, item.kind, t);
        return (
          <Box
            key={detail.key}
            className="narrative-state__detail"
          >
            <Text
              size="1"
              color="gray"
              as="p"
              className="narrative-state__detail-label"
            >
              {fieldLabel(detail.key, t)}
            </Text>
            {lines.length > 0 ? (
              lines.map((line, index) => (
                <Text
                  key={`${detail.key}-${index}`}
                  size="1"
                  as="p"
                  className="narrative-state__detail-value"
                >
                  {line}
                </Text>
              ))
            ) : (
              <Text
                size="1"
                color="gray"
                as="p"
                className="narrative-state__detail-value"
              >
                {t("narrativeState.emptyField")}
              </Text>
            )}
          </Box>
        );
      })}
      <Text
        size="1"
        color="gray"
        as="p"
      >
        {t("narrativeState.details.rawJson", { defaultValue: "完整记录 JSON" })}
      </Text>
      <pre className="narrative-state__json">{serializeNarrativeRecord(item)}</pre>
    </Box>
  );
}
