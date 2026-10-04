// A missing architecture-specific release manifest is an update check failure,
// never evidence that the installed application is current.
// Run after build:main with node --experimental-vm-modules --test.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const updaterDistPath = path.join(repoRoot, "desktop/dist/main/updater.js");

async function loadUpdater(checkError = null) {
  assert.equal(typeof vm.SourceTextModule, "function", "Use --experimental-vm-modules");
  const code = await fs.readFile(updaterDistPath, "utf8");
  const context = vm.createContext({ process: { platform: "win32", arch: "x64" } });
  const listeners = new Map();
  const autoUpdater = {
    channel: "latest",
    on(event, listener) { listeners.set(event, listener); },
    async checkForUpdates() {
      if (checkError) throw checkError;
      listeners.get("update-not-available")?.();
    },
  };
  const synthetic = (identifier, exports) => new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    },
    { context, identifier },
  );
  const dependencies = {
    electron: synthetic("synthetic:electron", {
      app: { isPackaged: true, getPath: () => "C:/OpenFix/OpenFix.exe" },
      shell: { openExternal: async () => {} },
    }),
    "node:fs": synthetic("synthetic:fs", { existsSync: () => false }),
    "node:path": synthetic("synthetic:path", { default: path }),
    "electron-updater": synthetic("synthetic:electron-updater", {
      default: { autoUpdater },
      CancellationToken: class {},
      NsisUpdater: class {},
    }),
    "../shared/ipc.js": synthetic("synthetic:ipc", {
      IpcChannels: { updateState: "update:state" },
    }),
    "./update-support.js": synthetic("synthetic:update-support", {
      getUpdateArchitectureName: () => "x86_64",
      isAutoUpdateSupported: () => true,
    }),
    "./proxy.js": synthetic("synthetic:proxy", {
      configureSystemProxy: async () => {},
    }),
  };
  const module = new vm.SourceTextModule(code, {
    context,
    identifier: updaterDistPath,
    importModuleDynamically: () => { throw new Error("Forbidden dynamic import"); },
  });
  await module.link((specifier) => {
    const dependency = dependencies[specifier];
    if (!dependency) throw new Error(`Unknown updater dependency: ${specifier}`);
    return dependency;
  });
  await module.evaluate();
  return { updater: module.namespace, autoUpdater };
}

test("a missing architecture-specific update manifest is reported as an error", async () => {
  const { updater } = await loadUpdater(
    new Error("HttpError: 404 Not Found: latest-win-x86_64.yml"),
  );
  const window = { webContents: { send() {} } };

  await updater.initializeUpdater(window);
  await updater.checkForUpdates();

  assert.equal(updater.getUpdateState().status, "error");
  assert.match(updater.getUpdateState().message, /404/);
});

test("a successful check with no newer release remains not-available", async () => {
  const { updater } = await loadUpdater();
  const window = { webContents: { send() {} } };

  await updater.initializeUpdater(window);
  await updater.checkForUpdates();

  assert.equal(updater.getUpdateState().status, "not-available");
});
