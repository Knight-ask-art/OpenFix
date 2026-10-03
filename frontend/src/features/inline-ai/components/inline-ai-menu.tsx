import { Box, Button, Flex, Spinner, Text, TextArea } from "@radix-ui/themes";
import type { Editor } from "@tiptap/react";
import axios from "axios";
import { Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components";
import {
  isBackgroundModelUnavailableError,
  MODEL_UNAVAILABLE_I18N_KEY,
  readHttpErrorDetail,
} from "@/lib/ai-error";
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

interface SelectionRect {
  left: number;
  top: number;
  bottom: number;
}

interface SurfaceSize {
  width: number;
  height: number;
}

interface ViewportSize {
  width: number;
  height: number;
}

interface FloatingPlacementInput {
  anchor: SelectionRect;
  surface: SurfaceSize;
  viewport: ViewportSize;
  margin?: number;
  gap?: number;
}

interface FloatingPlacement {
  left: number;
  top: number;
}

/**
 * 纯几何计算：给定选区锚点、浮层实际尺寸与视口尺寸，返回固定定位浮层的左上角坐标。
 *
 * 尺寸与视口由调用方测量后传入，函数内不读取 DOM，也不使用固定高度或宽度推断。
 * 优先贴近选区上方；上方放不下时翻到下方；两侧都放不下时贴向空间较大的一侧，
 * 并由外层 max-height 约束高度。
 */
function resolveFloatingPlacement(input: FloatingPlacementInput): FloatingPlacement {
  const margin = input.margin ?? 8;
  const gap = input.gap ?? 8;
  const { anchor, surface, viewport } = input;

  const maxLeft = viewport.width - surface.width - margin;
  let left = anchor.left;
  if (left > maxLeft) left = maxLeft;
  if (left < margin) left = margin;

  const aboveTop = anchor.top - gap - surface.height;
  const belowTop = anchor.bottom + gap;
  const fitsAbove = aboveTop >= margin;
  const fitsBelow = belowTop + surface.height <= viewport.height - margin;

  let top: number;
  if (fitsAbove) {
    top = aboveTop;
  } else if (fitsBelow) {
    top = belowTop;
  } else {
    const spaceAbove = anchor.top - gap - margin;
    const spaceBelow = viewport.height - margin - belowTop;
    top = spaceAbove >= spaceBelow ? aboveTop : belowTop;
    const maxTop = viewport.height - surface.height - margin;
    if (top > maxTop) top = maxTop;
    if (top < margin) top = margin;
  }

  return { left, top };
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
  const detail = readHttpErrorDetail(error);
  if (detail) return detail;
  if (axios.isAxiosError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return null;
}

function readSelectionRect(editor: Editor): SelectionRect | null {
  const { from, to } = editor.state.selection;
  if (from === to) return null;
  try {
    const coords = editor.view.coordsAtPos(to);
    return { left: coords.left, top: coords.top, bottom: coords.bottom };
  } catch {
    return null;
  }
}

export function InlineAiMenu({ editor, projectId, chapterId }: InlineAiMenuProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<InlineAiPhase>("idle");
  const [anchor, setAnchor] = useState<SelectionRect | null>(null);
  const [savedSelection, setSavedSelection] = useState<SavedSelection | null>(null);
  const [response, setResponse] = useState<InlineAiTransformResponse | null>(null);
  const [instruction, setInstruction] = useState("");
  const [surface, setSurface] = useState<SurfaceSize | null>(null);
  const [viewport, setViewport] = useState<ViewportSize>(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const floatingRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setPhase("idle");
    setAnchor(null);
    setSavedSelection(null);
    setResponse(null);
    setInstruction("");
  }, []);

  useLayoutEffect(() => {
    if (!anchor) return;
    const node = (phase === "idle" ? triggerRef : floatingRef).current;
    if (!node) return;

    const measure = () => {
      const rect = node.getBoundingClientRect();
      setSurface((previous) => {
        if (
          previous &&
          Math.abs(previous.width - rect.width) < 0.5 &&
          Math.abs(previous.height - rect.height) < 0.5
        ) {
          return previous;
        }
        return { width: rect.width, height: rect.height };
      });
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [anchor, phase]);

  useEffect(() => {
    const handleResize = () => {
      setViewport((previous) => {
        const width = window.innerWidth;
        const height = window.innerHeight;
        if (previous.width === width && previous.height === height) return previous;
        return { width, height };
      });
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const handleSelection = () => {
      if (phase !== "idle") return;
      const { from, to } = editor.state.selection;
      if (from === to) {
        setAnchor(null);
        return;
      }
      const nextAnchor = readSelectionRect(editor);
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
    // 浮层自身与其内部滚动（结果 diff、自定义输入）不得关闭菜单，只有外部滚动才关闭。
    const handleScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && floatingRef.current?.contains(target)) return;
      close();
    };

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
        if (isBackgroundModelUnavailableError(error)) {
          toast.error(`${t("inlineAi.failed")}: ${t(MODEL_UNAVAILABLE_I18N_KEY)}`);
        } else {
          const detail = getErrorDetail(error);
          toast.error(detail ? `${t("inlineAi.failed")}: ${detail}` : t("inlineAi.failed"));
        }
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
    const nextAnchor = readSelectionRect(editor) ?? anchor;
    if (!nextAnchor) return;
    setSavedSelection(selection);
    setAnchor(nextAnchor);
    setPhase("menu");
  };

  useEffect(() => {
    if (phase !== "result") return;
    const handleEnter = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      handleAccept();
    };
    document.addEventListener("keydown", handleEnter, true);
    return () => document.removeEventListener("keydown", handleEnter, true);
  }, [phase, handleAccept]);

  const placement =
    anchor && surface ? resolveFloatingPlacement({ anchor, surface, viewport }) : null;

  const hiddenSurfaceStyle: React.CSSProperties = {
    position: "fixed",
    left: 0,
    top: 0,
    visibility: "hidden",
    zIndex: 60,
  };
  const triggerStyle: React.CSSProperties = placement
    ? { position: "fixed", left: `${placement.left}px`, top: `${placement.top}px`, zIndex: 60 }
    : hiddenSurfaceStyle;
  const floatingStyle: React.CSSProperties = placement
    ? { position: "fixed", left: `${placement.left}px`, top: `${placement.top}px`, zIndex: 60 }
    : hiddenSurfaceStyle;

  return (
    <>
      {phase === "idle" && anchor ? (
        <button
          ref={triggerRef}
          type="button"
          className="inline-ai-trigger"
          style={triggerStyle}
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
