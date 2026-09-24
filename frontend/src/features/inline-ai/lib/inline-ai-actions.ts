import {
  Eye,
  Gauge,
  Heart,
  Maximize2,
  MessageSquare,
  Minimize2,
  PencilLine,
  RefreshCw,
  Sparkles,
  SpellCheck,
  type LucideIcon,
} from "lucide-react";

export type InlineAiAction =
  | "polish"
  | "rewrite"
  | "expand"
  | "shorten"
  | "dialogue"
  | "description"
  | "emotion"
  | "pacing"
  | "grammar"
  | "custom";

export interface InlineAiActionItem {
  id: InlineAiAction;
  labelKey: string;
  icon: LucideIcon;
}

export const INLINE_AI_ACTIONS: InlineAiActionItem[] = [
  { id: "polish", labelKey: "inlineAi.actions.polish", icon: Sparkles },
  { id: "rewrite", labelKey: "inlineAi.actions.rewrite", icon: RefreshCw },
  { id: "expand", labelKey: "inlineAi.actions.expand", icon: Maximize2 },
  { id: "shorten", labelKey: "inlineAi.actions.shorten", icon: Minimize2 },
  { id: "dialogue", labelKey: "inlineAi.actions.dialogue", icon: MessageSquare },
  { id: "description", labelKey: "inlineAi.actions.description", icon: Eye },
  { id: "emotion", labelKey: "inlineAi.actions.emotion", icon: Heart },
  { id: "pacing", labelKey: "inlineAi.actions.pacing", icon: Gauge },
  { id: "grammar", labelKey: "inlineAi.actions.grammar", icon: SpellCheck },
  { id: "custom", labelKey: "inlineAi.actions.custom", icon: PencilLine },
];

export const INLINE_AI_TRIGGER_LABEL_KEY = "inlineAi.trigger";
