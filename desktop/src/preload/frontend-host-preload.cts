const { contextBridge, ipcRenderer, webFrame } = require("electron") as typeof import("electron");

const MIN_ZOOM_FACTOR = 0.7;
const MAX_ZOOM_FACTOR = 2.0;
const ZOOM_STEP = 0.1;

function clampZoomFactor(zoomFactor: number): number {
  return Math.round(Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, zoomFactor)) * 10) / 10;
}

function getMenuShortcut(event: KeyboardEvent): string | null {
  if (event.altKey && !event.ctrlKey && !event.metaKey) {
    if (event.code === "KeyW") return "menu-window";
    if (event.code === "KeyI") return "menu-instance";
    if (event.code === "KeyH") return "menu-help";
  }
  if (event.key === "F11" && !event.ctrlKey && !event.altKey && !event.metaKey) return "toggle-full-screen";
  if (event.key === "F12" && !event.ctrlKey && !event.altKey && !event.metaKey) return "toggle-dev-tools";
  if (!event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.shiftKey) {
    if (event.code === "KeyM") return "toggle-maximize";
    return null;
  }
  if (event.code === "KeyM") return "minimize-window";
  if (event.code === "Equal" || event.code === "NumpadAdd") return "zoom-in";
  if (event.code === "Minus" || event.code === "NumpadSubtract") return "zoom-out";
  if (event.code === "Digit0" || event.code === "Numpad0") return "reset-zoom";
  if (event.code === "KeyQ") return "close-window";
  return null;
}

ipcRenderer.on("openfic:zoom-factor", (_event, zoomFactor: unknown) => {
  if (typeof zoomFactor !== "number" || !Number.isFinite(zoomFactor)) return;
  webFrame.setZoomFactor(clampZoomFactor(zoomFactor));
});

window.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey || event.deltaY === 0) return;
    event.preventDefault();
    const zoomFactor = clampZoomFactor(webFrame.getZoomFactor() + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    webFrame.setZoomFactor(zoomFactor);
    ipcRenderer.sendToHost("openfic:zoom-factor", zoomFactor);
  },
  { capture: true, passive: false },
);

window.addEventListener(
  "keydown",
  (event) => {
    const shortcut = getMenuShortcut(event);
    if (!shortcut) return;
    event.preventDefault();
    ipcRenderer.sendToHost("openfic:menu-shortcut", shortcut);
  },
  { capture: true },
);

const AUTO_BACKUP_PAUSE_CHANNEL = "openfic:auto-backup-pause";
const AUTO_BACKUP_PAUSE_ACK_CHANNEL = "openfic:auto-backup-pause-ack";
const AUTO_BACKUP_RESUME_CHANNEL = "openfic:auto-backup-resume";

type AutoBackupPauseHandler = (payload: unknown) => void;
type AutoBackupResumeHandler = (payload: unknown) => void;

const autoBackupPauseHandlers = new Set<AutoBackupPauseHandler>();
const autoBackupResumeHandlers = new Set<AutoBackupResumeHandler>();

/**
 * 主进程可能在页面脚本注册处理器之前发出暂停请求（例如写作窗口刚加载完）。
 *
 * 先缓存再补投，避免把「还没注册」当成「无法确认」；确认仍然由主进程校验请求是否
 * 还在等待中，超时后到达的确认不会被当成成功。
 */
const pendingAutoBackupPauses: unknown[] = [];

ipcRenderer.on(AUTO_BACKUP_PAUSE_CHANNEL, (_event, payload: unknown) => {
  if (autoBackupPauseHandlers.size === 0) {
    pendingAutoBackupPauses.push(payload);
    return;
  }
  for (const handler of autoBackupPauseHandlers) handler(payload);
});

ipcRenderer.on(AUTO_BACKUP_RESUME_CHANNEL, (_event, payload: unknown) => {
  for (const handler of autoBackupResumeHandlers) handler(payload);
});

contextBridge.exposeInMainWorld("openficDesktopHost", {
  publishAppearance: (payload: unknown): void => {
    ipcRenderer.sendToHost("openfic:appearance", payload);
  },
  publishLanguage: (language: unknown): void => {
    ipcRenderer.sendToHost("openfic:language", language);
  },
  publishSocketDiagnostic: (payload: unknown): void => {
    ipcRenderer.sendToHost("openfic:socket-diagnostic", payload);
  },
  onAutoBackupPause: (handler: unknown): (() => void) => {
    if (typeof handler !== "function") return () => {};
    const listener = handler as AutoBackupPauseHandler;
    autoBackupPauseHandlers.add(listener);
    if (pendingAutoBackupPauses.length > 0) {
      for (const payload of pendingAutoBackupPauses.splice(0)) listener(payload);
    }
    return () => {
      autoBackupPauseHandlers.delete(listener);
    };
  },
  onAutoBackupResume: (handler: unknown): (() => void) => {
    if (typeof handler !== "function") return () => {};
    const listener = handler as AutoBackupResumeHandler;
    autoBackupResumeHandlers.add(listener);
    return () => {
      autoBackupResumeHandlers.delete(listener);
    };
  },
  /**
   * 提交「已保存并暂停」确认。返回值由主进程给出：只有这次备份仍在等待该窗口时才是 true。
   *
   * 返回 false 说明主进程已经放弃这次尝试（超时或已结算），写作窗口必须立刻解除暂停，
   * 否则编辑器会停在只读状态。
   */
  acknowledgeAutoBackupPause: async (acknowledgement: unknown): Promise<boolean> => {
    const accepted: unknown = await ipcRenderer.invoke(AUTO_BACKUP_PAUSE_ACK_CHANNEL, acknowledgement);
    return accepted === true;
  },
});
