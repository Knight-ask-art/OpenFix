import { Box, Button, Flex, Spinner, Text, TextArea } from "@radix-ui/themes";
import type { Editor } from "@tiptap/react";
import axios from "axios";
import { Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components";
import { newlinesToHtml } from "@/lib/html-utils";

import { InlineAiResult } from "./inline-ai-result";
import {
  INLINE_AI_ACTIONS,
  INLINE_AI_TRIGGER_LABEL_KEY,
  type InlineAiAction,
} from "../lib/inline-ai-actions";
import {
  transformInlineAi,
  type InlineAiTransformResponse,
} from "../lib/inline-ai-api";

import "./inline-ai-menu.css";

const MAX_SELECTION_CHARACTERS = 8_000;

interface SelectionAnchor {
  x: number;
  y: number;
  placeAbove: boolean;
}

interface SavedSelection {
  from: number;
  to: number;
  rawText: string;
}

type InlineAiPhase = "idle" | "menu" | "custom" | "requesting" | "result";

interface InlineAiMenuProps {
  editor: Editor;
  projectId: string;
  chapterId: string;
}

function getErrorDetail(error: unknown): string | null {
  if (axios.isAxiosError(error)) {
    const data: unknown = error.response?.data;
    if (data && typeof data === "object" && "detail" in data) {
      const detail = (data as { detail: unknown }).detail;
      if (typeof detail === "string") return detail;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return null;
}

function readSelectionAnchor(editor: Editor): SelectionAnchor | null {
  const { from, to } = editor.state.selection;
  if (from === to) return null;
  try {
    const coords = editor.view.coordsAtPos(to);
    const placeAbove = coords.top > 200;
    return {
      x: Math.min(coords.left, window.innerWidth - 240),
      y: placeAbove ? coords.top - 8 : coords.bottom + 8,
      placeAbove,
    };
  } catch {
    return null;
  }
}

export function InlineAiMenu({ editor, projectId, chapterId }: InlineAiMenuProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<InlineAiPhase>("idle");
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);
  const [savedSelection, setSavedSelection] = useState<SavedSelection | null>(null);
  const [response, setResponse] = useState<InlineAiTransformResponse | null>(null);
  const [instruction, setInstruction] = useState("");
  const floatingRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setPhase("idle");
    setAnchor(null);
    setSavedSelection(null);
    setResponse(null);
    setInstruction("");
  }, []);

  useEffect(() => {
    const handleSelection = () => {
      if (phase !== "idle") return;
      const { from, to } = editor.state.selection;
      if (from === to) {
        setAnchor(null);
        return;
      }
      const nextAnchor = readSelectionAnchor(editor);
      if (nextAnchor) setAnchor(nextAnchor);
      else setAnchor(null);
    };

    editor.on("selectionUpdate", handleSelection);
    return () => {
      editor.off("selectionUpdate", handleSelection);
    };
  }, [editor, phase]);

  useEffect(() => {
    if (phase === "idle") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (floatingRef.current?.contains(target ?? null)) return;
      if (triggerRef.current?.contains(target ?? null)) return;
      close();
    };
    const handleScroll = () => close();

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown, true);
    document.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown, true);
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [phase, close]);

  const captureSelection = useCallback((): SavedSelection | null => {
    const { from, to } = editor.state.selection;
    if (from === to) return null;
    const rawText = editor.state.doc.textBetween(from, to, "\n", "\n");
    if (!rawText.trim()) return null;
    return { from, to, rawText };
  }, [editor]);

  const runTransform = useCallback(
    async (action: InlineAiAction, customInstruction?: string) => {
      const selection = savedSelection ?? captureSelection();
      if (!selection) {
        close();
        return;
      }
      const selectedText = selection.rawText.trim();
      if (selectedText.length > MAX_SELECTION_CHARACTERS) {
        toast.error(t("inlineAi.tooLong", { max: MAX_SELECTION_CHARACTERS }));
        close();
        return;
      }

      setSavedSelection(selection);
      setPhase("requesting");
      try {
        const result = await transformInlineAi({
          projectId,
          chapterId,
          action,
          selectedText,
          instruction: customInstruction,
        });
        setResponse(result);
        setPhase("result");
      } catch (error) {
        const detail = getErrorDetail(error);
        toast.error(detail ? `${t("inlineAi.failed")}: ${detail}` : t("inlineAi.failed"));
        setPhase("menu");
      }
    },
    [captureSelection, chapterId, close, projectId, savedSelection, t],
  );

  const handleAccept = useCallback(() => {
    if (!response || !savedSelection) {
      close();
      return;
    }
    const { from, to, rawText } = savedSelection;
    const currentText = editor.state.doc.textBetween(from, to, "\n", "\n");
    if (currentText !== rawText) {
      toast.error(t("inlineAi.conflict"));
      close();
      return;
    }
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to }, newlinesToHtml(response.result))
      .run();
    toast.success(t("inlineAi.applied"));
    close();
  }, [close, editor, response, savedSelection, t]);

  const handleTriggerClick = () => {
    const selection = captureSelection();
    if (!selection) return;
    const nextAnchor = readSelectionAnchor(editor) ?? anchor;
    if (!nextAnchor) return;
    setSavedSelection(selection);
    setAnchor(nextAnchor);
    setPhase("menu");
  };

  const floatingStyle: React.CSSProperties = anchor
    ? {
        position: "fixed",
        left: `${anchor.x}px`,
        top: `${anchor.y}px`,
        transform: anchor.placeAbove ? "translateY(-100%)" : undefined,
        zIndex: 60,
      }
    : { display: "none" };

  return (
    <>
      {phase === "idle" && anchor ? (
        <button
          ref={triggerRef}
          type="button"
          className="inline-ai-trigger"
          style={{ position: "fixed", left: `${anchor.x}px`, top: `${anchor.y}px`, zIndex: 60 }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={handleTriggerClick}
        >
          <Sparkles
            size={14}
            aria-hidden="true"
          />
          {t(INLINE_AI_TRIGGER_LABEL_KEY)}
        </button>
      ) : null}

      {phase !== "idle" && anchor ? (
        <Box
          ref={floatingRef}
          className="inline-ai-menu"
          style={floatingStyle}
          onMouseDown={(event) => event.preventDefault()}
        >
          {phase === "menu" || phase === "custom" ? (
            <Box>
              <Flex
                align="center"
                justify="between"
                className="inline-ai-menu__header"
              >
                <Text
                  size="2"
                  weight="medium"
                >
                  {t(INLINE_AI_TRIGGER_LABEL_KEY)}
                </Text>
                <Button
                  size="1"
                  variant="ghost"
                  color="gray"
                  aria-label={t("inlineAi.close")}
                  onClick={close}
                >
                  <X size={14} />
                </Button>
              </Flex>

              <Box className="inline-ai-menu__list">
                {INLINE_AI_ACTIONS.filter((item) => item.id !== "custom").map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className="inline-ai-menu__item"
                      onClick={() => void runTransform(item.id)}
                    >
                      <Icon
                        size={14}
                        aria-hidden="true"
                      />
                      <Text size="2">{t(item.labelKey)}</Text>
                    </button>
                  );
                })}
              </Box>

              <Box className="inline-ai-menu__custom">
                <Text
                  size="1"
                  color="gray"
                  className="inline-ai-menu__custom-label"
                >
                  {t("inlineAi.actions.custom")}
                </Text>
                <TextArea
                  value={instruction}
                  placeholder={t("inlineAi.customPlaceholder")}
                  rows={2}
                  onChange={(event) => setInstruction(event.target.value)}
                />
                <Button
                  size="1"
                  disabled={!instruction.trim()}
                  onClick={() => void runTransform("custom", instruction.trim())}
                >
                  {t("inlineAi.customSubmit")}
                </Button>
              </Box>
            </Box>
          ) : null}

          {phase === "requesting" ? (
            <Flex
              align="center"
              gap="2"
              className="inline-ai-menu__loading"
            >
              <Spinner size="2" />
              <Text size="2">{t("inlineAi.requesting")}</Text>
            </Flex>
          ) : null}

          {phase === "result" && response ? (
            <InlineAiResult
              original={response.original}
              result={response.result}
              model={response.model}
              onAccept={handleAccept}
              onReject={close}
            />
          ) : null}
        </Box>
      ) : null}
    </>
  );
}
