// The actual built ipc scheduler drives the actual AST-extracted main stop/resume/initialize chain,
// which calls the actual built port allocator plus the actual local/dev runtimes, and then feeds the
// actual renderer runtime-config/api-client/socket-url seams. The net, subprocess, health, protocol,
// Electron and filesystem seams are strict synthetics: no real process, network, Python, provider or
// filesystem access. Run after build:main with node --experimental-vm-modules --test.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const VERSION = "0.11.1";
const DEV_INSTANCE_ID = "instance-dev-local";
const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const distMainDir = path.join(repoRoot, "desktop/dist/main");
const distSharedDir = path.join(repoRoot, "desktop/dist/shared");
const mainSourcePath = path.join(repoRoot, "desktop/src/main/main.ts");
const syntheticBackupDir = path.join(repoRoot, "tmp", "synthetic-auto-backup-dir");
const devDataDir = path.join(repoRoot, "tmp", "dev-data");
const localDataDir = path.join(repoRoot, "tmp", "synthetic-data");
const localRuntimeDir = path.join(repoRoot, "tmp", "synthetic-install", "Runtime");
const openficCommand = process.platform === "win32" ? "synthetic-openfic.exe" : "synthetic-python";

// Exact whitelist: only the existing lifecycle owner functions plus their module state are lifted.
const MAIN_FUNCTIONS = [
  "writeStartupLog", "setBackend", "clearBackend", "isBackendRunning", "stopActiveBackend",
  "setBackendBaseUrl", "createStartupProgress", "beginStartupOperation", "finishStartupOperation",
  "startLocalBackend", "getActiveInstance", "activateInstance", "initializeDevApp", "initializeApp",
];
const MAIN_STATE = ["mainWindow", "backendHandle", "activeInstanceId", "isQuitting", "startupAbortController"];
const MAIN_IMPORTS = [
  'import { app, dialog } from "electron";',
  'import { mkdir } from "node:fs/promises";',
  'import { setRuntimeConfig } from "./protocol.js";',
  'import { getDevDataDir, isDevMode, DEV_INSTANCE_ID, startDevBackend } from "./runtime/dev-backend.js";',
  'import { readDesktopConfig, writeDesktopConfig } from "./config.js";',
  'import { throwIfAborted, waitForBackend } from "./health.js";',
  'import { ensurePortablePython, resolveRuntimeDir } from "./runtime/python.js";',
  'import { ensureOpenFicRuntime, startLocalOpenFicBackend } from "./runtime/openfic.js";',
  'import { stopBackendProcess } from "./process.js";',
  'import { resolveDataDir } from "./data-location.js";',
  'import { createStartupProgressTracker } from "./startup-progress.js";',
  'import { IpcChannels } from "../shared/ipc.js";',
  'import { appendLog, setLogsDir } from "./logging.js";',
  'import { syncTelemetryEnabled } from "./telemetry.js";',
].join("\n");
const MAIN_GLUE = [
  "export { initializeApp, initializeDevApp, stopActiveBackend, isBackendRunning, setBackend, setBackendBaseUrl, beginStartupOperation, finishStartupOperation };",
  "export function readBackend() { return backendHandle; }",
  "export function readActiveInstanceId() { return activeInstanceId; }",
  "export function seedWindow(target) { mainWindow = target; }",
].join("\n");

// TypeScript AST extraction of the real functions; no regex or textual rewriting of main.ts.
async function extractMainSnippet(ts) {
  const source = await fs.readFile(mainSourcePath, "utf8");
  const sourceFile = ts.createSourceFile(mainSourcePath, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const snippets = new Map();
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && MAIN_FUNCTIONS.includes(node.name.text)) {
      snippets.set(node.name.text, node.getText(sourceFile));
    }
    if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
      const [declaration] = node.declarationList.declarations;
      if (ts.isIdentifier(declaration.name) && MAIN_STATE.includes(declaration.name.text)) {
        snippets.set(declaration.name.text, node.getText(sourceFile));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const name of [...MAIN_STATE, ...MAIN_FUNCTIONS]) {
    assert.ok(snippets.has(name), `main.ts must still define ${name}`);
  }
  const combined = [MAIN_IMPORTS, ...MAIN_STATE.map((name) => snippets.get(name)),
    ...MAIN_FUNCTIONS.map((name) => snippets.get(name)), MAIN_GLUE].join("\n");
  return ts.transpileModule(combined, {
    fileName: "main-runtime-continuity.ts",
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}

// Strict synthetic IPv4 allocator: requested ports are checked/reused, 0 allocates from a fixed pool.
function createNetSeam() {
  const requested = [];
  const occupied = new Set();
  const pool = [31001, 31002, 31003, 31004];
  const createServer = () => {
    const server = {
      handler: null,
      boundPort: null,
      unref() {},
      on(event, handler) {
        assert.equal(event, "error");
        server.handler = handler;
        return server;
      },
      listen(port, host, callback) {
        assert.equal(host, "127.0.0.1");
        assert.equal(typeof callback, "function");
        requested.push(port);
        const target = port === 0 ? pool.find((candidate) => !occupied.has(candidate)) : port;
        assert.ok(target, "Synthetic port pool exhausted");
        if (occupied.has(target)) {
          server.handler(Object.assign(new Error(`listen EADDRINUSE: address already in use 127.0.0.1:${target}`), { code: "EADDRINUSE" }));
          return;
        }
        occupied.add(target);
        server.boundPort = target;
        queueMicrotask(callback);
      },
      address() {
        return server.boundPort === null ? null : { port: server.boundPort };
      },
      close(callback) {
        if (server.boundPort !== null) occupied.delete(server.boundPort);
        server.boundPort = null;
        queueMicrotask(callback ?? (() => {}));
      },
    };
    return server;
  };
  return { requested, occupied, pool, module: { default: { createServer } } };
}

function makeConfig() {
  const instanceId = "inst-local";
  return {
    activeInstanceId: instanceId,
    instances: [{
      id: instanceId, name: instanceId, mode: "local", remoteUrl: null, autoStartLocal: true,
      installDir: path.join(repoRoot, "tmp", "synthetic-install"),
      dataDir: path.join(repoRoot, "tmp", "synthetic-data"),
    }],
    zoomFactor: 1.3,
    autoBackup: { enabled: true, dir: syntheticBackupDir, keep: 2 },
  };
}

async function createHarness({ config, devMode = false, devBackendUrl = null } = {}) {
  assert.equal(typeof vm.SourceTextModule, "function", "Use --experimental-vm-modules");
  const ts = require("typescript");
  const [ipcCode, autoBackupCode, sharedIpcCode, sharedConfigCode, portsCode, openficCode, devBackendCode, commandsCode] =
    await Promise.all([
      fs.readFile(path.join(distMainDir, "ipc.js"), "utf8"),
      fs.readFile(path.join(distMainDir, "auto-backup.js"), "utf8"),
      fs.readFile(path.join(distSharedDir, "ipc.js"), "utf8"),
      fs.readFile(path.join(distSharedDir, "config.js"), "utf8"),
      fs.readFile(path.join(distMainDir, "ports.js"), "utf8"),
      fs.readFile(path.join(distMainDir, "runtime/openfic.js"), "utf8"),
      fs.readFile(path.join(distMainDir, "runtime/dev-backend.js"), "utf8"),
      fs.readFile(path.join(distMainDir, "runtime/openfic-commands.js"), "utf8"),
    ]);

  const env = {
    ...(devMode ? { OPENFIC_DEV_MODE: "1" } : {}),
    ...(devBackendUrl ? { OPENFIC_DEV_BACKEND_URL: devBackendUrl } : {}),
  };
  const state = { stopError: null, stopGate: null };
  const records = {
    events: [], logs: [], backups: [], mkdirs: [], configWrites: [], boundaryErrors: [], configReads: 0,
    runtimeConfigWrites: [], telemetryUrls: [], backgroundSubscriptions: [], handlers: new Map(), listeners: new Map(),
  };
  const started = [];
  const stopRequests = [];
  const healthChecks = [];
  const sockets = [];
  const timers = { startup: null, check: null, startupDelayMs: null, checkIntervalMs: null };
  const host = {
    sends: [], reloads: 0,
    webContents: {
      send: (channel, event) => { host.sends.push({ channel, event }); },
      reload: () => { host.reloads += 1; },
    },
  };
  let currentUrl = null;
  let requestInterceptor = null;

  const net = createNetSeam();
  const context = vm.createContext({
    console, URL, AbortController, performance,
    window: { location: new URL("app://openfic/"), setTimeout, clearTimeout },
    process: { platform: process.platform, env },
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
    fetch: async (url, options) => {
      if (url === "/runtime-config.json") {
        assert.equal(options?.cache, "no-store");
        records.configReads += 1;
        return { ok: true, json: async () => ({ backendBaseUrl: currentUrl }) };
      }
      const known = started.map((entry) => `${entry.handle.baseUrl}/api/v1/health/maintenance`);
      if (env.OPENFIC_DEV_BACKEND_URL) known.push(`${env.OPENFIC_DEV_BACKEND_URL}/api/v1/health/maintenance`);
      assert.ok(known.includes(url), `Unknown synthetic fetch: ${url}`);
      return { ok: true, json: async () => ({ status: "ok" }) };
    },
  });

  function deny(label) {
    records.boundaryErrors.push(label);
    throw new Error(`Forbidden desktop test boundary: ${label}`);
  }
  function synthetic(identifier, exports) {
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context, identifier });
  }
  const linkDependency = (specifier) => {
    const dependency = linked.get(specifier);
    if (!dependency) throw new Error(`Unknown desktop dependency: ${specifier}`);
    return dependency;
  };
  const linked = new Map();

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

  const portOf = (baseUrl) => Number(new URL(baseUrl).port);
  const processSeam = {
    startBackendProcess: (options) => {
      assert.ok(options.command === "uv" || options.command === openficCommand, `Unknown synthetic backend command: ${options.command}`);
      assert.equal(typeof options.port, "number");
      assert.equal(net.occupied.has(options.port), false, `Synthetic spawn on occupied port ${options.port}`);
      assert.ok([devDataDir, localDataDir].includes(options.dataDir), `Unknown synthetic backend dataDir: ${options.dataDir}`);
      if (options.command === "uv") {
        assert.deepEqual([...options.args.slice(0, 3)], ["run", "--directory", path.join(repoRoot, "backend")]);
        assert.ok(options.args.includes(String(options.port)), "Dev spawn must target the allocated port");
      } else {
        assert.deepEqual([...options.args], ["serve", "--host", "127.0.0.1", "--port", String(options.port)]);
      }
      net.occupied.add(options.port);
      const handle = {
        process: new EventEmitter(),
        baseUrl: `http://127.0.0.1:${options.port}`,
        logPath: `synthetic-backend-${options.port}.log`,
        shutdownToken: "synthetic-shutdown-token",
        logsClosed: Promise.resolve(),
      };
      started.push({ command: options.command, args: [...options.args], port: options.port, handle });
      return handle;
    },
    abortStartingBackendProcess: (handle) => { if (handle) net.occupied.delete(portOf(handle.baseUrl)); },
    forceStopBackendProcess: (handle) => { if (handle) net.occupied.delete(portOf(handle.baseUrl)); },
    stopBackendProcess: async (handle) => {
      if (!handle) return;
      stopRequests.push(portOf(handle.baseUrl));
      if (state.stopGate) await state.stopGate;
      if (state.stopError) throw state.stopError;
      net.occupied.delete(portOf(handle.baseUrl));
    },
  };
  const healthSeam = {
    throwIfAborted: (signal) => {
      if (!signal?.aborted) return;
      const error = new Error("连接已取消");
      error.name = "AbortError";
      throw error;
    },
    waitForBackend: async (url, options) => {
      const known = started.map((entry) => entry.handle.baseUrl);
      if (env.OPENFIC_DEV_BACKEND_URL) known.push(env.OPENFIC_DEV_BACKEND_URL);
      assert.ok(known.includes(url), `Unknown synthetic health url: ${url}`);
      if (options?.process) {
        const owner = started.find((entry) => entry.handle.process === options.process);
        assert.ok(owner, `Health probe without a spawned process: ${url}`);
        assert.equal(url, owner.handle.baseUrl, "Health probe must target the spawned process URL");
      }
      healthChecks.push(url);
      return { status: "healthy", version: VERSION };
    },
  };
  const loggingSeam = {
    appendLog: (category, message) => {
      assert.ok(typeof category === "string" && typeof message === "string");
      records.logs.push({ category, message });
    },
    setLogsDir: (dir) => { records.logs.push({ category: "logs-dir", message: String(dir) }); },
    exportLogs: () => deny("exportLogs"),
    createLogStream: () => deny("createLogStream"),
  };
  const modules = {
    "electron": synthetic("synthetic:electron", {
      app: {
        getPath: () => deny("app.getPath"),
        getVersion: () => VERSION,
        getAppPath: () => path.join(repoRoot, "desktop"),
        isPackaged: false,
        quit: () => deny("app.quit"),
      },
      dialog: {
        showErrorBox: () => deny("dialog.showErrorBox"),
        showOpenDialog: () => deny("dialog.showOpenDialog"),
        showSaveDialog: () => deny("dialog.showSaveDialog"),
      },
      Menu: { setApplicationMenu: () => deny("setApplicationMenu") },
      ipcMain: {
        handle: (channel, handler) => {
          assert.equal(records.handlers.has(channel), false, `Duplicate handler ${channel}`);
          records.handlers.set(channel, handler);
        },
        on: (channel, listener) => {
          assert.equal(records.listeners.has(channel), false, `Duplicate listener ${channel}`);
          records.listeners.set(channel, listener);
        },
      },
      session: { fromPartition: (partition) => ({ partition }) },
      shell: { openExternal: () => deny("shell.openExternal") },
      webContents: { getAllWebContents: () => [] },
      net: { fetch: () => deny("electron net.fetch") },
    }),
    "node:path": synthetic("synthetic:path", { default: path }),
    "node:net": synthetic("synthetic:net", net.module),
    "node:child_process": synthetic("synthetic:child-process", { spawn: () => deny("spawn") }),
    "node:crypto": synthetic("synthetic:crypto", { createHash: () => deny("createHash") }),
    "node:fs/promises": synthetic("synthetic:fs-promises", {
      // 运行时只允许两个已知路径：dev 数据目录的 mkdir，以及合成备份目录的 readdir。
      // 本套件不创建任何真实文件，因此 lstat/unlink 一律拒绝，未知路径也立即失败。
      mkdir: async (target, options) => {
        assert.equal(target, devDataDir, `Unknown synthetic mkdir target: ${target}`);
        assert.equal(options?.recursive, true, "Synthetic mkdir must be recursive");
        records.mkdirs.push({ target, recursive: true });
      },
      readdir: async (target, options) => {
        assert.equal(target, syntheticBackupDir, `Unknown synthetic readdir target: ${target}`);
        assert.equal(options, undefined, "Auto backup must scan the directory without extra options");
        return [];
      },
      lstat: () => deny("fs.lstat"),
      unlink: () => deny("fs.unlink"),
      readFile: () => deny("fs.readFile"),
      writeFile: () => deny("fs.writeFile"),
      rm: () => deny("fs.rm"),
      access: () => deny("fs.access"),
    }),
    "./protocol.js": synthetic("synthetic:protocol-local", {
      setRuntimeConfig: (runtimeConfig) => {
        assert.equal(typeof runtimeConfig.backendBaseUrl, "string");
        currentUrl = runtimeConfig.backendBaseUrl;
        records.runtimeConfigWrites.push(currentUrl);
      },
      registerAppScheme: () => deny("registerAppScheme"),
      handleAppProtocol: () => deny("handleAppProtocol"),
      ensureAppProtocolForPartition: () => deny("ensureAppProtocolForPartition"),
    }),
    "./config.js": synthetic("synthetic:config", {
      createDefaultConfig: () => ({ activeInstanceId: null, instances: [] }),
      readDesktopConfig: async () => config,
      writeDesktopConfig: async (next) => { records.configWrites.push(next); },
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
      getDefaultInstallDir: () => path.join(repoRoot, "tmp", "synthetic-install"),
      resolveRuntimeDir: (installDir) => path.join(installDir ?? path.join(repoRoot, "tmp", "synthetic-install"), "Runtime"),
      ensurePortablePython: async () => ({ pythonPath: "synthetic-python.exe", rootDir: "synthetic-python-root", wasReplaced: false }),
      inspectPortablePython: () => deny("inspectPortablePython"),
      resolveVenvPythonPath: (runtimeDir) => path.join(runtimeDir, "venv", "Scripts", "python.exe"),
      describeDownloadProgress: () => deny("describeDownloadProgress"),
    }),
    "./runtime/tar-extract.js": synthetic("synthetic:tar-extract", { INSTANCE_DATA_ENTRIES: [] }),
    "../process.js": synthetic("synthetic:process", processSeam),
    "./process.js": synthetic("synthetic:process", processSeam),
    "../health.js": synthetic("synthetic:health", healthSeam),
    "./health.js": synthetic("synthetic:health", healthSeam),
    "../logging.js": synthetic("synthetic:logging", loggingSeam),
    "./logging.js": synthetic("synthetic:logging", loggingSeam),
    "../proxy.js": synthetic("synthetic:proxy", {
      configureDefaultSystemProxy: async () => {},
      getSystemProxyEnvironment: async (url) => {
        assert.equal(url, "https://pypi.org/");
        return {};
      },
    }),
    "./data-location.js": synthetic("synthetic:data-location", {
      getDefaultDataDir: () => path.join(repoRoot, "tmp", "synthetic-default-data"),
      normalizeDataDir: (value) => (value ? path.resolve(value) : null),
      resolveDataDir: (instance) => instance.dataDir ?? path.join(repoRoot, "tmp", "synthetic-default-data"),
    }),
    "./data-manager.js": synthetic("synthetic:data-manager", {
      getDataOperationOptions: async (dataDir, runtimeDir) => {
        assert.equal(dataDir, localDataDir, "Data options must target the configured synthetic data dir");
        assert.equal(runtimeDir, localRuntimeDir, "Data options must target the configured synthetic runtime dir");
        records.events.push("options");
        return { backup: {}, restore: {} };
      },
      backupDataDir: async (dataDir, targetPath, onLog, onPhase) => {
        assert.equal(typeof onLog, "function");
        assert.equal(typeof onPhase, "function");
        assert.equal(dataDir, localDataDir, "Backup must read the configured synthetic data dir");
        assert.equal(path.dirname(targetPath), syntheticBackupDir, "Backup must land inside the synthetic backup dir");
        assert.match(path.basename(targetPath), /^OpenFix-backup-\d{8}-\d{6}\.tar\.gz$/);
        records.events.push("backup");
        records.backups.push({ dataDir, targetPath });
      },
      arePathsEqual: () => deny("arePathsEqual"),
      doPathsOverlap: () => deny("doPathsOverlap"),
      // 本套件保持严格合成边界，不触碰真实文件系统：只确认备份目录准入被调用且拿到两个路径，
      // 重叠判定本身由 data-manager 与 ipc 套件用真实目录覆盖。
      assertBackupDirOutsideDataDir: async (dataDir, backupDir) => {
        assert.equal(typeof dataDir, "string", "The backup target guard needs a data directory");
        assert.equal(typeof backupDir, "string", "The backup target guard needs a backup directory");
      },
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
        fail: (error) => emit({ status: "failed", message: String(error?.message ?? error) }),
      }),
      getStartupProgress: () => deny("getStartupProgress"),
    }),
    "./telemetry.js": synthetic("synthetic:telemetry", {
      syncTelemetryEnabled: async (url) => { records.telemetryUrls.push(url); },
      captureException: () => deny("captureException"),
      captureExceptionImmediate: () => deny("captureExceptionImmediate"),
      startErrorTelemetry: () => deny("startErrorTelemetry"),
    }),
    "../shared/ipc.js": sharedIpcModule,
    "../shared/config.js": sharedConfigModule,
    "../../shared/config.js": sharedConfigModule,
  };
  for (const [specifier, module] of Object.entries(modules)) linked.set(specifier, module);

  const commandsModule = new vm.SourceTextModule(commandsCode, {
    context, identifier: path.join(distMainDir, "runtime/openfic-commands.js"),
    importModuleDynamically: () => deny("commands dynamic import"),
  });
  await commandsModule.link(denyLink);
  await commandsModule.evaluate();
  linked.set("./openfic-commands.js", commandsModule);

  const portsModule = new vm.SourceTextModule(portsCode, {
    context, identifier: path.join(distMainDir, "ports.js"),
    importModuleDynamically: () => deny("ports dynamic import"),
  });
  await portsModule.link(linkDependency);
  await portsModule.evaluate();
  linked.set("../ports.js", portsModule);

  const openficModule = new vm.SourceTextModule(openficCode, {
    context, identifier: path.join(distMainDir, "runtime/openfic.js"),
    importModuleDynamically: () => deny("openfic dynamic import"),
  });
  await openficModule.link(linkDependency);
  await openficModule.evaluate();
  // The runtime install check is outside the continuity boundary; only the actual local start is bound.
  linked.set("./runtime/openfic.js", synthetic("synthetic:openfic-seam", {
    startLocalOpenFicBackend: openficModule.namespace.startLocalOpenFicBackend,
    ensureOpenFicRuntime: async () => ({ uvPath: "synthetic-uv.exe", venvPythonPath: "synthetic-python.exe" }),
  }));

  const devBackendModule = new vm.SourceTextModule(devBackendCode, {
    context, identifier: path.join(distMainDir, "runtime/dev-backend.js"),
    importModuleDynamically: () => deny("dev backend dynamic import"),
  });
  await devBackendModule.link(linkDependency);
  await devBackendModule.evaluate();
  linked.set("./runtime/dev-backend.js", devBackendModule);

  const autoBackupModule = new vm.SourceTextModule(autoBackupCode, {
    context, identifier: path.join(distMainDir, "auto-backup.js"),
    importModuleDynamically: () => deny("auto backup dynamic import"),
  });
  await autoBackupModule.link(linkDependency);
  await autoBackupModule.evaluate();
  linked.set("./auto-backup.js", autoBackupModule);

  const mainModule = new vm.SourceTextModule(await extractMainSnippet(ts), {
    context, identifier: "main-runtime-continuity.ts",
    importModuleDynamically: () => deny("main dynamic import"),
  });
  await mainModule.link(linkDependency);
  await mainModule.evaluate();
  mainModule.namespace.seedWindow(host);

  const ipcModule = new vm.SourceTextModule(ipcCode, {
    context, identifier: path.join(distMainDir, "ipc.js"),
    importModuleDynamically: () => deny("ipc dynamic import"),
  });
  await ipcModule.link(linkDependency);
  await ipcModule.evaluate();
  ipcModule.namespace.registerIpc({
    shellWindow: () => host,
    setBackend: mainModule.namespace.setBackend,
    setBackendBaseUrl: mainModule.namespace.setBackendBaseUrl,
    setLogsDir: loggingSeam.setLogsDir,
    beginStartupOperation: mainModule.namespace.beginStartupOperation,
    finishStartupOperation: mainModule.namespace.finishStartupOperation,
    initializeApp: () => deny("context.initializeApp"),
    cancelStartup: () => deny("cancelStartup"),
    switchInstance: () => deny("switchInstance"),
    pingInstance: () => deny("pingInstance"),
    onConfigSaved: () => deny("onConfigSaved"),
    isBackendRunning: mainModule.namespace.isBackendRunning,
    stopActiveBackend: mainModule.namespace.stopActiveBackend,
  });
  assert.equal(typeof timers.check, "function", "Scheduler interval must be registered");

  const sourceModule = async (relativePath) => {
    const code = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
    return new vm.SourceTextModule(
      ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText,
      { context, identifier: relativePath, initializeImportMeta: (meta) => { meta.env = { DEV: false }; } },
    );
  };
  const runtimeConfigModule = await sourceModule("frontend/src/lib/runtime-config.ts");
  await runtimeConfigModule.link(() => deny("runtime config import"));
  await runtimeConfigModule.evaluate();
  const apiModule = await sourceModule("frontend/src/lib/api-client.ts");
  await apiModule.link((specifier) => {
    if (specifier === "./runtime-config") return runtimeConfigModule;
    // 真实 api-client 会再导出后台订阅入口；这里只提供一个记录即拒绝的严格合成模块，
    // 链接过程不得执行任何后台订阅。
    if (specifier === "./background-socket") return synthetic("synthetic:background-socket", {
      subscribeBackgroundEvents: () => { records.backgroundSubscriptions.push("events"); return deny("subscribeBackgroundEvents"); },
      subscribeBackgroundProjection: () => { records.backgroundSubscriptions.push("projection"); return deny("subscribeBackgroundProjection"); },
    });
    if (specifier === "axios") return synthetic("synthetic:axios", {
      default: { create: () => ({ interceptors: { request: { use: (callback) => { requestInterceptor = callback; } }, response: { use: () => {} } } }) },
    });
    throw new Error(`Unknown api-client dependency: ${specifier}`);
  });
  await apiModule.evaluate();
  const socketModule = await sourceModule("frontend/src/lib/socket-client.ts");
  await socketModule.link((specifier) => {
    if (specifier === "./runtime-config") return runtimeConfigModule;
    if (specifier === "./api-client") return apiModule;
    if (specifier === "../i18n") return synthetic("synthetic:i18n", { default: { t: () => "" } });
    if (specifier === "./desktop-appearance-bridge") return synthetic("synthetic:appearance-bridge", { publishSocketDiagnostic: () => deny("publishSocketDiagnostic") });
    if (specifier === "socket.io-client") return synthetic("synthetic:socket.io-client", {
      io: (url) => {
        const created = { url, connected: false, active: false, on: () => {}, io: { on: () => {} }, disconnect: () => deny("unexpected socket replacement") };
        sockets.push(created);
        return created;
      },
    });
    throw new Error(`Unknown socket-client dependency: ${specifier}`);
  });
  await socketModule.evaluate();

  return {
    state, records, timers, host, net, started, stopRequests, healthChecks, sockets, IpcChannels,
    main: mainModule.namespace,
    ports: portsModule.namespace,
    config: runtimeConfigModule.namespace,
    api: apiModule.namespace,
    socket: socketModule.namespace,
    getCurrentUrl: () => currentUrl,
    getRequestInterceptor: () => requestInterceptor,
  };
}

// VM realm values are normalized to plain host objects before comparison.
const plain = (value) => JSON.parse(JSON.stringify(value));
const dataProgress = (harness) => harness.host.sends
  .filter(({ channel }) => channel === harness.IpcChannels.dataProgress)
  .map(({ event }) => plain(event));
// 终态事件只断言操作生命周期；automatic 标记与失败原因由 auto-backup-ipc 的用例覆盖。
const terminal = (harness) => dataProgress(harness)
  .filter((event) => event.phase === "done" || event.phase === "error")
  .map(({ operation, phase, progress }) => ({ operation, phase, progress }));
const assertClean = (harness) => {
  assert.deepEqual(harness.records.boundaryErrors, [], "Forbidden boundaries must fail the run");
  assert.deepEqual(harness.records.backgroundSubscriptions, [], "Background subscriptions must never run");
};

test("a resumed local backend keeps the captured port live for the renderer URL seams", async () => {
  const harness = await createHarness({ config: makeConfig() });

  const first = await harness.main.initializeApp();
  assert.equal(first.status, "ready");
  const url = harness.getCurrentUrl();
  assert.equal(url, `http://127.0.0.1:${harness.net.pool[0]}`);
  assert.deepEqual(harness.net.requested, [0], "An absent requested port must use the default allocation");
  assert.equal(harness.started.length, 1);

  await harness.config.loadRuntimeConfig();
  const originalSocket = harness.socket.getSocket();
  assert.equal(harness.records.configReads, 1);

  await harness.timers.check();

  assert.deepEqual(harness.records.events, ["options", "backup"]);
  assert.deepEqual(harness.stopRequests, [harness.net.pool[0]]);
  assert.deepEqual(harness.net.requested, [0, harness.net.pool[0]], "The resume must request the captured port only");
  assert.equal(harness.started.length, 2, "The resume closure must run exactly one backend");
  assert.equal(harness.started[1].port, harness.started[0].port);
  assert.equal(harness.getCurrentUrl(), url);
  assert.deepEqual(harness.records.runtimeConfigWrites, [url, url]);
  assert.deepEqual(harness.records.telemetryUrls, [url, url]);
  assert.equal(harness.records.configWrites.length, 0, "A resume must not rewrite the desktop config");
  assert.ok(harness.main.readBackend(), "The resumed backend must be registered as running");

  assert.equal(harness.records.configReads, 1, "The renderer must not be forced to re-read a reloaded config");
  assert.equal(harness.config.getRuntimeConfig().backendBaseUrl, url);
  assert.equal(harness.api.getApiBaseUrl(), `${url}/api/v1`);
  assert.equal(harness.getRequestInterceptor()({ url: "/chapters/synthetic/save" }).baseURL, `${url}/api/v1`);
  assert.equal(harness.socket.getSocket(), originalSocket);
  assert.equal(harness.sockets.length, 1);
  assert.equal(originalSocket.url, url);
  assert.equal(harness.host.reloads, 0, "The editor host must not be reloaded");
  assert.ok(harness.host.sends.some(({ channel }) => channel === harness.IpcChannels.startupProgress));
  assert.deepEqual(terminal(harness), [{ operation: "backup", phase: "done", progress: 1 }]);
  assertClean(harness);
});

test("a manual stop returns one reusable closure and an empty stop returns none", async () => {
  const harness = await createHarness({ config: makeConfig() });
  await harness.main.initializeApp();
  const url = harness.getCurrentUrl();
  const port = harness.started[0].port;

  const resume = await harness.main.stopActiveBackend();
  assert.equal(typeof resume, "function");
  assert.equal(harness.main.isBackendRunning(), false);
  assert.equal(harness.started.length, 1, "A manual stop must not resume on its own");
  assert.equal(harness.getCurrentUrl(), url);

  assert.equal(await harness.main.stopActiveBackend(), null, "No running handle must publish no closure");

  const result = await resume();
  assert.equal(result.status, "ready");
  assert.equal(harness.started.length, 2);
  assert.equal(harness.started[1].port, port);
  assert.deepEqual(harness.net.requested, [0, port]);
  assert.equal(harness.getCurrentUrl(), url);
  assertClean(harness);
});

test("an owned dev backend resumes on its captured port while default allocation stays free", async () => {
  const harness = await createHarness({ config: makeConfig(), devMode: true });
  const first = await harness.main.initializeApp();
  assert.equal(first.status, "ready");
  assert.equal(harness.main.readActiveInstanceId(), DEV_INSTANCE_ID);
  const url = harness.getCurrentUrl();
  const port = harness.started[0].port;
  assert.equal(harness.started[0].command, "uv");
  assert.deepEqual(harness.net.requested, [0]);
  assert.ok(harness.records.mkdirs.length > 0, "The dev data dir must be prepared through the synthetic fs seam");

  const defaultPort = await harness.ports.findFreePort();
  assert.equal(defaultPort, harness.net.pool[1], "An absent requested port must still allocate a free port");
  assert.deepEqual(harness.net.requested, [0, 0]);

  await harness.timers.check();

  assert.equal(harness.started.length, 2);
  assert.equal(harness.started[1].port, port, "The owned dev backend must resume on its captured port");
  assert.deepEqual(harness.net.requested, [0, 0, port]);
  assert.equal(harness.getCurrentUrl(), url);
  assert.deepEqual(terminal(harness), [{ operation: "backup", phase: "done", progress: 1 }]);
  assertClean(harness);
});

test("external dev mode never spawns a local backend and is not auto-resumed", async () => {
  const externalUrl = "http://127.0.0.1:39999";
  const harness = await createHarness({ config: makeConfig(), devMode: true, devBackendUrl: externalUrl });
  const first = await harness.main.initializeApp();
  assert.equal(first.status, "ready");
  assert.equal(harness.started.length, 0, "External dev mode must not spawn a local process");
  assert.equal(harness.getCurrentUrl(), externalUrl);
  assert.equal(await harness.main.stopActiveBackend(), null, "No owned handle must publish no resume closure");

  await harness.timers.check();

  assert.deepEqual(harness.records.events, ["options", "backup"]);
  assert.equal(harness.stopRequests.length, 0, "Nothing may be stopped without an owned handle");
  assert.equal(harness.started.length, 0, "Nothing may be resumed without an owned handle");
  assert.deepEqual(terminal(harness), [{ operation: "backup", phase: "done", progress: 1 }]);
  assertClean(harness);
});

test("a requested port conflict fails before spawn without a silent fallback", async () => {
  const harness = await createHarness({ config: makeConfig() });
  const [firstPort, secondPort] = harness.net.pool;
  harness.net.occupied.add(secondPort);

  await assert.rejects(harness.ports.findFreePort(secondPort), (error) => /EADDRINUSE/.test(error.message));
  assert.deepEqual(harness.net.requested, [secondPort]);

  const result = await harness.main.initializeApp(secondPort);
  assert.equal(result.status, "needs-setup");
  assert.match(result.message, /EADDRINUSE/);
  assert.equal(harness.started.length, 0, "A conflicting port must never reach the subprocess seam");
  assert.deepEqual(harness.net.requested, [secondPort, secondPort], "No fallback port may be probed");

  const freePort = await harness.ports.findFreePort();
  assert.equal(freePort, firstPort);
  assert.deepEqual(harness.net.requested, [secondPort, secondPort, 0]);
  assertClean(harness);
});

test("a rejected stop keeps the live handle so the next tick fails safely instead of archiving", async () => {
  const harness = await createHarness({ config: makeConfig() });
  await harness.main.initializeApp();
  const url = harness.getCurrentUrl();
  const originalHandle = harness.main.readBackend();
  const port = harness.started[0].port;
  harness.state.stopError = new Error("synthetic stop failure");

  await harness.timers.check();

  assert.deepEqual(harness.records.events, ["options"], "A rejected stop must skip the archive");
  assert.equal(harness.records.backups.length, 0);
  assert.deepEqual(harness.stopRequests, [port]);
  assert.equal(harness.started.length, 1, "A rejected stop must not spawn a replacement");
  assert.equal(harness.main.readBackend(), originalHandle, "The still-live process handle must stay known");
  assert.equal(harness.main.isBackendRunning(), true);
  assert.equal(harness.getCurrentUrl(), url);

  // 第二次 tick：停止仍然失败，运行守卫必须已释放并再次安全失败，不能给仍在写入的数据库归档。
  await harness.timers.check();

  assert.deepEqual(harness.records.events, ["options", "options"], "The second tick must also skip the archive");
  assert.equal(harness.records.backups.length, 0);
  assert.deepEqual(harness.stopRequests, [port, port], "Both ticks must try to stop the known process");
  assert.equal(harness.started.length, 1, "No tick may spawn a replacement or a resume");
  assert.equal(harness.main.readBackend(), originalHandle);
  assert.equal(harness.getCurrentUrl(), url);
  assert.deepEqual(terminal(harness), [
    { operation: "backup", phase: "error", progress: 0 },
    { operation: "backup", phase: "error", progress: 0 },
  ]);
  assert.ok(!dataProgress(harness).some((event) => event.phase === "done"), "No tick may report a false done");
  assert.ok(harness.records.logs.some(({ message }) => message.includes("synthetic stop failure")));
  assert.ok(harness.records.logs.some(({ message }) => message.includes("自动备份失败")));
  assertClean(harness);
});

test("an older rejected stop never clobbers a newer backend handle", async () => {
  const harness = await createHarness({ config: makeConfig() });
  await harness.main.initializeApp();
  const olderPort = harness.started[0].port;

  let rejectStop;
  harness.state.stopGate = new Promise((_, reject) => { rejectStop = reject; });
  const stopping = harness.main.stopActiveBackend();
  assert.equal(harness.main.isBackendRunning(), false, "The slot is cleared while the stop is pending");

  const newerHandle = {
    process: new EventEmitter(),
    baseUrl: `http://127.0.0.1:${harness.net.pool[1]}`,
    logPath: "synthetic-newer-backend.log",
    shutdownToken: "synthetic-shutdown-token",
    logsClosed: Promise.resolve(),
  };
  harness.main.setBackend(newerHandle);
  assert.equal(harness.main.readBackend(), newerHandle);

  rejectStop(new Error("synthetic older stop failure"));
  await assert.rejects(stopping, (error) => error.message === "synthetic older stop failure");

  assert.equal(harness.main.readBackend(), newerHandle, "The older handle must not replace the newer one");
  assert.equal(harness.main.isBackendRunning(), true);
  assert.deepEqual(harness.stopRequests, [olderPort], "Only the older handle may be stopped");
  assert.equal(harness.started.length, 1, "A rejected stop must not spawn anything");
  assertClean(harness);
});
