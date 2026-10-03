import { app, dialog, ipcMain, session, shell, webContents, type BrowserWindow, type WebContents } from "electron";
import path from "node:path";
import {
  AUTO_BACKUP_PAUSE_TIMEOUT_MS,
  IpcChannels,
  type AutoBackupNowRequest,
  type AutoBackupPauseAck,
  type BackupDataRequest,
  type CheckPathOverlapRequest,
  type DataProgressEvent,
  type DeleteInstanceRequest,
  type DeleteInstanceResult,
  type EnsureInstanceSessionRequest,
  type GetDataInfoRequest,
  type GetInstanceDeletionInfoRequest,
  type InitializeAppResult,
  type InspectDataDirRequest,
  type InspectLocalRuntimeRequest,
  type InspectLocalRuntimeResult,
  type InstallRuntimeRequest,
  type LogFrontendDiagnosticRequest,
  type MigrateDataRequest,
  type MigrateDataResult,
  type PingInstanceRequest,
  type PingInstanceResult,
  type ReportErrorPayload,
  type RestoreDataRequest,
  type SaveConfigRequest,
  type SaveInstanceAppearanceRequest,
  type SaveZoomFactorRequest,
  type StartLocalBackendRequest,
  type SwitchInstanceRequest,
} from "../shared/ipc.js";
import { createDefaultConfig, readDesktopConfig, writeDesktopConfig } from "./config.js";
import {
  AUTO_BACKUP_CHECK_INTERVAL_MS,
  AUTO_BACKUP_STARTUP_DELAY_MS,
  buildAutoBackupFileName,
  getAutoBackupTarget,
  resolveAutoBackupInstance,
  rotateAutoBackups,
  shouldRunAutoBackup,
} from "./auto-backup.js";
import { ensureAppProtocolForPartition } from "./protocol.js";
import { findLocalInstanceByInstallDir, normalizeInstallDir } from "./local-instance.js";
import { inspectLocalRuntime, installLocalRuntime, startLocalBackendFromInstall } from "./runtime/setup-runner.js";
import { getDefaultInstallDir, resolveRuntimeDir } from "./runtime/python.js";
import { INSTANCE_DATA_ENTRIES } from "./runtime/tar-extract.js";
import { getDefaultDataDir, normalizeDataDir, resolveDataDir } from "./data-location.js";
import {
  arePathsEqual,
  assertBackupDirOutsideDataDir,
  backupDataDir,
  doPathsOverlap,
  getDataOperationOptions,
  inspectDataDir,
  isPathWithin,
  migrateDataDir,
  removeDataDir,
  restoreDataDir,
} from "./data-manager.js";
import { cancelUpdateDownload, checkForUpdates, downloadUpdate, getUpdateState, installUpdate, openUpdateRelease } from "./updater.js";
import { createStartupProgressTracker, getStartupProgress } from "./startup-progress.js";
import { appendLog, exportLogs } from "./logging.js";
import { captureException } from "./telemetry.js";
import type { BackendProcessHandle } from "./process.js";
import { isDesktopInstanceAppearance, normalizeAutoBackupSettings, type DesktopConfig, type DesktopInstance } from "../shared/config.js";

const PROJECT_HOME_URL = "https://github.com/Knight-ask-art/OpenFix";
const BUG_REPORT_URL = "https://github.com/Knight-ask-art/OpenFix/issues/new?template=bug-report.yml";
const FEATURE_SUGGESTION_URL = "https://github.com/Knight-ask-art/OpenFix/issues/new?template=feature-request.yml";
const MIN_ZOOM_FACTOR = 0.7;
const MAX_ZOOM_FACTOR = 2.0;
const DEFAULT_ZOOM_FACTOR = 1.1;

interface LocalInstanceDeletionPaths {
  dataDir: string;
  runtimeDir: string;
}

function normalizeZoomFactor(zoomFactor: number): number {
  const clampedZoomFactor = Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, zoomFactor));
  return Math.round(clampedZoomFactor * 10) / 10;
}

function isSaveInstanceAppearanceRequest(value: unknown): value is SaveInstanceAppearanceRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as SaveInstanceAppearanceRequest;
  return typeof candidate.instanceId === "string" && isDesktopInstanceAppearance(candidate);
}

function getLocalInstanceDeletionPaths(instance: DesktopInstance): LocalInstanceDeletionPaths {
  const installDir = instance.installDir ?? getDefaultInstallDir();
  const dataDir = resolveDataDir(instance);
  if (!path.isAbsolute(installDir) || !path.isAbsolute(dataDir)) {
    throw new Error("实例目录必须是绝对路径");
  }
  return {
    dataDir: path.resolve(dataDir),
    runtimeDir: path.resolve(resolveRuntimeDir(installDir)),
  };
}

async function isDataDirNestedWithInstallDirectory(dataDir: string, runtimeInstallDir?: string): Promise<boolean> {
  const installDirs = [path.dirname(app.getPath("exe"))];
  if (runtimeInstallDir) {
    const [isDefaultDataDir, isDefaultInstallDir] = await Promise.all([
      arePathsEqual(dataDir, getDefaultDataDir()),
      arePathsEqual(runtimeInstallDir, getDefaultInstallDir()),
    ]);
    if (!isDefaultDataDir || !isDefaultInstallDir) installDirs.push(resolveRuntimeDir(runtimeInstallDir));
  }
  const overlaps = await Promise.all(installDirs.map((installDir) => doPathsOverlap(dataDir, installDir)));
  return overlaps.some(Boolean);
}

async function isDataDirShared(
  config: DesktopConfig,
  instance: DesktopInstance,
  instancePaths: LocalInstanceDeletionPaths,
): Promise<boolean> {
  for (const candidate of config.instances) {
    if (candidate.id === instance.id || candidate.mode !== "local") continue;
    const candidatePaths = getLocalInstanceDeletionPaths(candidate);
    if (
      await doPathsOverlap(instancePaths.dataDir, candidatePaths.dataDir) ||
      await doPathsOverlap(instancePaths.dataDir, candidatePaths.runtimeDir)
    ) return true;
  }
  return false;
}

async function isRuntimeDirShared(
  config: DesktopConfig,
  instance: DesktopInstance,
  instancePaths: LocalInstanceDeletionPaths,
): Promise<boolean> {
  for (const candidate of config.instances) {
    if (candidate.id === instance.id || candidate.mode !== "local") continue;
    const candidatePaths = getLocalInstanceDeletionPaths(candidate);
    if (
      await doPathsOverlap(instancePaths.runtimeDir, candidatePaths.runtimeDir) ||
      await doPathsOverlap(instancePaths.runtimeDir, candidatePaths.dataDir)
    ) return true;
  }
  return false;
}

async function assertSafeRuntimeDataPaths(instancePaths: LocalInstanceDeletionPaths): Promise<void> {
  const isDefaultDataDir = await arePathsEqual(instancePaths.dataDir, getDefaultDataDir());
  const pathsOverlap = await doPathsOverlap(instancePaths.runtimeDir, instancePaths.dataDir);
  const runtimeIsWithinData = await isPathWithin(instancePaths.dataDir, instancePaths.runtimeDir);
  if (pathsOverlap && (!isDefaultDataDir || !runtimeIsWithinData)) {
    throw new Error("实例的运行环境目录与数据目录重叠，无法安全删除");
  }
}

async function removeInstanceResources(
  instancePaths: LocalInstanceDeletionPaths,
  deleteData: boolean,
  runtimeDirShared: boolean,
): Promise<void> {
  const isDefaultDataDir = await arePathsEqual(instancePaths.dataDir, getDefaultDataDir());
  await assertSafeRuntimeDataPaths(instancePaths);

  const pathsToRemove: string[] = [];
  if (!runtimeDirShared) {
    pathsToRemove.push(instancePaths.runtimeDir);
  }

  if (deleteData) {
    if (isDefaultDataDir) {
      pathsToRemove.push(...[...INSTANCE_DATA_ENTRIES].map((entry) => path.join(instancePaths.dataDir, entry)));
    } else {
      pathsToRemove.push(instancePaths.dataDir);
    }
  }

  let firstError: unknown = null;
  for (const filePath of pathsToRemove) {
    try {
      await removeDataDir(filePath);
    } catch (error) {
      appendLog("instance", `清理实例资源失败：${filePath}：${error instanceof Error ? error.message : String(error)}`);
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

/**
 * 校验用户新选择或新填写的自动备份目录，返回是否需要清除已记录的自动备份失败。
 *
 * 目录与数据目录重叠时会让历史备份被反复收进后续备份，还原时还会连同这些备份覆盖用户数据，
 * 因此在保存阶段就按既有错误流程拒绝。需要校验的是目标发生变化：目录被更换，或一个此前
 * 未启用的目标被启用；目标本身未变化时不重复校验，避免阻断其他无关设置的保存。
 * 目录为空或未启用时没有可执行的备份目标，历史失败不再展示，直接返回 true。
 */
async function assertAutoBackupDirUpdateAllowed(
  previous: DesktopConfig | null,
  next: DesktopConfig,
): Promise<boolean> {
  const nextDir = next.autoBackup?.dir ?? null;
  if (typeof nextDir !== "string" || nextDir.length === 0) return true;
  if (next.autoBackup?.enabled !== true) return true;
  const previousSettings = previous?.autoBackup;
  if (previousSettings?.enabled === true && nextDir === (previousSettings.dir ?? null)) return false;
  const instance = resolveAutoBackupInstance(next);
  if (!instance) return false;
  try {
    await assertBackupDirOutsideDataDir(resolveDataDir(instance), nextDir);
  } catch (error) {
    appendLog("data", `拒绝自动备份目录：${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  return true;
}

function getNextActiveInstanceId(config: DesktopConfig, remainingInstances: DesktopInstance[]): string | null {
  if (config.activeInstanceId && remainingInstances.some((instance) => instance.id === config.activeInstanceId)) {
    return config.activeInstanceId;
  }
  return remainingInstances.find((instance) => instance.favorite)?.id ?? remainingInstances[0]?.id ?? null;
}

/**
 * 停止后端成功后由主进程返回的私有恢复闭包：在同一个端口上重新初始化服务。
 * 只交给没有用户返回路径的调用方（自动备份）；手动数据操作忽略它。
 */
export type BackendResume = () => Promise<InitializeAppResult>;

export interface IpcContext {
  shellWindow: () => BrowserWindow | null;
  setBackend: (handle: BackendProcessHandle) => void;
  setBackendBaseUrl: (url: string) => void;
  setLogsDir: (dataDir: string | null) => void;
  beginStartupOperation: () => AbortController;
  finishStartupOperation: (controller: AbortController) => void;
  initializeApp: () => Promise<InitializeAppResult>;
  cancelStartup: () => void;
  switchInstance: (instanceId: string) => Promise<InitializeAppResult>;
  pingInstance: (instance: DesktopInstance) => Promise<number>;
  onConfigSaved: (config: DesktopConfig) => void;
  isBackendRunning: () => boolean;
  stopActiveBackend: () => Promise<BackendResume | null>;
}

function createInstanceId(): string {
  return `instance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const WEBVIEW_SHUTDOWN_WAIT_MS = 10_000;

async function waitForInstanceWebViews(instanceId: string): Promise<void> {
  const targetSession = session.fromPartition(`persist:openfic-${instanceId}`);
  const guests = webContents
    .getAllWebContents()
    .filter((contents) => contents.session === targetSession && !contents.isDestroyed());
  if (guests.length === 0) return;
  await Promise.race([
    Promise.all(
      guests.map(
        (contents) =>
          new Promise<void>((resolve) => {
            contents.once("destroyed", () => resolve());
          }),
      ),
    ),
    new Promise<void>((resolve) => setTimeout(resolve, WEBVIEW_SHUTDOWN_WAIT_MS)),
  ]);
}

async function clearInstanceSession(instanceId: string): Promise<void> {
  const targetSession = session.fromPartition(`persist:openfic-${instanceId}`);
  await targetSession.clearStorageData();
  await targetSession.clearAuthCache();
  await targetSession.clearCache();
  await targetSession.closeAllConnections();
}

/** 定时自动备份的暂停确认所对应的失败原因，写作窗口只上报稳定标识。 */
const WRITING_PAUSE_REASON_LABELS: Record<string, string> = {
  "editor-unavailable": "编辑器未就绪",
  "agent-locked": "章节正被 Agent 编辑",
  "content-limit": "章节内容超出编辑器上限",
  "save-failed": "章节保存失败",
  "pause-failed": "写作窗口未能暂停",
};

function describeWritingPauseFailure(reason: string | null): string {
  if (!reason) return "写作窗口未确认保存";
  return `写作窗口未确认保存（${WRITING_PAUSE_REASON_LABELS[reason] ?? reason}）`;
}

/**
 * 解析写作窗口的暂停确认。形状不认识就返回 null：调用方据此拒绝该确认，
 * 绝不把未知响应当成保存成功。
 */
function parseWritingPauseAck(payload: unknown): AutoBackupPauseAck | null {
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as { requestId?: unknown; ok?: unknown; reason?: unknown };
  if (typeof candidate.requestId !== "string" || candidate.requestId.length === 0) return null;
  if (typeof candidate.ok !== "boolean") return null;
  if (candidate.reason !== undefined && typeof candidate.reason !== "string") return null;
  return {
    requestId: candidate.requestId,
    ok: candidate.ok,
    ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
  };
}

export function registerIpc(context: IpcContext): void {
  let pendingConfigMutation: Promise<void> = Promise.resolve();

  function enqueueConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = pendingConfigMutation.then(operation);
    pendingConfigMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * 停止正在运行的后端再执行操作。手动数据操作依赖用户从数据管理页返回时重启，
   * 因此默认不重启；只有自动备份这类无用户返回路径的调用方传入 onSuspended，
   * 在停止成功后拿到私有恢复闭包自行恢复。停止失败时不发布闭包，也不执行操作。
   *
   * 定时自动备份已经用写作窗口的保存确认代替了「等 webview 关闭」，因此传
   * skipWebViewWait 跳过这段等待：原来的等待等不到也照常继续，不能当作保存成功。
   */
  async function withBackendRestart<T>(
    instanceId: string,
    operation: () => Promise<T>,
    onSuspended?: (resume: BackendResume | null) => void,
    options?: { skipWebViewWait?: boolean },
  ): Promise<T> {
    if (options?.skipWebViewWait !== true) await waitForInstanceWebViews(instanceId);
    if (context.isBackendRunning()) {
      const resume = await context.stopActiveBackend();
      onSuspended?.(resume);
    }
    return operation();
  }

  let autoBackupTimer: NodeJS.Timeout | null = null;
  let isAutoBackupRunning = false;
  /**
   * 最近一次自动备份失败的原因。
   *
   * 定时备份没有用户触发的调用点，只在事件里报告失败会随页面卸载一起丢失，因此失败原因
   * 留在主进程，由数据管理页通过 getDataInfo 读取；用户修正目录、关闭自动备份或下一次
   * 成功后立即清除，避免展示已经恢复的失败。
   */
  let autoBackupFailure: string | null = null;

  /**
   * 一次定时自动备份已经确认过保存的写作窗口：备份结束后按它解除暂停。
   *
   * 只保留 WebContents 引用与请求 id；确认过程中窗口被销毁时按「没有需要解除的暂停」处理。
   */
  interface WritingPauseHandle {
    requestId: string;
    targets: WebContents[];
  }

  interface PendingWritingPause {
    requestId: string;
    targets: WebContents[];
    acknowledged: Set<number>;
    settled: boolean;
    timer: NodeJS.Timeout;
    resolve: (failure: string | null) => void;
  }

  const pendingWritingPauses = new Map<string, PendingWritingPause>();

  function settleWritingPause(pending: PendingWritingPause, failure: string | null): void {
    if (pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    pendingWritingPauses.delete(pending.requestId);
    pending.resolve(failure);
  }

  /** 解除写作暂停。窗口已经销毁时无需解除，也不影响备份结果。 */
  function releaseWritingPause(pause: WritingPauseHandle | null): void {
    if (!pause) return;
    for (const target of pause.targets) {
      try {
        if (target.isDestroyed()) continue;
        target.send(IpcChannels.autoBackupResume, { requestId: pause.requestId });
      } catch {
        // 窗口在备份期间被销毁：没有需要解除的暂停。
      }
    }
  }

  /**
   * 定时自动备份的准入：要求目标实例里每个在线写作窗口确认「当前章节已保存且编辑已暂停」。
   *
   * 全部确认后才返回暂停句柄，调用方随后才能停止后端。任何一个窗口保存失败、被 Agent
   * 锁定、返回无法识别的确认或超时，都抛出错误取消这次尝试：不停后端、不归档、不轮换，
   * 也不写任何成功状态，由下一个调度周期重试。取消前会给已经确认的窗口补发解除。
   *
   * 没有在线窗口时返回 null：没有编辑器就没有待保存的内容，也没有需要解除的暂停。
   */
  async function requestWritingPause(instanceId: string): Promise<WritingPauseHandle | null> {
    const targetSession = session.fromPartition(`persist:openfic-${instanceId}`);
    const targets = webContents
      .getAllWebContents()
      .filter(
        (contents) =>
          contents.getType() === "webview" &&
          !contents.isDestroyed() &&
          contents.session === targetSession,
      );
    if (targets.length === 0) return null;

    const requestId = `auto-backup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let settlePause: (failure: string | null) => void = () => undefined;
    const outcome = new Promise<string | null>((resolve) => {
      settlePause = resolve;
    });
    const pending: PendingWritingPause = {
      requestId,
      targets,
      acknowledged: new Set<number>(),
      settled: false,
      timer: setTimeout(
        () =>
          settleWritingPause(
            pending,
            `写作窗口未在 ${Math.round(AUTO_BACKUP_PAUSE_TIMEOUT_MS / 1000)} 秒内确认保存并暂停`,
          ),
        AUTO_BACKUP_PAUSE_TIMEOUT_MS,
      ),
      resolve: settlePause,
    };
    pendingWritingPauses.set(requestId, pending);

    for (const target of targets) {
      try {
        target.send(IpcChannels.autoBackupPause, { requestId });
      } catch (error) {
        settleWritingPause(
          pending,
          `写作窗口不可用（${error instanceof Error ? error.message : String(error)}）`,
        );
        break;
      }
    }

    const failure = await outcome;
    const handle: WritingPauseHandle = { requestId, targets };
    if (failure !== null) {
      // 部分窗口可能已经确认并进入暂停：取消这次尝试前必须解除，否则它们会一直停在暂停状态。
      releaseWritingPause(handle);
      throw new Error(failure);
    }
    return handle;
  }

  ipcMain.handle(IpcChannels.autoBackupPauseAck, (event, payload: unknown): boolean => {
    const ack = parseWritingPauseAck(payload);
    if (!ack) return false;
    const pending = pendingWritingPauses.get(ack.requestId);
    if (!pending || pending.settled) return false;
    // 只接受这次备份真正请求过的窗口，其它来源的确认一律不认。
    if (!pending.targets.some((target) => target.id === event.sender.id)) return false;
    if (!ack.ok) {
      settleWritingPause(pending, describeWritingPauseFailure(ack.reason ?? null));
      return true;
    }
    pending.acknowledged.add(event.sender.id);
    if (pending.acknowledged.size === pending.targets.length) settleWritingPause(pending, null);
    return true;
  });

  const executeAutoBackup = async (): Promise<void> => {
    if (isAutoBackupRunning) return;
    isAutoBackupRunning = true;
    try {
      const outcome = await enqueueConfigMutation(async () => {
        // 排队后重新读取已提交配置，按当前 enabled/dir/keep/instance/data/runtime 准入，
        // 而不是排队前捕获的目标；这样完成的禁用、改目录/实例或刚完成的手动备份都能生效。
        const config = await readDesktopConfig();
        const target = getAutoBackupTarget(config);
        const backupDir = target?.settings.dir ?? null;
        if (!target || !backupDir) return null;

        // 目标与数据目录重叠时按既有错误流程失败：不停止后端，也不发布会反复收进旧备份的文件。
        // 复核排在“是否到期”之前：失败原因只留在内存里，应用重启后如果重叠来自数据目录变更，
        // 而最近一次归档还不到 24 小时，就没有任何备份尝试会去暴露它；每个调度周期都按当前
        // 配置重新校验已保存的启用目标，启动后的首次检查即可重新报出该错误。
        await assertBackupDirOutsideDataDir(target.dataDir, backupDir);
        if (!(await shouldRunAutoBackup(backupDir))) return null;
        const dataOptions = await getDataOperationOptions(target.dataDir, target.runtimeDir);
        // 写作窗口的保存确认排在停止后端之前：任何一个在线窗口没确认就取消这次尝试，
        // 既不停后端也不归档，失败的尝试由下一个调度周期重试。
        const writingPause = await requestWritingPause(target.instanceId);
        const suspended: { resume: BackendResume | null } = { resume: null };
        let operationError: string | null = null;
        let resumeError: string | null = null;
        try {
          try {
            await withBackendRestart(
              target.instanceId,
              async () => {
                const emitProgress = (event: DataProgressEvent) =>
                  context.shellWindow()?.webContents.send(IpcChannels.dataProgress, event);
                const fileName = buildAutoBackupFileName(new Date());
                const targetPath = path.join(backupDir, fileName);
                appendLog("data", `auto backup: ${target.dataDir} -> ${targetPath}`);
                await backupDataDir(
                  target.dataDir,
                  targetPath,
                  (message) => appendLog("data", message),
                  (phase, progress) => emitProgress({ operation: "backup", phase, progress }),
                  dataOptions.backup,
                );
                await rotateAutoBackups(backupDir, target.settings.keep);
                appendLog("data", `auto backup done: ${fileName}`);
              },
              (resume) => {
                suspended.resume = resume;
              },
              { skipWebViewWait: true },
            );
          } catch (error) {
            operationError = error instanceof Error ? error.message : String(error);
          }
          const resume = suspended.resume;
          if (resume) {
            // 定时备份没有用户返回数据管理页的重启路径，成功或失败都必须恢复原来的服务。
            try {
              const result = await resume();
              if (result.status !== "ready") throw new Error(`服务未就绪（${result.status}）`);
            } catch (error) {
              resumeError = error instanceof Error ? error.message : String(error);
            }
          }
          return { operationError, resumeError };
        } finally {
          // 归档或恢复服务无论成败都要解除写作暂停，否则编辑器会一直停在只读状态。
          releaseWritingPause(writingPause);
        }
      });
      if (outcome === null) return;
      if (outcome.operationError !== null || outcome.resumeError !== null) {
        const failures: string[] = [];
        if (outcome.operationError !== null) failures.push(`备份失败：${outcome.operationError}`);
        if (outcome.resumeError !== null) failures.push(`恢复服务失败：${outcome.resumeError}`);
        throw new Error(failures.join("；"));
      }
      autoBackupFailure = null;
      context.shellWindow()?.webContents.send(
        IpcChannels.dataProgress,
        { operation: "backup", phase: "done", progress: 1, automatic: true },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog("data", `自动备份失败：${message}`);
      autoBackupFailure = message;
      context.shellWindow()?.webContents.send(
        IpcChannels.dataProgress,
        { operation: "backup", phase: "error", progress: 0, automatic: true, message },
      );
    } finally {
      isAutoBackupRunning = false;
    }
  };

  function startAutoBackupScheduler(): void {
    if (autoBackupTimer) return;
    autoBackupTimer = setInterval(executeAutoBackup, AUTO_BACKUP_CHECK_INTERVAL_MS);
    setTimeout(executeAutoBackup, AUTO_BACKUP_STARTUP_DELAY_MS);
  }

  const saveZoomFactor = async (zoomFactor: number): Promise<number> => {
    const clampedZoomFactor = normalizeZoomFactor(zoomFactor);
    const config = await readDesktopConfig();
    await writeDesktopConfig({ ...(config ?? createDefaultConfig()), zoomFactor: clampedZoomFactor });
    context.shellWindow()?.webContents.send(IpcChannels.zoomFactorChanged, clampedZoomFactor);
    return clampedZoomFactor;
  };

  ipcMain.handle(IpcChannels.getConfig, () => readDesktopConfig());

  ipcMain.handle(IpcChannels.saveConfig, (_event, request: SaveConfigRequest) => enqueueConfigMutation(async () => {
    const previousConfig = await readDesktopConfig();
    const nextConfig = { ...request.config, zoomFactor: previousConfig?.zoomFactor };
    const targetReverified = await assertAutoBackupDirUpdateAllowed(previousConfig, nextConfig);
    if (targetReverified) autoBackupFailure = null;
    await writeDesktopConfig(nextConfig);
    context.onConfigSaved(nextConfig);
  }));

  ipcMain.handle(
    IpcChannels.saveInstanceAppearance,
    (_event, request: SaveInstanceAppearanceRequest) =>
      enqueueConfigMutation(async () => {
        if (!isSaveInstanceAppearanceRequest(request)) throw new Error("无效的实例外观配置");
        const config = await readDesktopConfig();
        if (!config) return;
        if (!config.instances.some((instance) => instance.id === request.instanceId)) return;
        const nextConfig: DesktopConfig = {
          ...config,
          instances: config.instances.map((instance) =>
            instance.id === request.instanceId
              ? {
                  ...instance,
                  ...(request.appearance === undefined ? {} : { appearance: request.appearance }),
                  ...(request.fontFamily === undefined ? {} : { fontFamily: request.fontFamily }),
                  ...(request.codeFontFamily === undefined ? {} : { codeFontFamily: request.codeFontFamily }),
                  ...(request.themeVariables === undefined ? {} : { themeVariables: request.themeVariables }),
                }
              : instance,
          ),
        };
        await writeDesktopConfig(nextConfig);
      }),
  );

  ipcMain.handle(IpcChannels.getZoomFactor, async () => {
    await pendingConfigMutation;
    return normalizeZoomFactor((await readDesktopConfig())?.zoomFactor ?? DEFAULT_ZOOM_FACTOR);
  });

  ipcMain.handle(IpcChannels.saveZoomFactor, (_event, request: SaveZoomFactorRequest) => {
    if (!Number.isFinite(request.zoomFactor)) return;
    return enqueueConfigMutation(() => saveZoomFactor(request.zoomFactor));
  });

  ipcMain.handle(IpcChannels.initializeApp, () => context.initializeApp());
  ipcMain.handle(IpcChannels.cancelStartup, () => context.cancelStartup());
  ipcMain.handle(IpcChannels.getStartupProgress, () => getStartupProgress());
  ipcMain.handle(IpcChannels.getUpdateState, () => getUpdateState());
  ipcMain.handle(IpcChannels.checkForUpdate, () => checkForUpdates());
  ipcMain.handle(IpcChannels.downloadUpdate, () => downloadUpdate());
  ipcMain.handle(IpcChannels.cancelUpdateDownload, () => cancelUpdateDownload());
  ipcMain.handle(IpcChannels.installUpdate, () => installUpdate());
  ipcMain.handle(IpcChannels.openUpdateRelease, () => openUpdateRelease());
  ipcMain.handle(IpcChannels.exportLogs, async () => {
    const defaultPath = path.join(
      app.getPath("downloads"),
      `openfic-backend-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`,
    );
    const window = context.shellWindow();
    const result = window
      ? await dialog.showSaveDialog(window, {
          defaultPath,
          filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }],
          title: "导出后端日志",
        })
      : await dialog.showSaveDialog({
          defaultPath,
          filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }],
          title: "导出后端日志",
        });
    if (result.canceled || !result.filePath) return null;

    try {
      return await exportLogs(result.filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox("导出后端日志失败", message);
      throw error;
    }
  });

  ipcMain.handle(IpcChannels.logFrontendDiagnostic, (_event, request: LogFrontendDiagnosticRequest) => {
    if (typeof request?.message !== "string") return;
    appendLog("connect", request.message.slice(0, 4_000));
  });

  ipcMain.on(IpcChannels.reportError, (_event, payload: ReportErrorPayload) => {
    if (!payload || typeof payload.message !== "string") return;
    const error = new Error(payload.message);
    error.name = typeof payload.name === "string" ? payload.name : "Error";
    if (typeof payload.stack === "string") error.stack = payload.stack;
    captureException(error, { source: "shell-ui" });
  });

  ipcMain.handle(IpcChannels.ensureInstanceSession, (_event, request: EnsureInstanceSessionRequest) => {
    return ensureAppProtocolForPartition(request.partition);
  });

  ipcMain.handle(IpcChannels.getDefaultInstallDir, () => getDefaultInstallDir());

  ipcMain.handle(IpcChannels.getInstanceDeletionInfo, async (_event, request: GetInstanceDeletionInfoRequest) => {
    if (typeof request?.instanceId !== "string") throw new Error("无效的实例标识");
    const config = await readDesktopConfig();
    if (!config) throw new Error("未找到 OpenFix 实例配置");
    const instance = config.instances.find((item) => item.id === request.instanceId);
    if (!instance) throw new Error("实例不存在");
    if (instance.mode !== "local") {
      return { dataDir: null, dataDirShared: false, runtimeDir: null, runtimeDirShared: false };
    }
    const instancePaths = getLocalInstanceDeletionPaths(instance);
    const [dataDirShared, runtimeDirShared] = await Promise.all([
      isDataDirShared(config, instance, instancePaths),
      isRuntimeDirShared(config, instance, instancePaths),
    ]);
    return {
      dataDir: instancePaths.dataDir,
      dataDirShared,
      runtimeDir: instancePaths.runtimeDir,
      runtimeDirShared,
    };
  });

  ipcMain.handle(
    IpcChannels.deleteInstance,
    (_event, request: DeleteInstanceRequest) => enqueueConfigMutation(async (): Promise<DeleteInstanceResult> => {
      if (typeof request?.instanceId !== "string" || typeof request.deleteData !== "boolean") {
        throw new Error("无效的实例删除请求");
      }
      const config = await readDesktopConfig();
      if (!config) throw new Error("未找到 OpenFix 实例配置");
      const instance = config.instances.find((item) => item.id === request.instanceId);
      if (!instance) throw new Error("实例不存在");
      const instancePaths = instance.mode === "local" ? getLocalInstanceDeletionPaths(instance) : null;
      const dataDirShared = instancePaths ? await isDataDirShared(config, instance, instancePaths) : false;
      if (request.deleteData && dataDirShared) throw new Error("该数据目录正在被多个本地实例使用，无法清除");
      const runtimeDirShared = instancePaths
        ? await isRuntimeDirShared(config, instance, instancePaths)
        : false;

      appendLog("instance", `准备删除实例：${instance.name}（${instance.id}）`);
      const remainingInstances = config.instances.filter((item) => item.id !== instance.id);
      const nextActiveInstanceId = getNextActiveInstanceId(config, remainingInstances);
      await waitForInstanceWebViews(instance.id);
      if (config.activeInstanceId === instance.id) {
        await context.stopActiveBackend();
        context.setLogsDir(null);
      }
      await clearInstanceSession(instance.id);

      const nextConfig: DesktopConfig = {
        ...config,
        activeInstanceId: nextActiveInstanceId,
        instances: remainingInstances,
      };
      await writeDesktopConfig(nextConfig);
      context.onConfigSaved(nextConfig);
      if (instancePaths) {
        if (runtimeDirShared) {
          appendLog("instance", `保留共享运行环境：${instancePaths.runtimeDir}`);
        }
        try {
          await removeInstanceResources(instancePaths, request.deleteData, runtimeDirShared);
        } catch (error) {
          appendLog("instance", `实例资源清理未完成：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { nextActiveInstanceId };
    }),
  );

  ipcMain.handle(IpcChannels.switchInstance, (_event, request: SwitchInstanceRequest) =>
    enqueueConfigMutation(() => context.switchInstance(request.instanceId)),
  );

  ipcMain.handle(IpcChannels.pingInstance, async (_event, request: PingInstanceRequest): Promise<PingInstanceResult> => {
    const latencyMs = await context.pingInstance(request.instance);
    return { latencyMs };
  });

  ipcMain.handle(IpcChannels.selectDirectory, async () => {
    const window = context.shellWindow();
    const options: Electron.OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IpcChannels.selectSaveFile, async () => {
    const window = context.shellWindow();
    const defaultPath = path.join(
      app.getPath("downloads"),
      `openfic-data-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`,
    );
    const options: Electron.SaveDialogOptions = {
      defaultPath,
      filters: [{ name: "OpenFix 数据备份", extensions: ["tar.gz"] }],
      title: "备份作品数据",
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  ipcMain.handle(IpcChannels.selectOpenFile, async () => {
    const window = context.shellWindow();
    const options: Electron.OpenDialogOptions = {
      properties: ["openFile"],
      filters: [{ name: "OpenFix 数据备份", extensions: ["tar.gz"] }],
      title: "选择数据备份文件",
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IpcChannels.getDefaultDataDir, () => getDefaultDataDir());

  ipcMain.handle(IpcChannels.getDataInfo, async (_event, request: GetDataInfoRequest) => {
    const config = await readDesktopConfig();
    const instance = config?.instances.find((item) => item.id === request.instanceId);
    if (!instance) throw new Error("实例不存在");
    const dataDir = resolveDataDir(instance);
    const inspection = await inspectDataDir(dataDir);
    const installDir = instance.mode === "local" ? instance.installDir ?? getDefaultInstallDir() : undefined;
    return {
      dataDir,
      isDefaultLocation: instance.dataDir === null,
      nestedWithInstallDir: await isDataDirNestedWithInstallDirectory(dataDir, installDir),
      hasData: inspection.hasData,
      entryCount: inspection.entryCount,
      sizeBytes: inspection.sizeBytes,
      autoBackupError: autoBackupFailure,
    };
  });

  ipcMain.handle(IpcChannels.inspectDataDir, async (_event, request: InspectDataDirRequest) => {
    const inspection = await inspectDataDir(request.dataDir);
    return {
      ...inspection,
      nestedWithInstallDir: await isDataDirNestedWithInstallDirectory(request.dataDir, request.installDir),
    };
  });

  ipcMain.handle(IpcChannels.checkPathOverlap, (_event, request: CheckPathOverlapRequest) =>
    isDataDirNestedWithInstallDirectory(request.dataDir, request.installDir),
  );

  ipcMain.handle(IpcChannels.migrateData, (_event, request: MigrateDataRequest) =>
    enqueueConfigMutation(async (): Promise<MigrateDataResult> => {
      const config = await readDesktopConfig();
      if (!config) throw new Error("未找到 OpenFix 实例配置");
      const instance = config.instances.find((item) => item.id === request.instanceId);
      if (!instance) throw new Error("实例不存在");
      const sourceDir = resolveDataDir(instance);
      const targetDir = path.resolve(request.newDataDir);

      const result = await withBackendRestart(request.instanceId, async () => {
        let migrated = false;
        let removedOldDir = false;
        const emitProgress = (event: DataProgressEvent) =>
          context.shellWindow()?.webContents.send(IpcChannels.dataProgress, event);
        const targetInspection = await inspectDataDir(targetDir);
        const nextConfig: DesktopConfig = {
          ...config,
          instances: config.instances.map((item) =>
            item.id === instance.id ? { ...item, dataDir: targetDir } : item,
          ),
        };
        if (!targetInspection.hasData) {
          appendLog("data", `开始迁移数据目录：${sourceDir} -> ${targetDir}`);
          await migrateDataDir(sourceDir, targetDir, (message) => appendLog("data", message), (phase, progress) =>
            emitProgress({ operation: "migrate", phase, progress }),
          );
          migrated = true;
          appendLog("data", `数据迁移完成：${targetDir}`);

          if (request.deleteOldDir && normalizeInstallDir(sourceDir) !== normalizeInstallDir(targetDir)) {
            try {
              emitProgress({ operation: "migrate", phase: "delete-old" });
              await removeDataDir(sourceDir);
              removedOldDir = true;
              appendLog("data", `已删除原数据目录：${sourceDir}`);
            } catch (error) {
              appendLog("data", `删除原数据目录失败（迁移已成功）：${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } else {
          appendLog("data", `切换数据目录（目标已含数据）：${sourceDir} -> ${targetDir}`);
        }
        await writeDesktopConfig(nextConfig);
        context.onConfigSaved(nextConfig);
        // 数据目录变化可能让已保存的备份目录落进新的数据目录，定时备份从此会被准入拒绝。
        // 迁移本身照常完成，但这里立即复核一次并记录原因，让数据管理页在迁移后就能看到
        // 明确的失败提示，而不是等下一次备份失败（或一直沉默）。
        const autoBackupTarget = getAutoBackupTarget(nextConfig);
        const autoBackupDir = autoBackupTarget?.settings.dir;
        if (autoBackupTarget && autoBackupTarget.instanceId === instance.id && autoBackupDir) {
          try {
            await assertBackupDirOutsideDataDir(autoBackupTarget.dataDir, autoBackupDir);
            autoBackupFailure = null;
          } catch (error) {
            autoBackupFailure = error instanceof Error ? error.message : String(error);
            appendLog("data", `数据目录变更后自动备份目录失效：${autoBackupFailure}`);
          }
        }
        return { dataDir: targetDir, migrated, removedOldDir };
      });
      return result;
    }),
  );

  ipcMain.handle(IpcChannels.backupData, (_event, request: BackupDataRequest) =>
    enqueueConfigMutation(async (): Promise<void> => {
      const config = await readDesktopConfig();
      const instance = config?.instances.find((item) => item.id === request.instanceId);
      if (!instance) throw new Error("实例不存在");
      const dataDir = resolveDataDir(instance);
      // 一次性手动备份与自动备份共用同一准入：归档文件所在目录与数据目录重叠时，备份会被
      // 收进后续备份并在还原时覆盖用户数据，因此在停止后端或创建文件之前就拒绝。
      await assertBackupDirOutsideDataDir(dataDir, path.dirname(path.resolve(request.targetPath)));
      const dataOptions = await getDataOperationOptions(dataDir, resolveRuntimeDir(instance.installDir));
      await withBackendRestart(request.instanceId, async () => {
        const emitProgress = (event: DataProgressEvent) =>
          context.shellWindow()?.webContents.send(IpcChannels.dataProgress, event);
        appendLog("data", `开始备份数据目录：${dataDir} -> ${request.targetPath}`);
        await backupDataDir(
          dataDir,
          request.targetPath,
          (message) => appendLog("data", message),
          (phase, progress) => emitProgress({ operation: "backup", phase, progress }),
          dataOptions.backup,
        );
        appendLog("data", `备份完成：${request.targetPath}`);
      });
    }),
  );

  ipcMain.handle(IpcChannels.restoreData, (_event, request: RestoreDataRequest) =>
    enqueueConfigMutation(async (): Promise<void> => {
      const config = await readDesktopConfig();
      const instance = config?.instances.find((item) => item.id === request.instanceId);
      if (!instance) throw new Error("实例不存在");
      const dataDir = resolveDataDir(instance);
      const dataOptions = await getDataOperationOptions(dataDir, resolveRuntimeDir(instance.installDir));
      await withBackendRestart(request.instanceId, async () => {
        const emitProgress = (event: DataProgressEvent) =>
          context.shellWindow()?.webContents.send(IpcChannels.dataProgress, event);
        appendLog("data", `开始从备份还原数据：${request.sourcePath} -> ${dataDir}`);
        await restoreDataDir(
          request.sourcePath,
          dataDir,
          (message) => appendLog("data", message),
          (phase, progress) => emitProgress({ operation: "restore", phase, progress }),
          dataOptions.restore,
        );
        appendLog("data", `数据还原完成：${dataDir}`);
      });
    }),
  );

  ipcMain.handle(
    IpcChannels.autoBackupNow,
    (_event, request: AutoBackupNowRequest) =>
      enqueueConfigMutation(async (): Promise<void> => {
        const config = await readDesktopConfig();
        const instance = config?.instances.find((item) => item.id === request.instanceId);
        if (!instance) throw new Error("instance not found");
        const settings = normalizeAutoBackupSettings(config?.autoBackup);
        const backupDir = settings.dir;
        if (!backupDir) throw new Error("auto backup dir is not configured");
        const dataDir = resolveDataDir(instance);
        // 手动触发与定时备份共用同一目标与准入，结果同样写进自动备份状态：
        // 成功清除历史失败，失败则在页面上留下可恢复的原因。
        try {
          await assertBackupDirOutsideDataDir(dataDir, backupDir);
          const dataOptions = await getDataOperationOptions(dataDir, resolveRuntimeDir(instance.installDir));
          await withBackendRestart(request.instanceId, async () => {
            const emitProgress = (event: DataProgressEvent) =>
              context.shellWindow()?.webContents.send(IpcChannels.dataProgress, event);
            const fileName = buildAutoBackupFileName(new Date());
            const targetPath = path.join(backupDir, fileName);
            appendLog("data", `manual auto backup: ${dataDir} -> ${targetPath}`);
            await backupDataDir(
              dataDir,
              targetPath,
              (message) => appendLog("data", message),
              (phase, progress) => emitProgress({ operation: "backup", phase, progress }),
              dataOptions.backup,
            );
            await rotateAutoBackups(backupDir, settings.keep);
            appendLog("data", `auto backup done: ${fileName}`);
          });
        } catch (error) {
          autoBackupFailure = error instanceof Error ? error.message : String(error);
          throw error;
        }
        autoBackupFailure = null;
      }),
  );
  ipcMain.handle(
    IpcChannels.inspectLocalRuntime,
    async (_event, request: InspectLocalRuntimeRequest): Promise<InspectLocalRuntimeResult> => {
      const [runtime, config] = await Promise.all([inspectLocalRuntime(request.installDir), readDesktopConfig()]);
      return {
        ...runtime,
        configuredInstance: findLocalInstanceByInstallDir(config, request.installDir),
      };
    },
  );

  ipcMain.handle(IpcChannels.installRuntime, (_event, request: InstallRuntimeRequest) =>
    enqueueConfigMutation(async () => {
      const window = context.shellWindow();
      if (!window) throw new Error("shell window is not available");
      await installLocalRuntime(window.webContents, request.installDir);
    }),
  );

  ipcMain.handle(IpcChannels.startLocalBackend, (_event, request: StartLocalBackendRequest) =>
    enqueueConfigMutation(async () => {
      const window = context.shellWindow();
      if (!window) throw new Error("shell window is not available");
      const controller = context.beginStartupOperation();
      const startupProgress = createStartupProgressTracker((progress) => {
        window.webContents.send(IpcChannels.startupProgress, progress);
      });
      try {
        const previousConfig = await readDesktopConfig();
        const existingInstance = findLocalInstanceByInstallDir(previousConfig, request.installDir);
        const { handle: backend, maintenanceError } = await startLocalBackendFromInstall(
          request.installDir,
          startupProgress,
          controller.signal,
          existingInstance ? resolveDataDir(existingInstance) : request.dataDir ?? undefined,
        );
        context.setBackend(backend);
        context.setBackendBaseUrl(backend.baseUrl);
        const instance: DesktopInstance = existingInstance ?? {
          id: createInstanceId(),
          name: "Local",
          mode: "local",
          remoteUrl: null,
          autoStartLocal: true,
          installDir: request.installDir,
          dataDir: normalizeDataDir(request.dataDir),
        };
        const normalizedInstallDir = normalizeInstallDir(request.installDir);
        const nextConfig: DesktopConfig = {
          ...(previousConfig ?? {}),
          activeInstanceId: instance.id,
          instances: [
            ...(previousConfig?.instances ?? []).filter(
              (candidate) =>
                candidate.mode !== "local" ||
                candidate.installDir === null ||
                normalizeInstallDir(candidate.installDir) !== normalizedInstallDir,
            ),
            instance,
          ],
        };
        await writeDesktopConfig(nextConfig);
        context.onConfigSaved(nextConfig);
        startupProgress.begin({
          step: "ready",
          title: "服务已就绪",
          message: "OpenFix 已准备完成",
          progress: 1,
        });
        startupProgress.complete();
        return maintenanceError;
      } catch (error) {
        if (controller.signal.aborted) startupProgress.complete("已取消连接");
        else startupProgress.fail(error);
        throw error;
      } finally {
        context.finishStartupOperation(controller);
      }
    }),
  );

  ipcMain.handle(IpcChannels.minimizeWindow, async () => {
    context.shellWindow()?.minimize();
  });
  ipcMain.handle(IpcChannels.toggleMaximizeWindow, async () => {
    const window = context.shellWindow();
    if (!window) return;
    if (window.isMaximized()) {
      window.unmaximize();
      return;
    }
    window.maximize();
  });
  ipcMain.handle(IpcChannels.toggleFullScreen, async () => {
    const window = context.shellWindow();
    if (!window) return;
    window.setFullScreen(!window.isFullScreen());
  });
  ipcMain.handle(IpcChannels.reloadWindow, () => {
    context.shellWindow()?.webContents.reload();
  });
  ipcMain.handle(IpcChannels.toggleDevTools, () => {
    const webContents = context.shellWindow()?.webContents;
    if (!webContents) return;
    if (webContents.isDevToolsOpened()) {
      webContents.closeDevTools();
      return;
    }
    webContents.openDevTools({ mode: "detach", title: "OpenFix 开发者工具" });
  });
  ipcMain.handle(IpcChannels.closeWindow, async () => {
    context.shellWindow()?.close();
  });
  ipcMain.handle(IpcChannels.openProjectHome, () => {
    if (PROJECT_HOME_URL) return shell.openExternal(PROJECT_HOME_URL);
  });
  ipcMain.handle(IpcChannels.reportBug, () => {
    if (BUG_REPORT_URL) return shell.openExternal(BUG_REPORT_URL);
  });
  ipcMain.handle(IpcChannels.suggestFeature, () => {
    if (FEATURE_SUGGESTION_URL) return shell.openExternal(FEATURE_SUGGESTION_URL);
  });

  startAutoBackupScheduler();
}
