import type { DesktopConfig, DesktopInstance, DesktopInstanceAppearance } from "./config.js";

export const IpcChannels = {
  getConfig: "config:get",
  saveConfig: "config:save",
  saveInstanceAppearance: "instance:save-appearance",
  initializeApp: "app:initialize",
  cancelStartup: "app:cancel-startup",
  ensureInstanceSession: "app:ensure-instance-session",
  getDefaultInstallDir: "app:default-install-dir",
  installRuntime: "setup:install-runtime",
  startLocalBackend: "setup:start-local-backend",
  switchInstance: "instance:switch",
  getInstanceDeletionInfo: "instance:get-deletion-info",
  deleteInstance: "instance:delete",
  pingInstance: "instance:ping",
  selectDirectory: "dialog:select-directory",
  inspectLocalRuntime: "setup:inspect-local-runtime",
  setupProgress: "setup:progress",
  getStartupProgress: "app:get-startup-progress",
  startupProgress: "app:startup-progress",
  minimizeWindow: "window:minimize",
  toggleMaximizeWindow: "window:toggle-maximize",
  toggleFullScreen: "window:toggle-full-screen",
  reloadWindow: "window:reload",
  toggleDevTools: "window:toggle-dev-tools",
  closeWindow: "window:close",
  getUpdateState: "update:get-state",
  checkForUpdate: "update:check",
  downloadUpdate: "update:download",
  cancelUpdateDownload: "update:cancel-download",
  installUpdate: "update:install",
  openUpdateRelease: "update:open-release",
  updateState: "update:state",
  exportLogs: "logs:export",
  logFrontendDiagnostic: "logs:frontend-diagnostic",
  reportError: "telemetry:report-error",
  openProjectHome: "help:open-project-home",
  reportBug: "help:report-bug",
  suggestFeature: "help:suggest-feature",
  getZoomFactor: "zoom:get-factor",
  saveZoomFactor: "zoom:save-factor",
  zoomFactorChanged: "zoom:changed",
  getDefaultDataDir: "data:get-default-dir",
  getDataInfo: "data:get-info",
  inspectDataDir: "data:inspect-dir",
  checkPathOverlap: "data:check-path-overlap",
  migrateData: "data:migrate",
  backupData: "data:backup",
  restoreData: "data:restore",
  autoBackupNow: "data:auto-backup-now",
  /**
   * 定时自动备份的写作暂停协议（主进程 <-> 实例内的写作窗口）。
   *
   * 与 data:* 手动操作不同，这三个通道只服务定时自动备份：主进程在停止后端前必须收到
   * 每个在线写作窗口的确认，备份结束后无论成败都要解除暂停。
   */
  autoBackupPause: "openfic:auto-backup-pause",
  autoBackupPauseAck: "openfic:auto-backup-pause-ack",
  autoBackupResume: "openfic:auto-backup-resume",
  dataProgress: "data:progress",
  selectSaveFile: "dialog:select-save-file",
  selectOpenFile: "dialog:select-open-file",
} as const;

export type SetupStep =
  | "download-python"
  | "extract-python"
  | "create-venv"
  | "install-uv"
  | "install-openfic";

export interface SetupProgressEvent {
  step: SetupStep;
  status: "running" | "done" | "failed";
  message: string;
  /** Download/extraction progress as a 0..1 fraction when available. */
  progress?: number;
}

export interface SaveConfigRequest {
  config: DesktopConfig;
}

export interface SaveInstanceAppearanceRequest extends DesktopInstanceAppearance {
  instanceId: string;
}

export interface SaveZoomFactorRequest {
  zoomFactor: number;
}

export interface LogFrontendDiagnosticRequest {
  message: string;
}

export interface ReportErrorPayload {
  name: string;
  message: string;
  stack?: string;
}

export interface EnsureInstanceSessionRequest {
  partition: string;
}

export interface SwitchInstanceRequest {
  instanceId: string;
}

export interface GetInstanceDeletionInfoRequest {
  instanceId: string;
}

export interface InstanceDeletionInfo {
  dataDir: string | null;
  dataDirShared: boolean;
  runtimeDir: string | null;
  runtimeDirShared: boolean;
}

export interface DeleteInstanceRequest {
  instanceId: string;
  deleteData: boolean;
}

export interface DeleteInstanceResult {
  nextActiveInstanceId: string | null;
}

export interface PingInstanceRequest {
  instance: DesktopInstance;
}

export interface PingInstanceResult {
  latencyMs: number;
}

export interface InstallRuntimeRequest {
  installDir: string;
}

export interface StartLocalBackendRequest {
  installDir: string;
  dataDir?: string | null;
}

export interface InspectLocalRuntimeRequest {
  installDir: string;
}

export interface InspectLocalRuntimeResult {
  status: "missing" | "incomplete" | "ready";
  message: string;
  configuredInstance: DesktopInstance | null;
}

export interface InitializeAppResult {
  status: "ready" | "needs-setup";
  activeInstanceId?: string | null;
  message?: string;
  compatibilityWarning?: string;
  maintenanceWarning?: string;
}

export type StartupStep =
  | "load-config"
  | "check-runtime"
  | "update-python"
  | "update-openfic"
  | "start-backend"
  | "initialize-backend"
  | "initialize-database"
  | "complete-backend-startup"
  | "check-health"
  | "maintain-database"
  | "connect-remote"
  | "verify-remote"
  | "check-compatibility"
  | "ready";

export interface StartupProgressEvent {
  step: StartupStep;
  status: "running" | "done" | "failed";
  title: string;
  message: string;
  /** Overall startup progress as a 0..1 fraction. */
  progress: number;
  /** Whether the current operation has no reliable percentage. */
  indeterminate?: boolean;
  /** Backend maintenance phase used to localize the current detail. */
  maintenancePhase?:
    | "pending"
    | "pruning"
    | "migrating"
    | "vacuuming"
    | "cleanup"
    | "ready"
    | "failed";
  /** Backend maintenance internal progress (0..1), shown as text detail. */
  maintenanceProgress?: number | null;
  /** Backend maintenance reclaimed bytes (current), shown as text detail. */
  maintenanceReclaimedBytes?: number | null;
  /** Backend maintenance estimated total bytes, shown as text detail. */
  maintenanceTotalBytes?: number | null;
  /** Backend maintenance VACUUM VM operations, shown as text detail. */
  maintenanceVmOps?: number | null;
  /** Backend maintenance elapsed seconds, shown as text detail. */
  maintenanceElapsedSeconds?: number | null;
}

export type UpdateStatus = "unsupported" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "not-available" | "error";

export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  releaseNotes?: string;
  progress?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  message?: string;
}

export interface DataInfo {
  /** Resolved absolute path of the instance data directory. */
  dataDir: string;
  /** Whether the instance falls back to the default data location. */
  isDefaultLocation: boolean;
  /** Whether the data directory overlaps an application or runtime installation directory. */
  nestedWithInstallDir: boolean;
  hasData: boolean;
  entryCount: number;
  sizeBytes: number;
  /**
   * 最近一次定时自动备份的失败原因；没有未恢复的失败时为 null。
   *
   * 定时备份没有用户触发的调用点，只靠 dataProgress 事件会随页面卸载一起丢失，
   * 因此失败原因由主进程保留，并在每次读取数据信息时一并返回。
   */
  autoBackupError: string | null;
}

export interface InspectDataDirResult {
  /** Whether the directory contains recognizable OpenFic data. */
  valid: boolean;
  /** Whether the inspected directory overlaps an application or supplied installation directory. */
  nestedWithInstallDir: boolean;
  hasData: boolean;
  entryCount: number;
  sizeBytes: number;
}

export interface GetDataInfoRequest {
  instanceId: string;
}

export interface InspectDataDirRequest {
  dataDir: string;
  installDir?: string;
}

export interface CheckPathOverlapRequest {
  dataDir: string;
  installDir?: string;
}

export interface MigrateDataRequest {
  instanceId: string;
  newDataDir: string;
  deleteOldDir: boolean;
}

export interface MigrateDataResult {
  dataDir: string;
  migrated: boolean;
  removedOldDir: boolean;
}

export interface BackupDataRequest {
  instanceId: string;
  targetPath: string;
}

/** 立即执行一次自动备份（忽略 24 小时间隔判断）。 */
export interface AutoBackupNowRequest {
  instanceId: string;
}

/**
 * 定时自动备份要求写作窗口确认「当前章节已保存且编辑已暂停」的等待上限。
 *
 * 超时即取消本次尝试：既不停后端也不归档，避免后端在编辑器还有未保存章节时被停掉。
 * 失败的尝试不写任何成功状态，由下一个调度周期重试。
 */
export const AUTO_BACKUP_PAUSE_TIMEOUT_MS = 20_000;

/** 定时自动备份开始前，主进程发给实例内每个在线写作窗口的暂停请求。 */
export interface AutoBackupPauseRequest {
  requestId: string;
}

/** 写作窗口对暂停请求的确认；只有 ok 为 true 时主进程才会停止后端。 */
export interface AutoBackupPauseAck {
  requestId: string;
  ok: boolean;
  /** 未能确认的稳定原因标识（写作窗口侧），仅 ok 为 false 时出现。 */
  reason?: string;
}

/** 自动备份结束后解除写作暂停；归档失败或恢复服务失败时同样发送。 */
export interface AutoBackupResumeRequest {
  requestId: string;
}

export interface RestoreDataRequest {
  instanceId: string;
  sourcePath: string;
}

export type DataOperationPhase = "extract" | "verify" | "rollback" | "copy" | "cleanup" | "pack" | "delete-old";

/** 数据操作阶段：done 与 error 是终态，只有定时自动备份会发出。 */
export type DataProgressPhase = DataOperationPhase | "done" | "error";

export interface DataProgressEvent {
  operation: "backup" | "restore" | "migrate";
  phase: DataProgressPhase;
  /** Overall progress of the current phase as a 0..1 fraction when available. */
  progress?: number;
  /** 事件来自定时自动备份，而不是用户手动触发的操作。 */
  automatic?: boolean;
  /** 自动备份失败原因；只随 automatic 的 error 终态出现。 */
  message?: string;
}
