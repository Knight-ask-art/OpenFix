import {
  Brain,
  Bot,
  Cable,
  Database,
  FileText,
  Globe,
  MessagesSquare,
  Palette,
  Package,
  Summary as SummaryIcon,
  Settings as SettingsIcon,
  ShieldAlert,
  SlidersHorizontal,
  Type,
} from "lucide-react";
import type { ReactNode } from "react";

export type SettingsCategory =
  | "general"
  | "personalization"
  | "editor"
  | "connections"
  | "models"
  | "index"
  | "context"
  | "summary"
  | "agent-tools"
  | "web-search"
  | "rules"
  | "skills"
  | "agents"
  | "advanced";

export type SettingsCategoryTier = "basic" | "advanced";

interface SettingsCategoryItem {
  id: SettingsCategory;
  icon: ReactNode;
  labelKey: string;
  /** basic: visible by default; advanced: only visible in advanced mode. */
  tier: SettingsCategoryTier;
}

export const SETTINGS_CATEGORY_ITEMS: SettingsCategoryItem[] = [
  {
    id: "general",
    icon: <SettingsIcon size={16} />,
    labelKey: "settings.general",
    tier: "basic",
  },
  {
    id: "personalization",
    icon: <Palette size={16} />,
    labelKey: "settings.personalization",
    tier: "basic",
  },
  {
    id: "editor",
    icon: <Type size={16} />,
    labelKey: "settings.editor",
    tier: "basic",
  },
  {
    id: "connections",
    icon: <Cable size={16} />,
    labelKey: "settings.connections",
    tier: "basic",
  },
  {
    id: "models",
    icon: <Brain size={16} />,
    labelKey: "settings.models",
    tier: "basic",
  },
  {
    id: "index",
    icon: <Database size={16} />,
    labelKey: "settings.index",
    tier: "advanced",
  },
  {
    id: "context",
    icon: <MessagesSquare size={16} />,
    labelKey: "settings.context",
    tier: "advanced",
  },
  {
    id: "summary",
    icon: <SummaryIcon size={16} />,
    labelKey: "settings.summary",
    tier: "advanced",
  },
  {
    id: "agent-tools",
    icon: <ShieldAlert size={16} />,
    labelKey: "settings.agentTools",
    tier: "advanced",
  },
  {
    id: "web-search",
    icon: <Globe size={16} />,
    labelKey: "settings.webSearch",
    tier: "advanced",
  },
  {
    id: "rules",
    icon: <FileText size={16} />,
    labelKey: "settings.rules",
    tier: "advanced",
  },
  {
    id: "skills",
    icon: <Package size={16} />,
    labelKey: "settings.skills",
    tier: "advanced",
  },
  {
    id: "agents",
    icon: <Bot size={16} />,
    labelKey: "settings.agents",
    tier: "advanced",
  },
  {
    id: "advanced",
    icon: <SlidersHorizontal size={16} />,
    labelKey: "settings.advanced",
    tier: "advanced",
  },
];

export function getSettingsCategoryTier(id: SettingsCategory): SettingsCategoryTier {
  return SETTINGS_CATEGORY_ITEMS.find((item) => item.id === id)?.tier ?? "advanced";
}

export function filterSettingsCategories(isAdvancedMode: boolean): SettingsCategoryItem[] {
  if (isAdvancedMode) return SETTINGS_CATEGORY_ITEMS;
  return SETTINGS_CATEGORY_ITEMS.filter((item) => item.tier === "basic");
}

export const ADVANCED_SETTINGS_SHORTCUTS = [
  { labelKey: "settingsAdvanced.promptChainsShortcut", href: "/prompt-chains" },
  { labelKey: "settingsAdvanced.aiUsageShortcut", href: "/dashboard" },
] as const;
