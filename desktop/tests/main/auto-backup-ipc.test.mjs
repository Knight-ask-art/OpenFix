// The actual built registerIpc scheduler runs the real auto-backup helpers over an isolated
// synthetic filesystem; the suspend callback returns a private resume closure invoked once.
// Run after build:main with node --experimental-vm-modules --test.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

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

async function createHarness({ config, backendRunning = true }) {
  assert.equal(typeof vm.SourceTextModule, "function", "Use --experimental-vm-modules");
  const [ipcCode, autoBackupCode, sharedIpcCode, sharedConfigCode] = await Promise.all([
    fs.readFile(path.join(distMainDir, "ipc.js"), "utf8"),
    fs.readFile(path.join(distMainDir, "auto-backup.js"), "utf8"),
    fs.readFile(path.join(distSharedDir, "ipc.js"), "utf8"),
    fs.readFile(path.join(distSharedDir, "config.js"), "utf8"),
  ]);

  const timers = { startup: null, startupDelayMs: null, check: null, checkIntervalMs: null };
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
    events: [], progress: [], logs: [], backups: [], writes: [], saved: [], boundaryErrors: [],
  };

  const context = vm.createContext({
    console,
    URL,
    setTimeout: (handler, timeout) => {
      timers.startup = handler;
      timers.startupDelayMs = timeout;
      return { hasRef: () => false };
    },
    clearTimeout: () => {},
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
        return state.resumeResult;
      };
    },
  };

  const handlers = new Map();
  const listeners = new Map();
  const electron = {
    app: { getPath: () => deny("app.getPath"), getVersion: () => "0.11.1", isPackaged: false },
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
    session: { fromPartition: (partition) => ({ partition }) },
    shell: { openExternal: () => deny("shell.openExternal") },
    webContents: { getAllWebContents: () => [] },
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
      getDataOperationOptions: async (dataDir, runtimeDir) => {
        assert.equal(typeof dataDir, "string");
        assert.equal(typeof runtimeDir, "string");
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
      arePathsEqual: () => deny("arePathsEqual"),
      doPathsOverlap: () => deny("doPathsOverlap"),
      inspectDataDir: () => deny("inspectDataDir"),
      isPathWithin: () => deny("isPathWithin"),
      migrateDataDir: () => deny("migrateDataDir"),
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
  return { state, records, handlers, listeners, timers, IpcChannels };
}

// VM 上下文对象来自另一个 realm，比较前先还原为宿主 realm 的普通对象。
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function terminal(records) {
  return plain(records.progress.filter((event) => event.phase === "done" || event.phase === "error"));
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
