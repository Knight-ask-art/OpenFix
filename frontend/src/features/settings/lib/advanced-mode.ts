const ADVANCED_MODE_STORAGE_KEY = "openfix.settings.advancedMode";

export function readAdvancedModePreference(): boolean {
  try {
    return localStorage.getItem(ADVANCED_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeAdvancedModePreference(enabled: boolean): void {
  try {
    localStorage.setItem(ADVANCED_MODE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore storage failures; the toggle just won't persist.
  }
}
