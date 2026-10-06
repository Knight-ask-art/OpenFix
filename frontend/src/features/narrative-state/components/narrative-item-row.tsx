import { Badge, Box, Button, Flex, Text } from "@radix-ui/themes";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { AlertTriangle, Check, ChevronDown, Info, ListTree } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components";

import { confirmNarrativeItem, narrativeQueryKey } from "../lib/narrative-state-api";
import {
  buildConfirmPayload,
  canConfirm,
  changedFields,
  classifyConfirmFailure,
  errorDetail,
  previewText,
  primaryFieldValue,
  type NarrativeDetailValue,
  type NarrativeFieldKey,
  type NarrativeItem,
  type NarrativeKind,
} from "../lib/narrative-state-model";
import { NarrativeDetailsPanel } from "./narrative-details-panel";
import { detailValueLines, enumValueLabel, fieldLabel } from "./narrative-field-labels";

/** 确认被 409 拒绝时保留的「用户当时看到的内容」，用于刷新后展示变更。 */
export interface NarrativeConflict {
  previous: NarrativeItem;
}

const CONFIRMATION_COLORS: Record<
  NarrativeItem["confirmation"],
  "amber" | "blue" | "green" | "gray"
> = {
  candidate: "amber",
  inferred: "blue",
  confirmed: "green",
  rejected: "gray",
};

const WORLD_FACT_STATUS_COLORS: Record<string, "green" | "amber" | "red" | "gray"> = {
  confirmed: "green",
  uncertain: "amber",
  contradicted: "red",
  retired: "gray",
};

/**
 * 冲突里单侧取值的可读文本：按字段类型展开成行（列表逐条、场景结果按类），
 * 再按预览长度截断，避免把整条长记录铺进冲突提示区。
 */
function changeValueText(
  key: NarrativeFieldKey,
  value: NarrativeDetailValue | null,
  kind: NarrativeKind,
  t: TFunction,
): string {
  if (value === null) return t("narrativeState.emptyField");
  const lines = detailValueLines(key, value, kind, t).map((line) => previewText(line));
  return lines.length > 0 ? lines.join("；") : t("narrativeState.emptyField");
}

interface NarrativeItemRowProps {
  item: NarrativeItem;
  projectId: string;
  conflict: NarrativeConflict | null;
  onConflict: (item: NarrativeItem) => void;
  onConflictCleared: (item: NarrativeItem) => void;
}

export function NarrativeItemRow({
  item,
  projectId,
  conflict,
  onConflict,
  onConflictCleared,
}: NarrativeItemRowProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showProvenance, setShowProvenance] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const confirmMutation = useMutation({
    mutationFn: () => confirmNarrativeItem(item.kind, projectId, item),
    onSuccess: () => {
      onConflictCleared(item);
      toast.success(t("narrativeState.confirmSuccess"));
      void queryClient.invalidateQueries({
        queryKey: narrativeQueryKey(item.kind, projectId),
      });
    },
    onError: (error: unknown) => {
      // 409 表示读取后被改写：不重试确认，改为刷新列表并展示变更后的内容。
      if (classifyConfirmFailure(error) === "conflict") {
        onConflict(item);
        void queryClient.invalidateQueries({
          queryKey: narrativeQueryKey(item.kind, projectId),
        });
        toast.error(errorDetail(error) ?? t("narrativeState.conflictTitle"));
        return;
      }
      toast.error(errorDetail(error) ?? t("narrativeState.confirmFailed"));
    },
  });

  const statusLabelKey =
    item.status.length > 0
      ? item.kind === "characterBeliefs"
        ? `narrativeState.beliefState.${item.status}`
        : item.kind === "plotlines"
          ? `narrativeState.plotlineState.${item.status}`
          : `narrativeState.worldFactStatus.${item.status}`
      : null;

  const changes = conflict ? changedFields(conflict.previous, item) : [];
  const provenanceId = `narrative-state-provenance-${item.kind}-${item.id}`;
  const detailsId = `narrative-state-details-${item.kind}-${item.id}`;

  return (
    <Box
      className="narrative-state__row"
      data-kind={item.kind}
      data-item-id={item.id}
    >
      <Flex
        align="center"
        gap="2"
        wrap="wrap"
      >
        <Badge color={CONFIRMATION_COLORS[item.confirmation]}>
          {t(`narrativeState.confirmation.${item.confirmation}`)}
        </Badge>
        {statusLabelKey ? (
          <Badge
            variant="soft"
            color={
              item.kind === "worldFacts"
                ? (WORLD_FACT_STATUS_COLORS[item.status] ?? "gray")
                : "gray"
            }
          >
            {t(statusLabelKey)}
          </Badge>
        ) : null}
        <Text
          size="1"
          color="gray"
        >
          {t("narrativeState.provenance.sourceType", {
            value: enumValueLabel("sourceType", item.sourceType, t),
          })}
        </Text>
        {item.confirmation === "confirmed" && item.confirmedAt ? (
          <Text
            size="1"
            color="gray"
          >
            {t("narrativeState.provenance.confirmedAt", {
              value: item.confirmedAt,
            })}
          </Text>
        ) : null}
      </Flex>

      <Text
        size="2"
        as="p"
        className="narrative-state__primary"
      >
        {primaryFieldValue(item) || t("narrativeState.emptyField")}
      </Text>

      {item.fields.slice(1).some((field) => field.value.length > 0) ? (
        <Box className="narrative-state__secondary">
          {item.fields
            .slice(1)
            .filter((field) => field.value.length > 0)
            .map((field) => (
              <Text
                key={field.key}
                size="1"
                color="gray"
                as="p"
              >
                {fieldLabel(field.key, t)}：{field.value}
              </Text>
            ))}
        </Box>
      ) : null}

      {conflict ? (
        <Box
          className="narrative-state__conflict"
          role="status"
        >
          <Flex
            align="center"
            gap="2"
          >
            <AlertTriangle
              size={13}
              aria-hidden="true"
            />
            <Text
              size="1"
              weight="medium"
            >
              {t("narrativeState.conflictTitle")}
            </Text>
          </Flex>
          <Text
            size="1"
            as="p"
          >
            {t("narrativeState.conflictBody")}
          </Text>
          {changes.length > 0 ? (
            <Box className="narrative-state__conflict-changes">
              {changes.map((change) => (
                <Box
                  key={change.key}
                  className="narrative-state__conflict-change"
                  data-field-key={change.key}
                >
                  <Text
                    size="1"
                    weight="medium"
                  >
                    {fieldLabel(change.key, t)}
                  </Text>
                  <Text
                    size="1"
                    color="gray"
                    as="p"
                  >
                    {t("narrativeState.conflictBefore")}：
                    {changeValueText(change.key, change.before, item.kind, t)}
                  </Text>
                  <Text
                    size="1"
                    color="gray"
                    as="p"
                  >
                    {t("narrativeState.conflictAfter")}：
                    {changeValueText(change.key, change.after, item.kind, t)}
                  </Text>
                </Box>
              ))}
            </Box>
          ) : (
            <Text
              size="1"
              color="gray"
              as="p"
            >
              {t("narrativeState.conflictNoTextChange")}
            </Text>
          )}
        </Box>
      ) : null}

      <Flex
        align="center"
        gap="2"
        wrap="wrap"
        className="narrative-state__actions"
      >
        {canConfirm(item) ? (
          <Button
            size="1"
            variant={conflict ? "solid" : "soft"}
            loading={confirmMutation.isPending}
            disabled={confirmMutation.isPending}
            onClick={() => confirmMutation.mutate()}
          >
            <Check size={13} />
            {conflict ? t("narrativeState.reconfirm") : t("narrativeState.confirm")}
          </Button>
        ) : (
          <Text
            size="1"
            color="gray"
          >
            {t("narrativeState.confirmedNoAction")}
          </Text>
        )}
        <Button
          size="1"
          variant="ghost"
          color="gray"
          aria-expanded={showDetails}
          aria-controls={detailsId}
          onClick={() => setShowDetails((value) => !value)}
        >
          {showDetails ? <ChevronDown size={13} /> : <ListTree size={13} />}
          {showDetails
            ? t("narrativeState.details.hide", { defaultValue: "收起完整字段" })
            : t("narrativeState.details.show", { defaultValue: "查看完整字段" })}
        </Button>
        <Button
          size="1"
          variant="ghost"
          color="gray"
          aria-expanded={showProvenance}
          aria-controls={provenanceId}
          onClick={() => setShowProvenance((value) => !value)}
        >
          {showProvenance ? <ChevronDown size={13} /> : <Info size={13} />}
          {showProvenance
            ? t("narrativeState.provenance.hide")
            : t("narrativeState.provenance.show")}
        </Button>
      </Flex>

      {showProvenance ? (
        <Box
          id={provenanceId}
          className="narrative-state__provenance"
        >
          <Text
            size="1"
            color="gray"
            as="p"
          >
            {t("narrativeState.provenance.sourceType", {
              value: enumValueLabel("sourceType", item.sourceType, t),
            })}
          </Text>
          {item.sourceChapterId ? (
            <Text
              size="1"
              color="gray"
              as="p"
            >
              {t("narrativeState.provenance.chapter", { value: item.sourceChapterId })}
            </Text>
          ) : null}
          {item.sourceId ? (
            <Text
              size="1"
              color="gray"
              as="p"
            >
              {t("narrativeState.provenance.sourceId", { value: item.sourceId })}
            </Text>
          ) : null}
          {item.quoteAnchor ? (
            <Text
              size="1"
              color="gray"
              as="p"
            >
              {t("narrativeState.provenance.quoteAnchor", { value: item.quoteAnchor })}
            </Text>
          ) : null}
          {item.createdBy ? (
            <Text
              size="1"
              color="gray"
              as="p"
            >
              {t("narrativeState.provenance.createdBy", { value: item.createdBy })}
            </Text>
          ) : null}
          <Text
            size="1"
            color="gray"
            as="p"
          >
            {t("narrativeState.provenance.confidence", {
              value:
                item.confidence === null
                  ? t("narrativeState.provenance.unknown")
                  : `${Math.round(item.confidence * 100)}%`,
            })}
          </Text>
          {item.confirmedBy ? (
            <Text
              size="1"
              color="gray"
              as="p"
            >
              {t("narrativeState.provenance.confirmedBy", { value: item.confirmedBy })}
            </Text>
          ) : null}
          <Text
            size="1"
            color="gray"
            as="p"
          >
            {t("narrativeState.provenance.updatedAt", {
              value: item.updatedAt || t("narrativeState.provenance.unknown"),
            })}
          </Text>
          <Text
            size="1"
            color="gray"
            as="p"
          >
            {t("narrativeState.provenance.confirmation", {
              value: t(`narrativeState.confirmation.${item.confirmation}`),
            })}
          </Text>
          {buildConfirmPayload(item) === null ? (
            <Text
              size="1"
              color="gray"
              as="p"
            >
              {t("narrativeState.provenance.missingToken")}
            </Text>
          ) : null}
        </Box>
      ) : null}

      {showDetails ? (
        <NarrativeDetailsPanel
          id={detailsId}
          item={item}
        />
      ) : null}
    </Box>
  );
}
