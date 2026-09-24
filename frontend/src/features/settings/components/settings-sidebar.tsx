import { Box, Text } from "@radix-ui/themes";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import {
  ADVANCED_SETTINGS_SHORTCUTS,
  filterSettingsCategories,
  getSettingsCategoryTier,
  type SettingsCategory,
} from "../lib/settings-categories";
import {
  readAdvancedModePreference,
  writeAdvancedModePreference,
} from "../lib/advanced-mode";

/** 设置类目 */
interface SettingsSidebarProps {
  /** 当前选中的类目 */
  activeCategory: SettingsCategory;
  /** 类目变更回调 */
  onCategoryChange: (category: SettingsCategory) => void;
  /** 高级模式变化回调（供移动端列表同步） */
  onAdvancedModeChange?: (enabled: boolean) => void;
  /** 外部受控的高级模式；缺省时组件内部维护 */
  isAdvancedMode?: boolean;
  /** 点击快捷入口跳转前回调（用于关闭设置弹窗） */
  onShortcutNavigate?: () => void;
}

function AdvancedShortcuts({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="settings-sidebar-shortcuts">
      {ADVANCED_SETTINGS_SHORTCUTS.map((shortcut) => (
        <Link
          key={shortcut.href}
          to={shortcut.href}
          className="settings-sidebar-shortcut"
          onClick={onNavigate}
        >
          <Wrench
            size={14}
            aria-hidden="true"
          />
          <Text size="2">{t(shortcut.labelKey)}</Text>
        </Link>
      ))}
    </div>
  );
}

export function SettingsSidebar({
  activeCategory,
  onCategoryChange,
  onAdvancedModeChange,
  isAdvancedMode: isAdvancedModeProp,
  onShortcutNavigate,
}: SettingsSidebarProps) {
  const { t } = useTranslation();
  const [isAdvancedModeState, setAdvancedModeState] = useState(readAdvancedModePreference);
  const [isAdvancedExpanded, setAdvancedExpanded] = useState(isAdvancedModeState);
  const isAdvancedMode = isAdvancedModeProp ?? isAdvancedModeState;

  const items = filterSettingsCategories(isAdvancedMode);
  const basicItems = items.filter((item) => item.tier === "basic");
  const advancedItems = items.filter((item) => item.tier === "advanced");
  const isAdvancedCategoryActive = getSettingsCategoryTier(activeCategory) === "advanced";

  const handleToggleAdvancedMode = (enabled: boolean) => {
    writeAdvancedModePreference(enabled);
    if (isAdvancedModeProp === undefined) setAdvancedModeState(enabled);
    setAdvancedExpanded(enabled);
    if (!enabled && isAdvancedCategoryActive) onCategoryChange("general");
    onAdvancedModeChange?.(enabled);
  };

  const renderItem = (id: SettingsCategory, icon: React.ReactNode, labelKey: string) => {
    const isActive = activeCategory === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => onCategoryChange(id)}
        className={`settings-sidebar-item${isActive ? " settings-sidebar-item--active" : ""}`}
        aria-current={isActive ? "page" : undefined}
      >
        <span
          className="settings-sidebar-item-icon"
          aria-hidden="true"
        >
          {icon}
        </span>
        <Text
          size="2"
          weight={isActive ? "medium" : "regular"}
        >
          {t(labelKey)}
        </Text>
      </button>
    );
  };

  return (
    <nav
      className="settings-sidebar"
      aria-label={t("topbar.settings")}
    >
      <div className="settings-sidebar-list">
        {basicItems.map((category) => renderItem(category.id, category.icon, category.labelKey))}

        {isAdvancedMode ? (
          <Box>
            <button
              type="button"
              className="settings-sidebar-group-toggle"
              onClick={() => setAdvancedExpanded(!isAdvancedExpanded)}
              aria-expanded={isAdvancedExpanded}
            >
              {isAdvancedExpanded ? (
                <ChevronDown
                  size={14}
                  aria-hidden="true"
                />
              ) : (
                <ChevronRight
                  size={14}
                  aria-hidden="true"
                />
              )}
              <Text size="1">{t("settingsAdvanced.advancedGroup")}</Text>
            </button>
            {isAdvancedExpanded
              ? advancedItems.map((category) =>
                  renderItem(category.id, category.icon, category.labelKey),
                )
              : null}
            <AdvancedShortcuts onNavigate={onShortcutNavigate ?? (() => {})} />
            <button
              type="button"
              className="settings-sidebar-advanced-toggle"
              onClick={() => handleToggleAdvancedMode(false)}
            >
              <Text size="2">{t("settingsAdvanced.hideAdvanced")}</Text>
            </button>
          </Box>
        ) : (
          <button
            type="button"
            className="settings-sidebar-advanced-toggle"
            onClick={() => handleToggleAdvancedMode(true)}
          >
            <Text size="2">{t("settingsAdvanced.showAdvanced")}</Text>
          </button>
        )}
      </div>
    </nav>
  );
}
