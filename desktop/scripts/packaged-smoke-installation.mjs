import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

// electron-builder 26.15.6 derives this GUID from com.openfix.app. The regression
// test binds it to the actual appId and the builder's UUID namespace.
export const OPENFIX_INSTALL_GUID = "c8cf4b5c-b7d8-59de-9650-59f6b798ee28";
const uninstallParent = String.raw`Software\Microsoft\Windows\CurrentVersion\Uninstall`;
const hives = { HKCU: "HKEY_CURRENT_USER", HKLM: "HKEY_LOCAL_MACHINE" };
const registryKinds = [
  { kind: "install", parent: "Software" },
  { kind: "uninstall", parent: uninstallParent },
];

function normalizedRegistryKey(value) {
  return value.trim().replace(/^HKCU\\/i, "HKEY_CURRENT_USER\\")
    .replace(/^HKLM\\/i, "HKEY_LOCAL_MACHINE\\").toLowerCase();
}

function checkedQuery(run, key, view) {
  const result = run("reg.exe", ["query", key, `/reg:${view}`], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot verify OpenFix registry state (${key}, ${view}-bit)`);
  }
  return result.stdout;
}

/** Enumerate parents first: reg.exe uses the same exit code for absent keys and
 * access failures. An unreadable parent must never be treated as a fresh install.
 * Only the exact OpenFix keys and their values leave this function.
 */
export function readOpenFixRegistrations(run = spawnSync) {
  const entries = [];
  const listings = new Map();
  const query = (key, view) => {
    const cacheKey = `${view}:${key}`;
    if (!listings.has(cacheKey)) listings.set(cacheKey, checkedQuery(run, key, view));
    return listings.get(cacheKey);
  };
  const containsKey = (listing, key) => listing.split(/\r?\n/)
    .some((line) => /^HKEY_/i.test(line.trim())
      && normalizedRegistryKey(line) === normalizedRegistryKey(key));
  for (const hive of Object.keys(hives)) {
    for (const view of ["64", "32"]) {
      for (const { kind, parent } of registryKinds) {
        const parentKey = `${hive}\\${parent}`;
        const key = `${parentKey}\\${OPENFIX_INSTALL_GUID}`;
        let current = `${hive}\\Software`;
        let listing = query(current, view);
        // An entirely missing Uninstall parent is legitimate on a fresh account.
        // Walk existing ancestors so missing keys never depend on localized errors.
        for (const segment of parent.split("\\").slice(1)) {
          current += `\\${segment}`;
          if (!containsKey(listing, current)) { listing = ""; break; }
          listing = query(current, view);
        }
        if (!containsKey(listing, key)) continue;
        const values = {};
        for (const line of checkedQuery(run, key, view).split(/\r?\n/)) {
          const match = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/);
          if (match) values[match[1]] = match[2].trim();
        }
        entries.push({ hive, view, kind, key, values });
      }
    }
  }
  return entries;
}

function sameWindowsPath(actual, expected) {
  return typeof actual === "string" && path.win32.isAbsolute(actual)
    && path.win32.resolve(actual).toLowerCase() === path.win32.resolve(expected).toLowerCase();
}

function ownedUninstallCommand(command, uninstaller, quiet) {
  if (typeof command !== "string") return false;
  const match = command.match(/^"([^"]+)"\s+\/currentuser(?:\s+(\/S))?$/i);
  return Boolean(match && sameWindowsPath(match[1], uninstaller) && Boolean(match[2]) === quiet);
}

function assertOwned(entries, installDir, uninstaller) {
  for (const entry of entries) {
    const values = entry.values ?? {};
    const owned = entry.hive === "HKCU" && (entry.kind === "install"
      ? sameWindowsPath(values.InstallLocation, installDir)
      : entry.kind === "uninstall" && /^OpenFix(?:\s|$)/.test(values.DisplayName ?? "")
        && ownedUninstallCommand(values.UninstallString, uninstaller, false)
        && ownedUninstallCommand(values.QuietUninstallString, uninstaller, true));
    if (!owned) throw new Error("OpenFix installation ownership changed; preserve the smoke workspace");
  }
}

function isRegularFile(filename) {
  try {
    const stat = lstatSync(filename);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function runOwnedUninstaller(filename, installDir, run = spawn) {
  return new Promise((resolve, reject) => {
    // _?= prevents NSIS from spawning an untracked temporary copy. It must be last,
    // without automatic argument quotes, including when the directory has spaces.
    const child = run(filename, ["/S", "/currentuser", `_?=${installDir}`], {
      windowsHide: true, windowsVerbatimArguments: true, stdio: "ignore",
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Owned smoke uninstaller timed out; preserve the smoke workspace"));
    }, 60_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); resolve(code); });
  });
}

/** This lifecycle never deletes registry keys or chooses an uninstaller from
 * registry text. Cleanup can execute only the exact file in this run's directory.
 */
export function createSmokeInstallation({
  installDir,
  platform = process.platform,
  queryRegistry = readOpenFixRegistrations,
  regularFile = isRegularFile,
  directoryExists = existsSync,
  runUninstaller = runOwnedUninstaller,
}) {
  const uninstaller = path.win32.join(installDir, "Uninstall OpenFix.exe");
  let installationAttempted = false;
  return {
    begin() {
      if (platform !== "win32") throw new Error("Packaged installation smoke requires Windows");
      if (installationAttempted) throw new Error("Smoke installation has already begun");
      if (queryRegistry().length !== 0) {
        throw new Error("An OpenFix installation is already registered; use an isolated Windows environment");
      }
      if (directoryExists(installDir)) throw new Error("Smoke installation directory must be fresh");
      installationAttempted = true;
    },
    verifyInstalled() {
      if (!installationAttempted) throw new Error("Smoke installation has not begun");
      const entries = queryRegistry();
      assertOwned(entries, installDir, uninstaller);
      if (!entries.some((entry) => entry.kind === "install")
        || !entries.some((entry) => entry.kind === "uninstall") || !regularFile(uninstaller)) {
        throw new Error("Smoke installer did not create a verifiable owned installation");
      }
    },
    async cleanup() {
      // A rejected preflight cannot authorize running any existing uninstaller.
      if (!installationAttempted) return;
      const entries = queryRegistry();
      assertOwned(entries, installDir, uninstaller);
      if (entries.length === 0 && !directoryExists(installDir)) return;
      if (!regularFile(uninstaller)) {
        throw new Error("Owned smoke uninstaller is missing; preserve the smoke workspace");
      }
      const code = await runUninstaller(uninstaller, installDir);
      if (code !== 0) throw new Error(`Owned smoke uninstaller failed (${code}); preserve the smoke workspace`);
      if (queryRegistry().length !== 0) {
        throw new Error("OpenFix registry entries remain after uninstall; preserve the smoke workspace");
      }
    },
  };
}
