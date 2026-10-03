// The actual built local start handler and the actual app.tsx remote connect callback must keep
// every unrelated config field. Run after build:main with node --experimental-vm-modules --test.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const distMainDir = path.join(repoRoot, "desktop/dist/main");
const distSharedDir = path.join(repoRoot, "desktop/dist/shared");
const appTsxPath = path.join(repoRoot, "desktop/src/ui/app.tsx");
const tmpRoot = path.join(repoRoot, "tmp");

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !path.isAbsolute(relative)
    && relative !== ".." && !relative.startsWith(`..${path.sep}`);
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
  const owned = await openScratch("openfix-auto-backup-config-");
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

function makeConfig({ backupDir, activeInstanceId, instances, extra = {} }) {
  return {
    activeInstanceId,
    instances,
    zoomFactor: 1.3,
    autoBackup: { enabled: true, dir: backupDir, keep: 7 },
    ...extra,
  };
}

function makeLocalInstance({ id, dataDir, installDir }) {
  return {
    id, name: id, mode: "local", remoteUrl: null, autoStartLocal: true, installDir, dataDir,
  };
}

function makeRemoteInstance({ id, remoteUrl }) {
  return {
    id, name: "remote", mode: "remote", remoteUrl, autoStartLocal: false, installDir: null, dataDir: null,
  };
}

async function createIpcHarness({ config }) {
  assert.equal(typeof vm.SourceTextModule, "function", "Use --experimental-vm-modules");
  const [ipcCode, autoBackupCode, sharedIpcCode, sharedConfigCode] = await Promise.all([
    fs.readFile(path.join(distMainDir, "ipc.js"), "utf8"),
    fs.readFile(path.join(distMainDir, "auto-backup.js"), "utf8"),
    fs.readFile(path.join(distSharedDir, "ipc.js"), "utf8"),
    fs.readFile(path.join(distSharedDir, "config.js"), "utf8"),
  ]);
  const timers = { startup: null, check: null };
  const records = {
    writes: [], saved: [], started: [], backendSet: [], baseUrls: [],
    progress: [], failures: [], finished: [], boundaryErrors: [],
  };
  const state = { config };
  const context = vm.createContext({
    console,
    URL,
    setTimeout: (handler) => { timers.startup = handler; return { hasRef: () => false }; },
    clearTimeout: () => {},
    setInterval: (handler) => { timers.check = handler; return { hasRef: () => false }; },
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

  const sharedIpcModule = new vm.SourceTextModule(sharedIpcCode, {
    context, identifier: path.join(distSharedDir, "ipc.js"),
    importModuleDynamically: () => deny("shared ipc dynamic import"),
  });
  const sharedConfigModule = new vm.SourceTextModule(sharedConfigCode, {
    context, identifier: path.join(distSharedDir, "config.js"),
    importModuleDynamically: () => deny("shared config dynamic import"),
  });
  const denyLink = (specifier, referencingModule) => {
    throw new Error(`Forbidden import ${specifier} in ${referencingModule.identifier}`);
  };
  await Promise.all([sharedIpcModule.link(denyLink), sharedConfigModule.link(denyLink)]);
  await Promise.all([sharedIpcModule.evaluate(), sharedConfigModule.evaluate()]);
  const IpcChannels = sharedIpcModule.namespace.IpcChannels;

  const window = {
    webContents: {
      send: (channel, event) => {
        assert.equal(channel, IpcChannels.startupProgress);
        records.progress.push(event);
      },
    },
  };
  const defaultDataDir = path.join(repoRoot, "tmp", "harness-default-data");
  const defaultInstallDir = path.join(repoRoot, "tmp", "harness-default-install");

  const ipcContext = {
    shellWindow: () => window,
    setBackend: (handle) => { records.backendSet.push(handle); },
    setBackendBaseUrl: (url) => { records.baseUrls.push(url); },
    setLogsDir: () => deny("setLogsDir"),
    beginStartupOperation: () => { const controller = new AbortController(); return controller; },
    finishStartupOperation: (controller) => { records.finished.push(controller); },
    initializeApp: () => deny("initializeApp"),
    cancelStartup: () => deny("cancelStartup"),
    switchInstance: () => deny("switchInstance"),
    pingInstance: () => deny("pingInstance"),
    onConfigSaved: (next) => { records.saved.push(next); },
    isBackendRunning: () => false,
    stopActiveBackend: () => deny("stopActiveBackend"),
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
      on: (channel, listener) => {
        assert.equal(listeners.has(channel), false, `Duplicate listener ${channel}`);
        listeners.set(channel, listener);
      },
    },
    session: { fromPartition: (partition) => ({ partition }) },
    shell: { openExternal: () => deny("shell.openExternal") },
    webContents: { getAllWebContents: () => [] },
  };
  const dependencies = {
    "electron": synthetic("synthetic:electron", electron),
    "node:path": synthetic("synthetic:path", { default: path }),
    "../shared/ipc.js": sharedIpcModule,
    "../shared/config.js": sharedConfigModule,
    "./config.js": synthetic("synthetic:config", {
      createDefaultConfig: () => ({ activeInstanceId: null, instances: [] }),
      readDesktopConfig: async () => state.config,
      writeDesktopConfig: async (next) => { state.config = next; records.writes.push(next); },
    }),
    "./auto-backup.js": null,
    "./protocol.js": synthetic("synthetic:protocol", {
      ensureAppProtocolForPartition: () => deny("ensureAppProtocolForPartition"),
    }),
    "./local-instance.js": synthetic("synthetic:local-instance", {
      findLocalInstanceByInstallDir: () => undefined,
      normalizeInstallDir: (installDir) => installDir,
    }),
    "./runtime/setup-runner.js": synthetic("synthetic:setup-runner", {
      inspectLocalRuntime: () => deny("inspectLocalRuntime"),
      installLocalRuntime: () => deny("installLocalRuntime"),
      startLocalBackendFromInstall: async (installDir, startupProgress, signal, dataDir) => {
        records.started.push({ installDir, dataDir, aborted: signal?.aborted === true });
        assert.equal(typeof startupProgress.begin, "function");
        return {
          handle: { baseUrl: "http://127.0.0.1:1/", logPath: path.join(repoRoot, "tmp", "harness.log"), process: {} },
          maintenanceError: null,
        };
      },
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
      getDataOperationOptions: () => deny("getDataOperationOptions"),
      backupDataDir: () => deny("backupDataDir"),
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
      createStartupProgressTracker: (emit) => ({
        begin: (event) => emit({ ...event, status: "running" }),
        update: (event) => emit({ ...event, status: "running" }),
        complete: (message) => emit({ status: "done", message: message ?? null }),
        fail: (error) => { records.failures.push(error); },
      }),
      getStartupProgress: () => deny("getStartupProgress"),
    }),
    "./logging.js": synthetic("synthetic:logging", {
      appendLog: (category, message) => {
        assert.equal(category, "runtime");
        records.progress.push({ log: message });
      },
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
  ipcModule.namespace.registerIpc(ipcContext);
  return { records, handlers, listeners, IpcChannels };
}

async function loadRemoteConnectCallback() {
  const ts = require("typescript");
  const source = await fs.readFile(appTsxPath, "utf8");
  const sourceFile = ts.createSourceFile(appTsxPath, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const helperNames = ["normalizeRemoteUrl", "getRemoteInstanceName", "createInstanceId", "getShellAppearance"];
  const snippets = new Map();
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && helperNames.includes(node.name.text)) {
      snippets.set(node.name.text, node.getText(sourceFile));
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "handleConnectRemote") {
      snippets.set("handleConnectRemote", node.parent.parent.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const name of [...helperNames, "handleConnectRemote"]) {
    assert.ok(snippets.has(name), `app.tsx must define ${name}`);
  }
  const combined = [
    ...helperNames.map((name) => snippets.get(name)),
    snippets.get("handleConnectRemote"),
    "export { handleConnectRemote };",
  ].join("\n");
  const { outputText } = ts.transpileModule(combined, {
    fileName: "app-remote-connect.tsx",
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  return outputText;
}

async function invokeRemoteConnect(outputText, previousConfig) {
  const calls = { saveConfig: [], switchInstance: [], showFrontend: [], shellStates: [] };
  const desktopApi = {
    getConfig: async () => previousConfig,
    saveConfig: async (next) => { calls.saveConfig.push(next); },
    switchInstance: async (instanceId) => {
      calls.switchInstance.push(instanceId);
      return { status: "ready", activeInstanceId: instanceId };
    },
  };
  const moduleObject = { exports: {} };
  const factory = new Function(
    "exports", "module", "window", "i18n", "startupRequestId", "shellAppearance",
    "setShellAppearance", "setError", "setCompatibilityWarning", "setUpdateDialogOpen",
    "setSetupInitialRemoteUrl", "setStartupProgress", "setShellState", "showFrontend",
    outputText,
  );
  factory(
    moduleObject.exports,
    moduleObject,
    { openficDesktop: desktopApi },
    { t: (key) => key },
    { current: 0 },
    { appearance: "light" },
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    (shellState) => { calls.shellStates.push(shellState); },
    async () => { calls.showFrontend.push(true); },
  );
  await moduleObject.exports.handleConnectRemote("https://Remote.EXAMPLE.com/");
  return calls;
}

test("the local start handler keeps auto backup, zoom and future fields", async () => {
  await withScratch(async (scratch) => {
    const installDir = path.join(scratch, "install");
    const dataDir = path.join(scratch, "data");
    const future = { nested: { value: 1 } };
    const config = makeConfig({
      backupDir: path.join(scratch, "backups"),
      activeInstanceId: "inst-remote",
      instances: [makeRemoteInstance({ id: "inst-remote", remoteUrl: "https://remote.example.com" })],
      extra: { futureField: future },
    });
    const harness = await createIpcHarness({ config });
    const handler = harness.handlers.get(harness.IpcChannels.startLocalBackend);

    await handler(null, { installDir, dataDir });

    assert.deepEqual(harness.records.boundaryErrors, []);
    assert.equal(harness.records.writes.length, 1);
    const written = harness.records.writes[0];
    assert.deepEqual(written.autoBackup, config.autoBackup);
    assert.equal(written.zoomFactor, config.zoomFactor);
    assert.equal(written.futureField, future);
    assert.equal(harness.records.saved[0], written);
    assert.equal(harness.records.started.length, 1);
    assert.equal(harness.records.started[0].installDir, installDir);
    assert.equal(harness.records.started[0].dataDir, dataDir);
    assert.equal(harness.records.started[0].aborted, false);
    assert.deepEqual(harness.records.baseUrls, ["http://127.0.0.1:1/"]);
    assert.equal(harness.records.failures.length, 0);
    assert.ok(harness.records.progress.some((event) => event.status === "done"));

    const local = written.instances.find((instance) => instance.mode === "local");
    assert.ok(local, "A local instance must be registered");
    assert.equal(written.activeInstanceId, local.id);
    assert.equal(local.installDir, installDir);
    assert.equal(local.dataDir, path.resolve(dataDir));
    assert.ok(written.instances.some((instance) => instance.id === "inst-remote"));
  });
});

test("the remote connect callback keeps auto backup, zoom and future fields", async () => {
  const previousConfig = {
    activeInstanceId: "inst-local",
    instances: [makeLocalInstance({ id: "inst-local", dataDir: "D:/data", installDir: "D:/install" })],
    zoomFactor: 1.3,
    autoBackup: { enabled: true, dir: "D:/backups", keep: 7 },
    futureField: { nested: { value: 2 } },
  };
  const outputText = await loadRemoteConnectCallback();

  const calls = await invokeRemoteConnect(outputText, previousConfig);

  assert.equal(calls.saveConfig.length, 1);
  const next = calls.saveConfig[0];
  assert.deepEqual(next.autoBackup, previousConfig.autoBackup);
  assert.equal(next.zoomFactor, 1.3);
  assert.equal(next.futureField, previousConfig.futureField);
  assert.equal(next.activeInstanceId, "inst-local");
  assert.equal(next.instances.length, 2);
  const remote = next.instances.find((instance) => instance.mode === "remote");
  assert.ok(remote, "The remote instance must be registered");
  assert.equal(remote.remoteUrl, "https://remote.example.com");
  assert.equal(remote.name, "remote.example.com");
  assert.equal(remote.autoStartLocal, false);
  assert.equal(remote.installDir, null);
  assert.equal(remote.dataDir, null);
  assert.deepEqual(calls.switchInstance, [remote.id]);
  assert.equal(calls.showFrontend.length, 1);
});

test("the remote connect callback reuses an existing remote instance and keeps config fields", async () => {
  const existing = makeRemoteInstance({ id: "inst-remote", remoteUrl: "https://remote.example.com" });
  const previousConfig = {
    activeInstanceId: "inst-remote",
    instances: [existing],
    zoomFactor: 1.1,
    autoBackup: { enabled: false, dir: "D:/backups", keep: 3 },
  };
  const outputText = await loadRemoteConnectCallback();

  const calls = await invokeRemoteConnect(outputText, previousConfig);

  const next = calls.saveConfig[0];
  assert.equal(next.instances.length, 1);
  assert.deepEqual(next.instances, previousConfig.instances);
  assert.deepEqual(next.autoBackup, previousConfig.autoBackup);
  assert.equal(next.zoomFactor, 1.1);
  assert.equal(next.activeInstanceId, "inst-remote");
  assert.deepEqual(calls.switchInstance, ["inst-remote"]);
});
