import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  createSmokeInstallation,
  OPENFIX_INSTALL_GUID,
  readOpenFixRegistrations,
  runOwnedUninstaller,
} from "../scripts/packaged-smoke-installation.mjs";

const installDir = String.raw`C:\Temp\owned smoke\install`;
const uninstaller = path.win32.join(installDir, "Uninstall OpenFix.exe");
function ownedEntries(dir = installDir) {
  const exe = path.win32.join(dir, "Uninstall OpenFix.exe");
  return [
    { hive: "HKCU", view: "64", kind: "install", values: { InstallLocation: dir } },
    { hive: "HKCU", view: "64", kind: "uninstall", values: {
      DisplayName: "OpenFix 0.11.1", UninstallString: `"${exe}" /currentuser`,
      QuietUninstallString: `"${exe}" /currentuser /S`,
    } },
  ];
}

function fixture() {
  const state = { entries: [], directory: false, file: true, exitCode: 0, calls: [] };
  const lifecycle = createSmokeInstallation({
    installDir, platform: "win32", queryRegistry: () => structuredClone(state.entries),
    directoryExists: () => state.directory, regularFile: () => state.file,
    runUninstaller: async (...args) => {
      state.calls.push(args);
      if (state.exitCode === 0 && !state.retainRegistry) state.entries = [];
      return state.exitCode;
    },
  });
  return { state, lifecycle, install() {
    lifecycle.begin(); state.directory = true; state.entries = ownedEntries();
    lifecycle.verifyInstalled();
  } };
}

test("registry identity matches the configured appId and pinned NSIS builder", () => {
  const config = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  const appId = config.match(/^appId:\s*(\S+)\s*$/m)?.[1];
  assert.equal(appId, "com.openfix.app");
  assert.doesNotMatch(config, /^\s+guid:/m);
  const namespace = Buffer.from("50e065bc313411e69bab38c9862bdaf3", "hex");
  const digest = createHash("sha1").update(namespace).update(appId).digest().subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50; digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  assert.equal(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`, OPENFIX_INSTALL_GUID);
});

for (const [name, entries] of [
  ["live user installation", ownedEntries(String.raw`C:\Apps\OpenFix`)],
  ["old smoke registration", ownedEntries(String.raw`C:\Temp\old smoke\install`)],
  ["machine installation", ownedEntries().map((entry) => ({ ...entry, hive: "HKLM" }))],
  ["partial registration", [ownedEntries()[0]]],
]) {
  test(`preflight rejects ${name} without running its uninstaller`, async () => {
    const { state, lifecycle } = fixture(); state.entries = entries;
    assert.throws(() => lifecycle.begin(), /already registered/);
    await lifecycle.cleanup(); assert.deepEqual(state.calls, []);
    assert.deepEqual(state.entries, entries);
  });
}

test("preflight errors are failures and never authorize cleanup of an installation", async () => {
  let calls = 0;
  const lifecycle = createSmokeInstallation({ installDir, platform: "win32",
    queryRegistry: () => { throw new Error("access denied"); }, runUninstaller: () => { calls++; } });
  assert.throws(() => lifecycle.begin(), /access denied/);
  await lifecycle.cleanup(); assert.equal(calls, 0);
});

test("fresh Windows and directory checks are required", () => {
  const { state, lifecycle } = fixture(); state.directory = true;
  assert.throws(() => lifecycle.begin(), /must be fresh/);
  assert.throws(() => createSmokeInstallation({ installDir, platform: "linux" }).begin(), /requires Windows/);
});

test("owned install is uninstalled before permission to remove its workspace", async () => {
  const { state, lifecycle, install } = fixture(); install();
  await lifecycle.cleanup(); assert.deepEqual(state.calls, [[uninstaller, installDir]]);
  assert.deepEqual(state.entries, []);
  assert.throws(() => lifecycle.begin(), /already begun/);
});

test("ownership accepts Windows case, separators and trailing slash equality", async () => {
  const { state, lifecycle } = fixture(); lifecycle.begin(); state.directory = true;
  state.entries = ownedEntries("c:/temp/OWNED SMOKE/install/");
  lifecycle.verifyInstalled(); await lifecycle.cleanup(); assert.equal(state.calls.length, 1);
});

for (const [name, change] of [
  ["sibling path", (state) => { state.entries = ownedEntries(installDir + "-foreign"); }],
  ["changed machine registration", (state) => { state.entries[0].hive = "HKLM"; }],
  ["foreign uninstaller command", (state) => { state.entries[1].values.UninstallString = '"C:\\Apps\\OpenFix\\Uninstall OpenFix.exe" /currentuser'; }],
  ["extra command flags", (state) => { state.entries[1].values.QuietUninstallString += " --delete-app-data"; }],
  ["different product name", (state) => { state.entries[1].values.DisplayName = "OpenFic"; }],
  ["missing uninstaller", (state) => { state.file = false; }],
]) {
  test(`cleanup preserves workspace on ${name}`, async () => {
    const { state, lifecycle, install } = fixture(); install(); change(state);
    await assert.rejects(lifecycle.cleanup(), /preserve/);
    assert.equal(state.calls.length, 0); assert.equal(state.directory, true);
  });
}

test("incomplete installer does not count as a verified owned installation", () => {
  const { lifecycle } = fixture();
  assert.throws(() => lifecycle.verifyInstalled(), /not begun/);
  lifecycle.begin(); assert.throws(() => lifecycle.verifyInstalled(), /did not create/);
});

test("failed installer with no directory or registration needs no uninstaller", async () => {
  const { state, lifecycle } = fixture(); lifecycle.begin(); await lifecycle.cleanup();
  assert.deepEqual(state.calls, []);
});

test("nonzero uninstaller exit preserves registrations and the workspace", async () => {
  const { state, lifecycle, install } = fixture(); install(); state.exitCode = 2;
  await assert.rejects(lifecycle.cleanup(), /failed \(2\)/);
  assert.equal(state.entries.length, 2); assert.equal(state.directory, true);
});

test("an uninstaller exit of zero cannot hide leftover registry entries", async () => {
  const { state, lifecycle, install } = fixture(); install(); state.retainRegistry = true;
  await assert.rejects(lifecycle.cleanup(), /entries remain/);
  assert.equal(state.directory, true);
});

test("query failure during cleanup preserves workspace without executing anything", async () => {
  let failing = false; let calls = 0;
  const lifecycle = createSmokeInstallation({ installDir, platform: "win32", directoryExists: () => false,
    queryRegistry: () => { if (failing) throw new Error("query failed"); return []; },
    runUninstaller: () => { calls++; } });
  lifecycle.begin(); failing = true;
  await assert.rejects(lifecycle.cleanup(), /query failed/); assert.equal(calls, 0);
});

test("owned uninstaller uses native argv and waits for its actual process exit", async () => {
  const child = new EventEmitter();
  const result = runOwnedUninstaller(uninstaller, installDir, (file, args, options) => {
    assert.equal(file, uninstaller);
    assert.deepEqual(args, ["/S", "/currentuser", `_?=${installDir}`]);
    assert.equal(options.windowsHide, true); assert.equal(options.windowsVerbatimArguments, true);
    assert.equal(options.shell, undefined); return child;
  });
  child.emit("exit", 0); assert.equal(await result, 0);
});

test("uninstaller spawn error is reported", async () => {
  const child = new EventEmitter();
  const result = runOwnedUninstaller(uninstaller, installDir, () => child);
  child.emit("error", new Error("ENOENT")); await assert.rejects(result, /ENOENT/);
});

function registryFake(registered = false) {
  const fullHives = { HKCU: "HKEY_CURRENT_USER", HKLM: "HKEY_LOCAL_MACHINE" };
  const calls = [];
  const run = (file, args, options) => {
    calls.push(args);
    assert.equal(file, "reg.exe"); assert.equal(options.windowsHide, true);
    assert.equal(args[0], "query"); assert.match(args[2], /^\/reg:(32|64)$/);
    const key = args[1].replace(/^HKCU/, fullHives.HKCU).replace(/^HKLM/, fullHives.HKLM);
    const installKey = `${fullHives.HKCU}\\Software\\${OPENFIX_INSTALL_GUID}`;
    const uninstallKey = `${fullHives.HKCU}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${OPENFIX_INSTALL_GUID}`;
    if (key === installKey || key === uninstallKey) {
      return { status: 0, stdout: `${key}\r\n    InstallLocation    REG_SZ    ${installDir}\r\n` };
    }
    const children = key.endsWith("\\Software") ? ["Microsoft", ...(registered && key.startsWith(fullHives.HKCU) ? [OPENFIX_INSTALL_GUID, OPENFIX_INSTALL_GUID + "-foreign"] : [])]
      : key.endsWith("\\Microsoft") ? ["Windows"] : key.endsWith("\\Windows") ? ["CurrentVersion"]
        : key.endsWith("\\CurrentVersion") ? ["Uninstall"]
          : registered && key.startsWith(fullHives.HKCU) ? [OPENFIX_INSTALL_GUID] : [];
    return { status: 0, stdout: [key, ...children.map((child) => `${key}\\${child}`)].join("\r\n") };
  };
  return { run, calls };
}

test("registry reader checks both hives/views and returns only exact OpenFix keys", () => {
  const { run, calls } = registryFake(true);
  const entries = readOpenFixRegistrations(run);
  assert.equal(entries.length, 4);
  assert.equal(entries.filter((entry) => entry.kind === "install").length, 2);
  assert.ok(entries.every((entry) => entry.hive === "HKCU" && entry.values.InstallLocation === installDir));
  for (const hive of ["HKCU", "HKLM"]) for (const view of ["32", "64"]) {
    assert.ok(calls.some((args) => args[1].startsWith(hive + "\\") && args[2] === `/reg:${view}`));
  }
});

test("registry reader recognizes absent parent keys on a fresh account", () => {
  assert.deepEqual(readOpenFixRegistrations(() => ({ status: 0, stdout: "HKEY_CURRENT_USER\\Software\r\n" })), []);
});

for (const failure of [{ status: 1, stdout: "" }, { status: null, error: new Error("ENOENT") }]) {
  test(`registry query failure ${failure.status} is fail closed`, () => {
    assert.throws(() => readOpenFixRegistrations(() => failure), /Cannot verify/);
  });
}

test("an existing child that cannot be queried is a failure, never absence", () => {
  const { run } = registryFake(true);
  assert.throws(() => readOpenFixRegistrations((file, args, options) =>
    args[1].endsWith(OPENFIX_INSTALL_GUID) ? { status: 1, stdout: "" } : run(file, args, options)), /Cannot verify/);
});

test("harness honors keep/process-stop before uninstall and preserves workspace on failure", () => {
  const source = readFileSync(new URL("../scripts/packaged-smoke.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function cleanupSmokeWorkspace");
  const cleanup = source.slice(start, source.indexOf("async function finalizeSmoke", start));
  assert.ok(cleanup.indexOf("if (keepProfile || !appStopped)") < cleanup.indexOf("smokeInstallation.cleanup()"));
  assert.ok(cleanup.indexOf("smokeInstallation.cleanup()") < cleanup.indexOf("await removeWorkspace()"));
  assert.match(cleanup, /catch \(error\)[\s\S]*?check\([\s\S]*?false[\s\S]*?return;/);
  assert.ok(source.indexOf("smokeInstallation.begin()") < source.indexOf("const installer = spawn("));
  assert.ok(source.indexOf("smokeInstallation.verifyInstalled()") < source.indexOf("const installedExe ="));
});
