// The actual built registerIpc scheduler runs the real auto-backup helpers over an isolated
// synthetic filesystem; the suspend callback returns a private resume closure invoked once.
// Run after build:main with node --experimental-vm-modules --test.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  arePathsEqual as realArePathsEqual,
  assertBackupDirOutsideDataDir as realAssertBackupDirOutsideDataDir,
  doPathsOverlap as realDoPathsOverlap,
} from "../../dist/main/data-manager.js";

const PREFIX = "OpenFix-backup-";
const SUFFIX = ".tar.gz";
const dayMs = 24 * 60 * 60 * 1000;
const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const distMainDir = path.join(repoRoot, "desktop/dist/main");
const distSharedDir = path.join(repoRoot, "desktop/dist/shared");
const tmpRoot = path.join(repoRoot, "tmp");

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !path.isAbsolute(relative)
    && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function archiveName(stamp) {
  return `${PREFIX}${stamp}${SUFFIX}`;
}

// Windows 路径大小写不敏感，realpath 与输入比较前先归一化。
function samePath(left, right) {
  const [a, b] = [path.resolve(left), path.resolve(right)];
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// 只接受真实目录/文件：符号链接、目录联接与别名路径一律拒绝。
async function requireUnlinked(target) {
  const info = await fs.lstat(target);
  assert.equal(info.isSymbolicLink(), false, `Refuse linked path: ${target}`);
  assert.ok(samePath(await fs.realpath(target), target), `Refuse aliased path: ${target}`);
  return info;
}

// 创建前先确认仓库根与隔离根都是真实目录，再记录 mkdtemp scratch 的 dev/ino 身份。
async function openScratch(prefix) {
  assert.ok((await requireUnlinked(repoRoot)).isDirectory(), "Repository root must be an unlinked directory");
  try {
    await fs.mkdir(tmpRoot);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  assert.ok(within(repoRoot, tmpRoot), "Workspace tmp must stay inside the repository");
  assert.ok((await requireUnlinked(tmpRoot)).isDirectory(), "Workspace tmp must be an unlinked directory");
  const root = await fs.mkdtemp(path.join(tmpRoot, prefix));
  assert.ok(within(tmpRoot, root), "Scratch must stay inside workspace tmp");
  assert.ok(samePath(path.dirname(root), tmpRoot), "Scratch must be a direct child of workspace tmp");
  const created = await requireUnlinked(root);
  assert.ok(created.isDirectory(), "Scratch must be a directory");
  return { root, dev: created.dev, ino: created.ino };
}

async function withScratch(run) {
  const owned = await openScratch("openfix-auto-backup-ipc-");
  try {
    await run(owned.root);
  } finally {
    await closeScratch(owned);
  }
}

// 只走真实目录；未知链接或特殊文件一律拒绝，验证失败时保留 scratch 供排查。
async function inspectOwnedTree(target, tree) {
  const info = await requireUnlinked(target);
  if (info.isDirectory()) {
    tree.directories.push(target);
    for (const name of await fs.readdir(target)) await inspectOwnedTree(path.join(target, name), tree);
    return;
  }
  assert.ok(info.isFile(), `Refuse special file: ${target}`);
  tree.files.push(target);
}

// 清理前重新核对仓库根/隔离根/scratch 的 realpath、lstat 与身份，不依赖 fs.rm 的链接处理。
async function closeScratch(owned) {
  const root = owned.root;
  assert.ok(within(repoRoot, tmpRoot) && within(tmpRoot, root), "Refuse to remove outside workspace tmp");
  assert.ok(samePath(path.dirname(root), tmpRoot), "Refuse to remove a shared directory");
  assert.equal(samePath(root, repoRoot) || samePath(root, tmpRoot), false, "Refuse to remove a shared root");
  assert.ok((await requireUnlinked(repoRoot)).isDirectory(), "Repository root changed; cleanup refused");
  assert.ok((await requireUnlinked(tmpRoot)).isDirectory(), "Workspace tmp changed; cleanup refused");
  const current = await requireUnlinked(root);
  assert.ok(current.isDirectory(), "Scratch must be a directory");
  assert.equal(current.dev, owned.dev, "Scratch device changed; cleanup refused");
  assert.equal(current.ino, owned.ino, "Scratch inode changed; cleanup refused");
  const tree = { directories: [], files: [] };
  await inspectOwnedTree(root, tree);
  for (const file of tree.files) await fs.unlink(file);
  for (const directory of tree.directories.reverse()) await fs.rmdir(directory);
  await assert.rejects(fs.lstat(root), (error) => error?.code === "ENOENT");
}

function makeConfig({ backupDir, keep, enabled = true, instances, activeInstanceId }) {
  return {
    activeInstanceId,
    instances,
    zoomFactor: 1.3,
    autoBackup: { enabled, dir: backupDir, keep },
  };
}

function makeLocalInstance({ id, dataDir, installDir }) {
  return {
    id, name: id, mode: "local", remoteUrl: null, autoStartLocal: true, installDir, dataDir,
  };
}

async function createHarness({ config, backendRunning = true, webviews = [] }) {
  assert.equal(typeof vm.SourceTextModule, "function", "Use --experimental-vm-modules");
  const [ipcCode, autoBackupCode, sharedIpcCode, sharedConfigCode] = await Promise.all([
    fs.readFile(path.join(distMainDir, "ipc.js"), "utf8"),
    fs.readFile(path.join(distMainDir, "auto-backup.js"), "utf8"),
    fs.readFile(path.join(distSharedDir, "ipc.js"), "utf8"),
    fs.readFile(path.join(distSharedDir, "config.js"), "utf8"),
  ]);

  const timers = {
    startup: null, startupDelayMs: null, check: null, checkIntervalMs: null,
    // 每个 setTimeout 都被记录下来，用例可以按延迟找到并触发写作暂停的超时。
    scheduled: [],
  };
  const state = {
    config,
    backendRunning,
    backupError: null,
    resumeError: null,
    resumeResult: { status: "ready" },
    backupGate: null,
    writeGate: null,
  };
  const records = {
    events: [], progress: [], logs: [], backups: [], writes: [], saved: [], boundaryErrors: [], overlapChecks: [],
    migrations: [], pauseRequests: [], releases: [],
  };

  const context = vm.createContext({
    console,
    URL,
    setTimeout: (handler, timeout) => {
      const entry = { handler, timeout, cleared: false };
      timers.scheduled.push(entry);
      timers.startup = handler;
      timers.startupDelayMs = timeout;
      return entry;
    },
    clearTimeout: (entry) => {
      if (entry && typeof entry === "object") entry.cleared = true;
    },
    setInterval: (handler, timeout) => {
      timers.check = handler;
      timers.checkIntervalMs = timeout;
      return { hasRef: () => false };
    },
    clearInterval: () => {},
  });

  function deny(label) {
    records.boundaryErrors.push(label);
    throw new Error(`Forbidden desktop test boundary: ${label}`);
  }

  function synthetic(identifier, exports) {
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context, identifier },
    );
  }

  const sharedLink = (module) => module.link((specifier, referencingModule) => {
    throw new Error(`Forbidden import ${specifier} in ${referencingModule.identifier}`);
  });
  const sharedIpcModule = new vm.SourceTextModule(sharedIpcCode, {
    context, identifier: path.join(distSharedDir, "ipc.js"),
    importModuleDynamically: () => deny("shared ipc dynamic import"),
  });
  const sharedConfigModule = new vm.SourceTextModule(sharedConfigCode, {
    context, identifier: path.join(distSharedDir, "config.js"),
    importModuleDynamically: () => deny("shared config dynamic import"),
  });
  await sharedLink(sharedIpcModule);
  await sharedLink(sharedConfigModule);
  await Promise.all([sharedIpcModule.evaluate(), sharedConfigModule.evaluate()]);
  const IpcChannels = sharedIpcModule.namespace.IpcChannels;

  const shellWindow = {
    webContents: {
      send: (channel, event) => {
        assert.equal(channel, IpcChannels.dataProgress);
        records.progress.push(event);
      },
    },
  };

  const ipcContext = {
    shellWindow: () => shellWindow,
    setBackend: () => deny("setBackend"),
    setBackendBaseUrl: () => deny("setBackendBaseUrl"),
    setLogsDir: () => deny("setLogsDir"),
    beginStartupOperation: () => deny("beginStartupOperation"),
    finishStartupOperation: () => deny("finishStartupOperation"),
    initializeApp: () => deny("initializeApp"),
    cancelStartup: () => deny("cancelStartup"),
    switchInstance: () => deny("switchInstance"),
    pingInstance: () => deny("pingInstance"),
    onConfigSaved: (next) => { records.saved.push(next); },
    isBackendRunning: () => state.backendRunning,
    stopActiveBackend: async () => {
      records.events.push("suspend");
      state.backendRunning = false;
      let resumed = false;
      return async () => {
        assert.equal(resumed, false, "Resume closure must be invoked once");
        resumed = true;
        records.events.push("resume");
        if (state.resumeError) throw state.resumeError;
        if (state.resumeResult.status === "ready") state.backendRunning = true;
        return state.resumeResult;
      };
    },
  };

  const handlers = new Map();
  const listeners = new Map();
  // 每个持久分区一个稳定的 session 对象：主进程的准入用的是分区过滤后的 webview。
  const partitions = new Map();
  const partitionFor = (partition) => {
    let entry = partitions.get(partition);
    if (!entry) {
      entry = { partition };
      partitions.set(partition, entry);
    }
    return entry;
  };
  // 目标实例里在线的写作窗口；send 记录协议消息，用例决定何时（或不）确认。
  const guests = webviews.map((spec) => {
    const sent = [];
    return {
      id: spec.id,
      session: partitionFor(`persist:openfic-${spec.instanceId}`),
      sent,
      getType: () => spec.type ?? "webview",
      isDestroyed: () => spec.destroyed === true,
      send: (channel, payload) => {
        if (spec.sendError) throw new Error(spec.sendError);
        sent.push({ channel, payload });
        if (channel === IpcChannels.autoBackupPause) {
          records.pauseRequests.push({ guestId: spec.id, requestId: payload?.requestId });
          records.events.push("pause");
        }
        if (channel === IpcChannels.autoBackupResume) {
          records.releases.push({ guestId: spec.id, requestId: payload?.requestId });
          records.events.push("release");
        }
      },
    };
  });
  const electron = {
    app: {
      // getDataInfo 会读可执行文件目录，判断数据目录是否与安装目录重叠。
      getPath: (name) =>
        name === "exe"
          ? path.join(repoRoot, "tmp", "harness-exe", "OpenFix.exe")
          : name === "sessionData" ? defaultDataDir
          : deny(`app.getPath(${name})`),
      getVersion: () => "0.11.1",
      isPackaged: false,
    },
    dialog: {
      showErrorBox: () => deny("dialog.showErrorBox"),
      showOpenDialog: () => deny("dialog.showOpenDialog"),
      showSaveDialog: () => deny("dialog.showSaveDialog"),
    },
    ipcMain: {
      handle: (channel, handler) => {
        assert.equal(handlers.has(channel), false, `Duplicate handler ${channel}`);
        handlers.set(channel, handler);
      },
      on: (channel, handler) => {
        assert.equal(listeners.has(channel), false, `Duplicate listener ${channel}`);
        listeners.set(channel, handler);
      },
    },
    session: { fromPartition: partitionFor },
    shell: { openExternal: () => deny("shell.openExternal") },
    webContents: { getAllWebContents: () => guests },
  };
  const appendLog = (category, message) => {
    assert.equal(category, "data");
    records.logs.push(message);
  };
  const defaultDataDir = path.join(repoRoot, "tmp", "harness-default-data");
  const defaultInstallDir = path.join(repoRoot, "tmp", "harness-default-install");
  const dependencies = {
    "electron": synthetic("synthetic:electron", electron),
    "node:path": synthetic("synthetic:path", { default: path }),
    "../shared/ipc.js": sharedIpcModule,
    "../shared/config.js": sharedConfigModule,
    "./config.js": synthetic("synthetic:config", {
      createDefaultConfig: () => ({ activeInstanceId: null, instances: [] }),
      readDesktopConfig: async () => state.config,
      writeDesktopConfig: async (next) => {
        if (state.writeGate) await state.writeGate;
        state.config = next;
        records.writes.push(next);
      },
    }),
    "./auto-backup.js": null,
    "./protocol.js": synthetic("synthetic:protocol", {
      ensureAppProtocolForPartition: () => deny("ensureAppProtocolForPartition"),
    }),
    "./local-instance.js": synthetic("synthetic:local-instance", {
      findLocalInstanceByInstallDir: () => deny("findLocalInstanceByInstallDir"),
      normalizeInstallDir: (installDir) => installDir,
    }),
    "./runtime/setup-runner.js": synthetic("synthetic:setup-runner", {
      inspectLocalRuntime: () => deny("inspectLocalRuntime"),
      installLocalRuntime: () => deny("installLocalRuntime"),
      startLocalBackendFromInstall: () => deny("startLocalBackendFromInstall"),
    }),
    "./runtime/python.js": synthetic("synthetic:python", {
      getDefaultInstallDir: () => defaultInstallDir,
      resolveRuntimeDir: (installDir) => path.join(installDir ?? defaultInstallDir, "Runtime"),
    }),
    "./runtime/tar-extract.js": synthetic("synthetic:tar-extract", { INSTANCE_DATA_ENTRIES: [] }),
    "./data-location.js": synthetic("synthetic:data-location", {
      getDefaultDataDir: () => defaultDataDir,
      normalizeDataDir: (value) => (value ? path.resolve(value) : null),
      resolveDataDir: (instance) => instance.dataDir ?? defaultDataDir,
    }),
    "./data-manager.js": synthetic("synthetic:data-manager", {
      getDataOperationOptions: async (dataDir, runtimeDir, sessionDataDir) => {
        assert.equal(typeof dataDir, "string");
        assert.equal(typeof runtimeDir, "string");
        assert.equal(sessionDataDir, defaultDataDir, "Data policy must receive Electron's actual sessionData root");
        records.events.push("options");
        return { backup: {}, restore: {} };
      },
      backupDataDir: async (dataDir, targetPath, onLog, onPhase) => {
        assert.equal(typeof targetPath, "string");
        records.events.push("backup");
        records.backups.push({ dataDir, targetPath });
        if (state.backupGate) await state.backupGate;
        if (state.backupError) throw state.backupError;
        assert.equal(typeof onLog, "function");
        assert.equal(typeof onPhase, "function");
        await fs.writeFile(targetPath, "synthetic archive\n");
      },
      arePathsEqual: (left, right) => realArePathsEqual(left, right),
      doPathsOverlap: (left, right) => realDoPathsOverlap(left, right),
      // 备份目录准入记录调用参数后交给真实实现：测试只隔离归档写入，重叠判定必须是产品逻辑。
      assertBackupDirOutsideDataDir: async (dataDir, backupDir) => {
        assert.equal(typeof dataDir, "string");
        assert.equal(typeof backupDir, "string");
        records.overlapChecks.push({ dataDir, backupDir });
        return realAssertBackupDirOutsideDataDir(dataDir, backupDir);
      },
      inspectDataDir: async () => ({ valid: true, hasData: false, entryCount: 0, sizeBytes: 0 }),
      isPathWithin: () => deny("isPathWithin"),
      migrateDataDir: async (fromDir, toDir, onLog, onPhase) => {
        records.events.push("migrate");
        records.migrations.push({ fromDir, toDir });
        assert.equal(typeof onLog, "function");
        assert.equal(typeof onPhase, "function");
        await onLog("synthetic migrate");
        await onPhase("copy", 0.5);
      },
      removeDataDir: () => deny("removeDataDir"),
      restoreDataDir: () => deny("restoreDataDir"),
    }),
    "./updater.js": synthetic("synthetic:updater", {
      cancelUpdateDownload: () => deny("cancelUpdateDownload"),
      checkForUpdates: () => deny("checkForUpdates"),
      downloadUpdate: () => deny("downloadUpdate"),
      getUpdateState: () => deny("getUpdateState"),
      installUpdate: () => deny("installUpdate"),
      openUpdateRelease: () => deny("openUpdateRelease"),
    }),
    "./startup-progress.js": synthetic("synthetic:startup-progress", {
      createStartupProgressTracker: () => deny("createStartupProgressTracker"),
      getStartupProgress: () => deny("getStartupProgress"),
    }),
    "./logging.js": synthetic("synthetic:logging", {
      appendLog,
      exportLogs: () => deny("exportLogs"),
    }),
    "./telemetry.js": synthetic("synthetic:telemetry", {
      captureException: () => deny("captureException"),
    }),
  };

  const autoBackupDependencies = {
    "node:fs/promises": synthetic("synthetic:fs-promises", {
      readdir: fs.readdir, lstat: fs.lstat, unlink: fs.unlink, stat: fs.stat,
    }),
    "node:path": synthetic("synthetic:path:auto", { default: path }),
    "./logging.js": dependencies["./logging.js"],
    "./data-location.js": dependencies["./data-location.js"],
    "./runtime/python.js": dependencies["./runtime/python.js"],
  };

  const autoBackupModule = new vm.SourceTextModule(autoBackupCode, {
    context,
    identifier: path.join(distMainDir, "auto-backup.js"),
    importModuleDynamically: () => deny("auto backup dynamic import"),
  });
  await autoBackupModule.link((specifier) => {
    const dependency = autoBackupDependencies[specifier];
    if (!dependency) throw new Error(`Unknown auto-backup dependency: ${specifier}`);
    return dependency;
  });
  await autoBackupModule.evaluate();
  dependencies["./auto-backup.js"] = autoBackupModule;

  const ipcModule = new vm.SourceTextModule(ipcCode, {
    context,
    identifier: path.join(distMainDir, "ipc.js"),
    importModuleDynamically: () => deny("ipc dynamic import"),
  });
  await ipcModule.link((specifier) => {
    const dependency = dependencies[specifier];
    if (!dependency) throw new Error(`Unknown ipc dependency: ${specifier}`);
    return dependency;
  });
  await ipcModule.evaluate();

  assert.equal(typeof ipcModule.namespace.registerIpc, "function");
  ipcModule.namespace.registerIpc(ipcContext);
  assert.equal(typeof timers.check, "function", "Scheduler interval must be registered");
  assert.equal(typeof timers.startup, "function", "Scheduler startup tick must be registered");
  assert.equal(timers.checkIntervalMs, 30 * 60 * 1000);
  assert.equal(timers.startupDelayMs, 2 * 60 * 1000);

  const pauseTimeoutMs = sharedIpcModule.namespace.AUTO_BACKUP_PAUSE_TIMEOUT_MS;
  assert.equal(typeof pauseTimeoutMs, "number", "The pause deadline must be shared with the main process");

  const pauseAckHandler = () => {
    const handler = handlers.get(IpcChannels.autoBackupPauseAck);
    assert.equal(typeof handler, "function", "The pause acknowledgement handler must be registered");
    return handler;
  };

  /** 用真实注册的确认处理器应答一次暂停请求，返回值就是「主进程是否接受这次确认」。 */
  async function acknowledgePause({ guestId, requestId, ok, reason }) {
    const payload = reason === undefined ? { requestId, ok } : { requestId, ok, reason };
    return await pauseAckHandler()({ sender: { id: guestId } }, payload);
  }

  /** 直接用任意负载调用确认处理器：覆盖未知形状与陌生来源。 */
  async function sendPauseAck(payload, senderId) {
    return await pauseAckHandler()({ sender: { id: senderId } }, payload);
  }

  return {
    state, records, handlers, listeners, timers, IpcChannels,
    pauseTimeoutMs, acknowledgePause, sendPauseAck,
  };
}

// VM 上下文对象来自另一个 realm，比较前先还原为宿主 realm 的普通对象。
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// 终态事件在这里只断言操作生命周期；automatic 标记与失败原因由专门的用例覆盖。
function terminal(records) {
  return plain(
    records.progress
      .filter((event) => event.phase === "done" || event.phase === "error")
      .map(({ operation, phase, progress }) => ({ operation, phase, progress })),
  );
}

// 定时备份发出的终态事件：必须带 automatic 标记，页面才能把它和手动操作区分开。
function automaticTerminals(records) {
  return plain(records.progress.filter((event) => event.automatic === true));
}

// 页面读取自动备份失败的唯一入口：主进程的 data:get-info。
async function readAutoBackupError(harness, instanceId) {
  const info = await harness.handlers.get(harness.IpcChannels.getDataInfo)(null, { instanceId });
  return info.autoBackupError;
}

/** 目标实例里一个在线写作窗口。 */
function makeWebview(id, instanceId = "inst-local") {
  return { id, instanceId };
}

/** 定时备份的调度入口：用 interval 回调，避免被测试里其它 setTimeout 覆盖。 */
function tick(harness) {
  return harness.timers.check();
}

/** 取出这次调度为写作暂停设下的超时；已被清除时返回 null。 */
function pauseDeadline(harness) {
  const deadlines = harness.timers.scheduled.filter(
    (entry) => entry.timeout === harness.pauseTimeoutMs,
  );
  assert.equal(deadlines.length, 1, "Exactly one pause deadline must be scheduled per attempt");
  return deadlines[0].cleared ? null : deadlines[0];
}

function assertClean(harness) {
  assert.deepEqual(harness.records.boundaryErrors, [], "Forbidden boundaries must fail the run");
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("a successful timer backup suspends, archives, rotates and resumes the backend", async () => {
  await withScratch(async (scratch) => {
    const backupDir = path.join(scratch, "backups");
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(backupDir, { recursive: true });
    const stale = path.join(backupDir, archiveName("20260101-000000"));
    await fs.writeFile(stale, "old archive\n");
    const old = new Date(Date.now() - 5 * dayMs);
    await fs.utimes(stale, old, old);
    const config = makeConfig({
      backupDir, keep: 1, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });

    await harness.timers.startup();

    assert.deepEqual(harness.records.events, ["options", "suspend", "backup", "resume"]);
    assert.equal(harness.records.backups.length, 1);
    assert.equal(harness.records.backups[0].dataDir, dataDir);
    assert.equal(path.dirname(harness.records.backups[0].targetPath), backupDir);
    assert.deepEqual(await fs.readdir(backupDir), [path.basename(harness.records.backups[0].targetPath)]);
    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "done", progress: 1 }]);
    assertClean(harness);
  });
});

test("resume waits for the in-flight archive behind a controlled promise", async () => {
  await withScratch(async (scratch) => {
    const backupDir = path.join(scratch, "backups");
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(backupDir, { recursive: true });
    const config = makeConfig({
      backupDir, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });
    let releaseBackup;
    harness.state.backupGate = new Promise((resolve) => { releaseBackup = resolve; });

    const tick = harness.timers.startup();
    await waitFor(() => harness.records.events.includes("backup"), "the archive to start");
    assert.deepEqual(harness.records.events, ["options", "suspend", "backup"], "Resume must wait for the archive");

    releaseBackup();
    await tick;

    assert.deepEqual(harness.records.events, ["options", "suspend", "backup", "resume"]);
    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "done", progress: 1 }]);
    assertClean(harness);
  });
});

test("a failed archive still resumes the backend and never rotates", async () => {
  await withScratch(async (scratch) => {
    const backupDir = path.join(scratch, "backups");
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(backupDir, { recursive: true });
    for (const stamp of ["20260101-000000", "20260102-000000"]) {
      const fullPath = path.join(backupDir, archiveName(stamp));
      await fs.writeFile(fullPath, "old archive\n");
      const old = new Date(Date.now() - 5 * dayMs);
      await fs.utimes(fullPath, old, old);
    }
    const config = makeConfig({
      backupDir, keep: 1, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });
    harness.state.backupError = new Error("synthetic backup failure");

    await harness.timers.startup();

    assert.deepEqual(harness.records.events, ["options", "suspend", "backup", "resume"]);
    assert.equal((await fs.readdir(backupDir)).length, 2, "Failed publication must not rotate");
    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "error", progress: 0 }]);
    assert.ok(harness.records.logs.some((message) => message.includes("备份失败")));
    assertClean(harness);
  });
});

test("a stopped backend is never started by the scheduler", async () => {
  await withScratch(async (scratch) => {
    const backupDir = path.join(scratch, "backups");
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(backupDir, { recursive: true });
    const config = makeConfig({
      backupDir, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config, backendRunning: false });

    await harness.timers.startup();

    assert.deepEqual(harness.records.events, ["options", "backup"]);
    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "done", progress: 1 }]);
    assertClean(harness);
  });
});

test("a non-ready resume is an error, never done", async () => {
  await withScratch(async (scratch) => {
    const backupDir = path.join(scratch, "backups");
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(backupDir, { recursive: true });
    const config = makeConfig({
      backupDir, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });
    harness.state.resumeResult = { status: "needs-setup" };

    await harness.timers.startup();

    assert.deepEqual(harness.records.events, ["options", "suspend", "backup", "resume"]);
    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "error", progress: 0 }]);
    assert.ok(harness.records.logs.some((message) => message.includes("恢复服务失败")));
    assert.ok(harness.records.logs.some((message) => message.includes("needs-setup")));
    assertClean(harness);
  });
});

test("a rejected resume is an error even when the archive succeeded", async () => {
  await withScratch(async (scratch) => {
    const backupDir = path.join(scratch, "backups");
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(backupDir, { recursive: true });
    const config = makeConfig({
      backupDir, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });
    harness.state.resumeError = new Error("synthetic resume failure");

    await harness.timers.startup();

    assert.deepEqual(harness.records.events, ["options", "suspend", "backup", "resume"]);
    assert.equal(harness.records.backups.length, 1);
    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "error", progress: 0 }]);
    assert.ok(harness.records.logs.some(
      (message) => message.includes("恢复服务失败") && message.includes("synthetic resume failure"),
    ));
    assertClean(harness);
  });
});

test("combined archive and resume failures keep both details", async () => {
  await withScratch(async (scratch) => {
    const backupDir = path.join(scratch, "backups");
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(backupDir, { recursive: true });
    const config = makeConfig({
      backupDir, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });
    harness.state.backupError = new Error("synthetic backup failure");
    harness.state.resumeError = new Error("synthetic resume failure");

    await harness.timers.startup();

    assert.deepEqual(harness.records.events, ["options", "suspend", "backup", "resume"]);
    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "error", progress: 0 }]);
    const failureLog = harness.records.logs.find((message) => message.includes("synthetic backup failure"));
    assert.ok(failureLog, "Backup failure detail must be retained");
    assert.ok(failureLog.includes("synthetic resume failure"), "Resume failure detail must be retained");
    assert.ok(failureLog.includes("备份失败") && failureLog.includes("恢复服务失败"));
    assertClean(harness);
  });
});

test("a queued disable suppresses the pending automatic backup", async () => {
  await withScratch(async (scratch) => {
    const backupDir = path.join(scratch, "backups");
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(backupDir, { recursive: true });
    const config = makeConfig({
      backupDir, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });
    let release;
    harness.state.writeGate = new Promise((resolve) => { release = resolve; });
    const disabled = { ...config, autoBackup: { enabled: false, dir: backupDir, keep: 2 } };

    const queued = harness.handlers.get(harness.IpcChannels.saveConfig)(null, { config: disabled });
    const tick = harness.timers.startup();
    release();
    await Promise.all([queued, tick]);

    assert.deepEqual(harness.records.events, []);
    assert.equal(harness.records.backups.length, 0);
    assert.deepEqual(harness.records.progress, []);
    assert.equal(harness.records.saved.length, 1, "The disable must be committed before admission");
    assertClean(harness);
  });
});

test("a queued directory change skips a target that is no longer due", async () => {
  await withScratch(async (scratch) => {
    const dirA = path.join(scratch, "dir-a");
    const dirB = path.join(scratch, "dir-b");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    await fs.writeFile(path.join(dirB, archiveName("20261003-120000")), "fresh archive\n");
    const config = makeConfig({
      backupDir: dirA, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir: path.join(scratch, "data-a"), installDir })],
    });
    const harness = await createHarness({ config });
    let release;
    harness.state.writeGate = new Promise((resolve) => { release = resolve; });
    const moved = { ...config, autoBackup: { enabled: true, dir: dirB, keep: 2 } };

    const queued = harness.handlers.get(harness.IpcChannels.saveConfig)(null, { config: moved });
    const tick = harness.timers.startup();
    release();
    await Promise.all([queued, tick]);

    assert.equal(harness.records.backups.length, 0, "A stale dir must not be archived");
    assert.deepEqual(harness.records.progress, []);
    assertClean(harness);
  });
});

test("a queued instance and directory change archives the current target", async () => {
  await withScratch(async (scratch) => {
    const dirA = path.join(scratch, "dir-a");
    const dirB = path.join(scratch, "dir-b");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    await fs.writeFile(path.join(dirA, archiveName("20261003-120000")), "fresh archive\n");
    const config = makeConfig({
      backupDir: dirA, keep: 2, activeInstanceId: "inst-first",
      instances: [
        makeLocalInstance({ id: "inst-first", dataDir: path.join(scratch, "data-a"), installDir }),
        makeLocalInstance({ id: "inst-second", dataDir: path.join(scratch, "data-b"), installDir }),
      ],
    });
    const harness = await createHarness({ config });
    let release;
    harness.state.writeGate = new Promise((resolve) => { release = resolve; });
    const moved = {
      ...config,
      activeInstanceId: "inst-second",
      autoBackup: { enabled: true, dir: dirB, keep: 2 },
    };

    const queued = harness.handlers.get(harness.IpcChannels.saveConfig)(null, { config: moved });
    const tick = harness.timers.startup();
    release();
    await Promise.all([queued, tick]);

    assert.deepEqual(harness.records.events, ["options", "suspend", "backup", "resume"]);
    assert.equal(harness.records.backups.length, 1);
    assert.equal(harness.records.backups[0].dataDir, path.join(scratch, "data-b"));
    assert.equal(path.dirname(harness.records.backups[0].targetPath), dirB);
    assert.equal(harness.records.saved.length, 1, "The change must be committed before admission");
    assertClean(harness);
  });
});

test("a queued keep change rotates with the committed keep value", async () => {
  await withScratch(async (scratch) => {
    const backupDir = path.join(scratch, "backups");
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(backupDir, { recursive: true });
    const base = Date.now() - 5 * dayMs;
    const staleStamps = ["20200101-000000", "20200102-000000", "20200103-000000"];
    for (const [index, stamp] of staleStamps.entries()) {
      const fullPath = path.join(backupDir, archiveName(stamp));
      await fs.writeFile(fullPath, "old archive\n");
      const mtime = new Date(base + index * dayMs);
      await fs.utimes(fullPath, mtime, mtime);
    }
    await fs.writeFile(path.join(backupDir, "notes.txt"), "unrelated\n");
    const config = makeConfig({
      backupDir, keep: 1, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });
    let release;
    harness.state.writeGate = new Promise((resolve) => { release = resolve; });
    const current = { ...config, autoBackup: { enabled: true, dir: backupDir, keep: 3 } };

    const queued = harness.handlers.get(harness.IpcChannels.saveConfig)(null, { config: current });
    const tick = harness.timers.startup();
    release();
    await Promise.all([queued, tick]);

    assert.equal(harness.records.saved.length, 1, "The keep change must be committed before admission");
    assert.equal(harness.records.saved[0].autoBackup.keep, 3);
    assert.deepEqual(harness.records.events, ["options", "suspend", "backup", "resume"]);
    assert.equal(harness.records.backups.length, 1);
    assert.equal(path.dirname(harness.records.backups[0].targetPath), backupDir);
    const published = path.basename(harness.records.backups[0].targetPath);
    const remaining = (await fs.readdir(backupDir)).sort();
    assert.deepEqual(
      remaining,
      [published, archiveName("20200102-000000"), archiveName("20200103-000000"), "notes.txt"].sort(),
      "Rotation must honor the committed keep, the newest ordinary archive and unrelated files",
    );
    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "done", progress: 1 }]);
    assertClean(harness);
  });
});

test("a fresh manual archive suppresses the queued duplicate", async () => {
  await withScratch(async (scratch) => {
    const backupDir = path.join(scratch, "backups");
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(backupDir, { recursive: true });
    const config = makeConfig({
      backupDir, keep: 5, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });

    await harness.handlers.get(harness.IpcChannels.autoBackupNow)(null, { instanceId: "inst-local" });
    assert.equal(harness.records.backups.length, 1);
    assert.deepEqual(
      harness.records.events,
      ["options", "suspend", "backup"],
      "Manual backup must stop the backend and never resume it",
    );
    assert.equal(harness.records.events.includes("resume"), false, "Manual backup has no resume path");
    assert.equal(
      harness.state.backendRunning,
      false,
      "Manual backup leaves the backend stopped until the user returns",
    );
    harness.state.backendRunning = true;
    await harness.timers.startup();

    assert.equal(harness.records.backups.length, 1, "A fresh archive must suppress the next tick");
    assert.deepEqual(terminal(harness.records), []);
    assertClean(harness);
  });
});

test("concurrent ticks run once and the running guard is released", async () => {
  await withScratch(async (scratch) => {
    const backupDir = path.join(scratch, "backups");
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(backupDir, { recursive: true });
    const config = makeConfig({
      backupDir, keep: 5, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });

    await Promise.all([harness.timers.startup(), harness.timers.startup()]);

    assert.deepEqual(harness.records.events, ["options", "suspend", "backup", "resume"]);
    assert.equal(harness.records.backups.length, 1);

    await fs.rm(harness.records.backups[0].targetPath);
    harness.state.backendRunning = true;
    await harness.timers.startup();

    assert.equal(harness.records.backups.length, 2, "The running guard must not stay set");
    assertClean(harness);
  });
});

test("an idle directory emits no terminal progress", async () => {
  await withScratch(async (scratch) => {
    const backupDir = path.join(scratch, "backups");
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, archiveName("20261003-120000")), "fresh archive\n");
    const config = makeConfig({
      backupDir, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });

    await harness.timers.startup();

    assert.deepEqual(harness.records.events, []);
    assert.deepEqual(harness.records.progress, []);
    assert.equal(harness.state.backendRunning, true, "An idle tick must not suspend the backend");
    assertClean(harness);
  });
});

test("a stored target inside the data directory fails the tick without archiving or suspending", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const backupDir = path.join(dataDir, "backups");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(backupDir, { recursive: true });
    const config = makeConfig({
      backupDir, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });

    await harness.timers.startup();

    assert.deepEqual(harness.records.overlapChecks, [{ dataDir, backupDir }]);
    assert.equal(harness.records.backups.length, 0, "An overlapping target must never be archived");
    assert.deepEqual(await fs.readdir(backupDir), [], "No archive may be published inside the data directory");
    assert.deepEqual(harness.records.events, [], "An invalid target must not stop the backend");
    assert.equal(harness.state.backendRunning, true);
    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "error", progress: 0 }]);
    assert.ok(harness.records.logs.some(
      (message) => message.includes("自动备份失败") && message.includes("备份目录不能与数据目录相同"),
    ));
    assertClean(harness);
  });
});

test("a not-due stored target is still revalidated against the data directory", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const backupDir = path.join(dataDir, "backups");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(backupDir, { recursive: true });
    const fresh = path.join(backupDir, archiveName("20261003-120000"));
    await fs.writeFile(fresh, "recent archive\n");
    const config = makeConfig({
      backupDir, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });

    // 最近一次归档仍在 24 小时窗口内：本次调度本来不备份，重叠错误只能由每个周期的复核报出。
    // 失败原因只留在主进程内存里，重启后没有这一步就再也看不到它。
    const archive = await fs.lstat(fresh);
    assert.ok(
      Date.now() - archive.mtime.getTime() < dayMs,
      "The fixture must stay inside the automatic backup interval",
    );

    await harness.timers.startup();

    assert.deepEqual(
      harness.records.overlapChecks,
      [{ dataDir, backupDir }],
      "A destination that is not due must still be checked against the current data directory",
    );
    assert.deepEqual(harness.records.events, [], "A not-due tick must not touch the backend");
    assert.deepEqual(
      await fs.readdir(backupDir),
      [path.basename(fresh)],
      "A not-due tick must not publish another archive",
    );
    const stored = await readAutoBackupError(harness, "inst-local");
    assert.ok(
      typeof stored === "string" && stored.includes("备份目录不能与数据目录相同"),
      "The revalidation must surface the overlap again, not only when a backup is due",
    );
    assertClean(harness);
  });
});

test("a stored target equal to the data directory fails the tick without archiving", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(dataDir, { recursive: true });
    const config = makeConfig({
      backupDir: dataDir, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });

    await harness.timers.startup();

    assert.equal(harness.records.backups.length, 0);
    assert.deepEqual(await fs.readdir(dataDir), [], "The data directory must stay untouched");
    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "error", progress: 0 }]);
    assertClean(harness);
  });
});

test("a stored target enclosing the data directory is refused by the manual auto backup", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(dataDir, { recursive: true });
    const config = makeConfig({
      backupDir: scratch, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });

    await assert.rejects(
      harness.handlers.get(harness.IpcChannels.autoBackupNow)(null, { instanceId: "inst-local" }),
      /备份目录不能与数据目录相同/,
    );

    assert.equal(harness.records.backups.length, 0);
    assert.deepEqual(harness.records.events, [], "An invalid target must not stop the backend");
    assert.equal(harness.state.backendRunning, true);
    // fixture 只创建 data 目录：被拒绝的手动备份不得在 scratch 里留下任何其他内容。
    assert.deepEqual((await fs.readdir(scratch)).sort(), ["data"]);
    assertClean(harness);
  });
});

test("a manual backup destination overlapping the data directory is refused before the backend stops", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(dataDir, { recursive: true });
    const config = makeConfig({
      backupDir: path.join(scratch, "backups"), keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });
    const backupData = harness.handlers.get(harness.IpcChannels.backupData);
    const refused = [
      ["inside the data directory", path.join(dataDir, "openfic-data-backup.tar.gz")],
      ["a parent of the data directory", path.join(scratch, "openfic-data-backup.tar.gz")],
    ];

    for (const [label, targetPath] of refused) {
      await assert.rejects(
        backupData(null, { instanceId: "inst-local", targetPath }),
        /备份目录不能与数据目录相同/,
        `A destination ${label} must be refused`,
      );
      await assert.rejects(fs.stat(targetPath), `No archive may be created for a destination ${label}`);
    }

    assert.equal(harness.records.backups.length, 0, "An overlapping destination must never be archived");
    assert.deepEqual(harness.records.events, [], "An invalid destination must not stop the backend");
    assert.equal(harness.state.backendRunning, true);
    assert.deepEqual(await fs.readdir(dataDir), [], "The data directory must stay untouched");
    assertClean(harness);
  });
});

test("a manual backup destination outside the data directory still archives", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    const exportDir = path.join(scratch, "export");
    await Promise.all([fs.mkdir(dataDir, { recursive: true }), fs.mkdir(exportDir, { recursive: true })]);
    const config = makeConfig({
      backupDir: path.join(scratch, "backups"), keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });
    const targetPath = path.join(exportDir, "openfic-data-backup.tar.gz");

    await harness.handlers.get(harness.IpcChannels.backupData)(null, { instanceId: "inst-local", targetPath });

    assert.deepEqual(harness.records.events, ["options", "suspend", "backup"]);
    assert.equal(harness.records.backups.length, 1);
    assert.equal(harness.records.backups[0].dataDir, dataDir);
    assert.equal(harness.records.backups[0].targetPath, targetPath);
    assert.equal(
      harness.state.backendRunning,
      false,
      "A manual backup leaves the backend stopped until the user returns",
    );
    assertClean(harness);
  });
});

test("a newly picked auto backup directory inside the data directory is rejected before it is stored", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    const acceptedDir = path.join(scratch, "accepted-backups");
    await Promise.all([fs.mkdir(dataDir, { recursive: true }), fs.mkdir(acceptedDir, { recursive: true })]);
    const config = makeConfig({
      backupDir: path.join(scratch, "backups"), keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });
    const saveConfig = harness.handlers.get(harness.IpcChannels.saveConfig);

    await assert.rejects(
      saveConfig(null, {
        config: { ...config, autoBackup: { enabled: true, dir: path.join(dataDir, "backups"), keep: 2 } },
      }),
      /备份目录不能与数据目录相同/,
    );
    assert.equal(harness.records.writes.length, 0, "A rejected directory must not be stored");
    assert.equal(harness.records.saved.length, 0);
    assert.equal(harness.state.config.autoBackup.dir, path.join(scratch, "backups"));
    assert.ok(harness.records.logs.some((message) => message.includes("拒绝自动备份目录")));

    await saveConfig(null, {
      config: { ...config, autoBackup: { enabled: true, dir: acceptedDir, keep: 3 } },
    });

    assert.equal(harness.records.writes.length, 1, "A target outside the data directory must still be stored");
    assert.equal(harness.records.writes[0].autoBackup.dir, acceptedDir);
    assert.equal(harness.records.writes[0].autoBackup.keep, 3);
    assertClean(harness);
  });
});

test("an unchanged overlapping directory keeps allowing unrelated config saves", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const legacyDir = path.join(dataDir, "backups");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(legacyDir, { recursive: true });
    const config = makeConfig({
      backupDir: legacyDir, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });
    const saveConfig = harness.handlers.get(harness.IpcChannels.saveConfig);

    await saveConfig(null, { config: { ...config, zoomFactor: 1.5 } });

    assert.equal(harness.records.writes.length, 1, "An unchanged legacy target must not block the save");
    assert.equal(harness.records.writes[0].autoBackup.dir, legacyDir);
    assert.deepEqual(harness.records.overlapChecks, [], "An unchanged directory needs no re-validation");
    assertClean(harness);
  });
});

test("a scheduled rejection is visible as an automatic error event and a stored failure", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const backupDir = path.join(dataDir, "backups");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(backupDir, { recursive: true });
    const config = makeConfig({
      backupDir, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });

    assert.equal(await readAutoBackupError(harness, "inst-local"), null, "No failure before the first run");

    await harness.timers.startup();

    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "error", progress: 0 }]);
    const [event] = automaticTerminals(harness.records);
    assert.equal(event.phase, "error");
    assert.ok(event.message.includes("备份目录不能与数据目录相同"), "The event must carry the reason");
    const stored = await readAutoBackupError(harness, "inst-local");
    assert.ok(
      typeof stored === "string" && stored.includes("备份目录不能与数据目录相同"),
      "A scheduled failure must outlive the page that missed the event",
    );
    assert.equal(harness.records.backups.length, 0, "An overlapping target must never be archived");
    assert.equal(harness.state.backendRunning, true, "An invalid target must not stop the backend");
    assertClean(harness);
  });
});

test("a later successful run clears the stored failure", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const legacyDir = path.join(dataDir, "backups");
    const acceptedDir = path.join(scratch, "accepted-backups");
    const installDir = path.join(scratch, "install");
    await Promise.all([
      fs.mkdir(legacyDir, { recursive: true }),
      fs.mkdir(acceptedDir, { recursive: true }),
    ]);
    const config = makeConfig({
      backupDir: legacyDir, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });

    await harness.timers.startup();
    assert.ok(await readAutoBackupError(harness, "inst-local"), "The rejected tick must be recorded");

    // 目录在应用之外被修正（例如数据目录被移回原位）后，下一次备份必须清掉旧的失败。
    harness.state.config = { ...config, autoBackup: { enabled: true, dir: acceptedDir, keep: 2 } };
    harness.state.backendRunning = true;
    await harness.timers.startup();

    assert.deepEqual(terminal(harness.records), [
      { operation: "backup", phase: "error", progress: 0 },
      { operation: "backup", phase: "done", progress: 1 },
    ]);
    assert.equal(harness.records.backups.length, 1);
    assert.equal(await readAutoBackupError(harness, "inst-local"), null, "A success must clear the failure");
    assertClean(harness);
  });
});

test("a rejected destination neither persists nor clears the stored failure, a valid one clears it", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const backupDir = path.join(dataDir, "backups");
    const acceptedDir = path.join(scratch, "accepted-backups");
    const installDir = path.join(scratch, "install");
    await Promise.all([
      fs.mkdir(backupDir, { recursive: true }),
      fs.mkdir(acceptedDir, { recursive: true }),
    ]);
    const config = makeConfig({
      backupDir, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });
    const saveConfig = harness.handlers.get(harness.IpcChannels.saveConfig);

    await harness.timers.startup();
    assert.ok(await readAutoBackupError(harness, "inst-local"), "The rejected tick must be recorded");

    await assert.rejects(
      saveConfig(null, {
        config: { ...config, autoBackup: { enabled: true, dir: dataDir, keep: 2 } },
      }),
      /备份目录不能与数据目录相同/,
    );

    assert.equal(harness.records.writes.length, 0, "A rejected target must not be stored");
    assert.equal(harness.records.saved.length, 0);
    assert.equal(harness.state.config.autoBackup.dir, backupDir);
    assert.ok(
      await readAutoBackupError(harness, "inst-local"),
      "A rejected target must not pretend the failure is gone",
    );

    await saveConfig(null, {
      config: { ...config, autoBackup: { enabled: true, dir: acceptedDir, keep: 2 } },
    });

    assert.equal(harness.records.writes.length, 1);
    assert.equal(harness.records.writes[0].autoBackup.dir, acceptedDir);
    assert.equal(
      await readAutoBackupError(harness, "inst-local"),
      null,
      "A destination that passes admission must clear the failure",
    );
    assertClean(harness);
  });
});

test("re-enabling a stored overlapping destination is rejected before it is stored", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const legacyDir = path.join(dataDir, "backups");
    const installDir = path.join(scratch, "install");
    await fs.mkdir(legacyDir, { recursive: true });
    const config = makeConfig({
      backupDir: legacyDir, keep: 2, enabled: false, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });
    const saveConfig = harness.handlers.get(harness.IpcChannels.saveConfig);

    await assert.rejects(
      saveConfig(null, {
        config: { ...config, autoBackup: { enabled: true, dir: legacyDir, keep: 2 } },
      }),
      /备份目录不能与数据目录相同/,
      "Enabling a stored overlapping target must be refused",
    );

    assert.equal(harness.records.writes.length, 0, "A refused enable must not be stored");
    assert.equal(harness.records.saved.length, 0);
    assert.equal(harness.state.config.autoBackup.enabled, false);
    assert.ok(harness.records.logs.some((message) => message.includes("拒绝自动备份目录")));
    assertClean(harness);
  });
});

test("a data directory change that swallows the backup destination records a visible failure", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const backupDir = path.join(scratch, "backups");
    const installDir = path.join(scratch, "install");
    await Promise.all([
      fs.mkdir(dataDir, { recursive: true }),
      fs.mkdir(backupDir, { recursive: true }),
    ]);
    const config = makeConfig({
      backupDir, keep: 2, activeInstanceId: "inst-local",
      instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
    });
    const harness = await createHarness({ config });
    const newDataDir = path.join(backupDir, "data");

    const result = await harness.handlers.get(harness.IpcChannels.migrateData)(
      null,
      { instanceId: "inst-local", newDataDir, deleteOldDir: false },
    );

    assert.equal(result.dataDir, newDataDir, "The migration itself must still complete");
    assert.equal(result.migrated, true);
    assert.deepEqual(harness.records.migrations, [{ fromDir: dataDir, toDir: newDataDir }]);
    const stored = await readAutoBackupError(harness, "inst-local");
    assert.ok(
      typeof stored === "string" && stored.includes("备份目录不能与数据目录相同"),
      "A later data directory move must report the broken destination right away",
    );
    assert.ok(harness.records.logs.some((message) => message.includes("数据目录变更后自动备份目录失效")));
    assertClean(harness);
  });
});

// 定时自动备份的写作暂停协议：主进程必须等实例内每个在线写作窗口确认「当前章节已保存且编辑已暂停」，
// 才允许停止后端；任何未确认的窗口都会取消这次尝试，且无论成败都要解除暂停。

/** 一个到期（含历史归档）的备份目录：先写入若干 5 天前的归档，让本次调度必须备份。 */
async function makeDueBackupDir(scratch, { staleArchives = 1 } = {}) {
  const backupDir = path.join(scratch, "backups");
  await fs.mkdir(backupDir, { recursive: true });
  const stale = new Date(Date.now() - 5 * dayMs);
  for (let index = 0; index < staleArchives; index += 1) {
    const fullPath = path.join(backupDir, archiveName(`2026010${index + 1}-000000`));
    await fs.writeFile(fullPath, "old archive\n");
    await fs.utimes(fullPath, stale, stale);
  }
  return backupDir;
}

function pauseConfig(backupDir, dataDir, installDir, keep = 1) {
  return makeConfig({
    backupDir, keep, activeInstanceId: "inst-local",
    instances: [makeLocalInstance({ id: "inst-local", dataDir, installDir })],
  });
}

test("a scheduled backup waits for the writing window to save and pause before stopping the backend", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    const backupDir = await makeDueBackupDir(scratch);
    const harness = await createHarness({
      config: pauseConfig(backupDir, dataDir, installDir),
      webviews: [makeWebview(7)],
    });

    const pending = tick(harness);
    await waitFor(() => harness.records.events.includes("pause"), "the pause request");

    const [{ requestId, guestId }] = harness.records.pauseRequests;
    assert.equal(guestId, 7, "Only the live window of the target instance must be asked");
    assert.ok(typeof requestId === "string" && requestId.length > 0);
    assert.deepEqual(
      harness.records.events,
      ["options", "pause"],
      "The archive must not start before the window confirms",
    );
    assert.equal(harness.state.backendRunning, true, "The backend must stay up until the confirmation arrives");
    assert.equal(harness.records.backups.length, 0);
    const deadline = pauseDeadline(harness);

    assert.equal(
      await harness.acknowledgePause({ guestId: 7, requestId, ok: true }),
      true,
      "A confirmation from the requested window must be accepted",
    );
    await pending;

    assert.deepEqual(
      harness.records.events,
      ["options", "pause", "suspend", "backup", "resume", "release"],
      "Stopping, archiving and resuming the backend must all sit between pause and release",
    );
    assert.equal(deadline.cleared, true, "The pause deadline must be cleared once the window confirmed");
    assert.equal(harness.records.releases.length, 1);
    assert.equal(harness.records.releases[0].guestId, 7);
    assert.equal(harness.records.releases[0].requestId, requestId, "The release must name the confirmed request");
    assert.equal(harness.records.backups.length, 1);
    assert.deepEqual(
      await fs.readdir(backupDir),
      [path.basename(harness.records.backups[0].targetPath)],
      "A confirmed backup must still publish and rotate the archive",
    );
    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "done", progress: 1 }]);
    assert.equal(await readAutoBackupError(harness, "inst-local"), null);
    assertClean(harness);
  });
});

test("every online writing window must confirm before the backend stops", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    const backupDir = await makeDueBackupDir(scratch, { staleArchives: 0 });
    const harness = await createHarness({
      config: pauseConfig(backupDir, dataDir, installDir, 2),
      webviews: [makeWebview(7), makeWebview(8)],
    });

    const pending = tick(harness);
    await waitFor(() => harness.records.pauseRequests.length === 2, "both pause requests");

    assert.deepEqual(
      harness.records.pauseRequests.map((entry) => entry.guestId),
      [7, 8],
      "Every live window of the instance must be asked",
    );
    const requestId = harness.records.pauseRequests[0].requestId;
    assert.equal(harness.records.pauseRequests[1].requestId, requestId, "One attempt uses one request id");

    assert.equal(await harness.acknowledgePause({ guestId: 7, requestId, ok: true }), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(
      harness.records.events,
      ["options", "pause", "pause"],
      "A single confirmation must not be enough while another window is still silent",
    );
    assert.equal(harness.state.backendRunning, true);

    assert.equal(await harness.acknowledgePause({ guestId: 8, requestId, ok: true }), true);
    await pending;

    assert.deepEqual(
      harness.records.events,
      ["options", "pause", "pause", "suspend", "backup", "resume", "release", "release"],
    );
    assert.deepEqual(harness.records.releases.map((entry) => entry.guestId), [7, 8]);
    assertClean(harness);
  });
});

test("a window that cannot save cancels the attempt before the backend stops", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    const backupDir = await makeDueBackupDir(scratch);
    const harness = await createHarness({
      config: pauseConfig(backupDir, dataDir, installDir),
      webviews: [makeWebview(7)],
    });

    const pending = tick(harness);
    await waitFor(() => harness.records.events.includes("pause"), "the pause request");
    const [{ requestId }] = harness.records.pauseRequests;

    assert.equal(
      await harness.acknowledgePause({ guestId: 7, requestId, ok: false, reason: "save-failed" }),
      true,
      "A negative confirmation must be accepted as the answer of this attempt",
    );
    await pending;

    assert.deepEqual(
      harness.records.events,
      ["options", "pause", "release"],
      "A failed save only releases the pause: no stop, no archive",
    );
    assert.equal(harness.state.backendRunning, true, "A failed save must not stop the backend");
    assert.equal(harness.records.backups.length, 0);
    assert.deepEqual(
      await fs.readdir(backupDir),
      [archiveName("20260101-000000")],
      "A failed save must not publish or rotate archives",
    );
    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "error", progress: 0 }]);
    const stored = await readAutoBackupError(harness, "inst-local");
    assert.ok(
      typeof stored === "string" && stored.includes("章节保存失败"),
      "The failure must name the reason the window reported",
    );
    assertClean(harness);
  });
});

test("a window that never confirms cancels the attempt by timeout and stays retryable", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    const backupDir = await makeDueBackupDir(scratch);
    const harness = await createHarness({
      config: pauseConfig(backupDir, dataDir, installDir),
      webviews: [makeWebview(7)],
    });

    const pending = tick(harness);
    await waitFor(() => harness.records.events.includes("pause"), "the pause request");
    const deadline = pauseDeadline(harness);
    assert.equal(harness.pauseTimeoutMs, 20_000, "The confirmation deadline must stay 20 seconds");
    assert.equal(deadline.timeout, harness.pauseTimeoutMs);

    deadline.handler();
    await pending;

    assert.deepEqual(harness.records.events, ["options", "pause", "release"], "A timeout must release the pause");
    assert.equal(harness.state.backendRunning, true, "A timeout must never stop the backend");
    assert.equal(harness.records.backups.length, 0, "A timeout must never archive");
    assert.deepEqual(await fs.readdir(backupDir), [archiveName("20260101-000000")], "A timeout must never rotate");
    const stored = await readAutoBackupError(harness, "inst-local");
    assert.ok(
      typeof stored === "string" && stored.includes("确认保存并暂停"),
      "The timeout must be recorded as a retryable failure",
    );

    // 下一个调度周期必须能重新尝试，并在这次确认后正常完成备份。
    const retry = tick(harness);
    await waitFor(() => harness.records.pauseRequests.length === 2, "the retried pause request");
    const retryRequest = harness.records.pauseRequests[1];
    assert.notEqual(retryRequest.requestId, harness.records.pauseRequests[0].requestId);
    assert.equal(await harness.acknowledgePause({ guestId: 7, requestId: retryRequest.requestId, ok: true }), true);
    await retry;

    assert.deepEqual(harness.records.events, [
      "options", "pause", "release",
      "options", "pause", "suspend", "backup", "resume", "release",
    ]);
    assert.equal(harness.records.backups.length, 1, "The retry must archive the data directory");
    assert.equal(await readAutoBackupError(harness, "inst-local"), null, "A later success must clear the failure");
    assertClean(harness);
  });
});

test("the writing pause is released when the archive fails", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    const backupDir = await makeDueBackupDir(scratch);
    const harness = await createHarness({
      config: pauseConfig(backupDir, dataDir, installDir),
      webviews: [makeWebview(7)],
    });
    harness.state.backupError = new Error("synthetic backup failure");

    const pending = tick(harness);
    await waitFor(() => harness.records.events.includes("pause"), "the pause request");
    const [{ requestId }] = harness.records.pauseRequests;
    await harness.acknowledgePause({ guestId: 7, requestId, ok: true });
    await pending;

    assert.deepEqual(
      harness.records.events,
      ["options", "pause", "suspend", "backup", "resume", "release"],
      "A failed archive must still resume the backend and release the writing pause",
    );
    assert.deepEqual(harness.records.releases, [{ guestId: 7, requestId }]);
    assert.deepEqual(await fs.readdir(backupDir), [archiveName("20260101-000000")], "A failed archive must not rotate");
    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "error", progress: 0 }]);
    assertClean(harness);
  });
});

test("the writing pause is released after a failed backend resume", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    const backupDir = await makeDueBackupDir(scratch);
    const harness = await createHarness({
      config: pauseConfig(backupDir, dataDir, installDir),
      webviews: [makeWebview(7)],
    });
    harness.state.resumeError = new Error("synthetic resume failure");

    const pending = tick(harness);
    await waitFor(() => harness.records.events.includes("pause"), "the pause request");
    const [{ requestId }] = harness.records.pauseRequests;
    await harness.acknowledgePause({ guestId: 7, requestId, ok: true });
    await pending;

    assert.deepEqual(
      harness.records.events,
      ["options", "pause", "suspend", "backup", "resume", "release"],
      "The release must be sent after the resume attempt, even when it rejects",
    );
    assert.deepEqual(harness.records.releases, [{ guestId: 7, requestId }]);
    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "error", progress: 0 }]);
    assert.ok(harness.records.logs.some((message) => message.includes("恢复服务失败")));
    assertClean(harness);
  });
});

test("a confirmation from an unasked window or an unknown payload never settles the attempt", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    const backupDir = await makeDueBackupDir(scratch);
    const harness = await createHarness({
      config: pauseConfig(backupDir, dataDir, installDir),
      webviews: [makeWebview(7)],
    });

    const pending = tick(harness);
    await waitFor(() => harness.records.events.includes("pause"), "the pause request");
    const [{ requestId }] = harness.records.pauseRequests;

    assert.equal(
      await harness.sendPauseAck({ requestId, ok: true }, 99),
      false,
      "A window that was never asked must not be able to confirm",
    );
    assert.equal(await harness.sendPauseAck({ requestId: "unknown-request", ok: true }, 7), false);
    assert.equal(
      await harness.sendPauseAck({ requestId, ok: "yes" }, 7),
      false,
      "An unknown shape must never be read as a successful save",
    );
    assert.equal(await harness.sendPauseAck(null, 7), false);
    assert.equal(await harness.sendPauseAck({ requestId, ok: true, reason: 5 }, 7), false);

    assert.deepEqual(
      harness.records.events,
      ["options", "pause"],
      "Refused confirmations must leave the attempt waiting",
    );
    assert.equal(harness.state.backendRunning, true);

    assert.equal(
      await harness.acknowledgePause({ guestId: 7, requestId, ok: true }),
      true,
      "A valid confirmation must still complete the attempt afterwards",
    );
    await pending;
    assert.deepEqual(harness.records.events, ["options", "pause", "suspend", "backup", "resume", "release"]);
    assertClean(harness);
  });
});

test("a live window that cannot receive the pause request cancels the attempt", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    const backupDir = await makeDueBackupDir(scratch);
    const harness = await createHarness({
      config: pauseConfig(backupDir, dataDir, installDir),
      webviews: [{ id: 7, instanceId: "inst-local", sendError: "renderer gone" }],
    });

    await tick(harness);

    assert.deepEqual(harness.records.events, ["options"], "A window that cannot be reached must cancel immediately");
    assert.equal(harness.state.backendRunning, true);
    assert.equal(harness.records.backups.length, 0);
    assert.deepEqual(await fs.readdir(backupDir), [archiveName("20260101-000000")], "Nothing may be archived or rotated");
    const stored = await readAutoBackupError(harness, "inst-local");
    assert.ok(
      typeof stored === "string" && stored.includes("写作窗口不可用") && stored.includes("renderer gone"),
      "The unreachable window must be reported as the failure reason",
    );
    assertClean(harness);
  });
});

test("a writing window of another instance neither pauses nor blocks the backup", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    const backupDir = await makeDueBackupDir(scratch);
    const harness = await createHarness({
      config: pauseConfig(backupDir, dataDir, installDir),
      webviews: [makeWebview(9, "inst-other")],
    });

    await tick(harness);

    assert.deepEqual(harness.records.pauseRequests, [], "Another instance's window must not be asked");
    assert.deepEqual(harness.records.events, ["options", "suspend", "backup", "resume"]);
    assert.equal(harness.records.backups.length, 1);
    assert.equal(harness.state.backendRunning, true);
    assert.deepEqual(terminal(harness.records), [{ operation: "backup", phase: "done", progress: 1 }]);
    assertClean(harness);
  });
});

test("a window that stopped being a webview is not asked to confirm", async () => {
  await withScratch(async (scratch) => {
    const dataDir = path.join(scratch, "data");
    const installDir = path.join(scratch, "install");
    const backupDir = await makeDueBackupDir(scratch);
    const harness = await createHarness({
      config: pauseConfig(backupDir, dataDir, installDir),
      webviews: [
        { id: 10, instanceId: "inst-local", type: "window" },
        { id: 11, instanceId: "inst-local", destroyed: true },
      ],
    });

    await tick(harness);

    assert.deepEqual(
      harness.records.pauseRequests,
      [],
      "Only live instance webviews may block a scheduled backup",
    );
    assert.deepEqual(harness.records.events, ["options", "suspend", "backup", "resume"]);
    assert.equal(harness.records.backups.length, 1);
    assertClean(harness);
  });
});
