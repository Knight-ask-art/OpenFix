import { app } from "electron";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendLog } from "../logging.js";
import { downloadFile, extractTarGz } from "./archive.js";
import { resolvePythonAsset } from "./python-assets.js";
import {
  isSupportedSystemPythonVersion,
  matchesPortablePythonVersion,
  parsePythonVersion,
} from "./python-version.js";

/** 记录当前运行时使用的解释器来源，解释器变化时用于判定是否需要重建 venv。 */
const PYTHON_IDENTITY_MARKER = ".openfix-python";
const SYSTEM_PYTHON_PROBE_TIMEOUT_MS = 8_000;

export interface PortablePython {
  pythonPath: string;
  rootDir: string;
  wasReplaced: boolean;
}

export interface DownloadProgress {
  received: number;
  total: number;
}

export interface RuntimeIntegrityCheck {
  complete: boolean;
  message: string;
}

export function getDefaultInstallDir(): string {
  return app.getPath("userData");
}

export function resolveRuntimeDir(installDir: string | null): string {
  const base = installDir ?? app.getPath("userData");
  return path.join(base, "runtime");
}

export function getPortablePythonRoot(runtimeDir: string): string {
  return path.join(runtimeDir, "python");
}

export function getPortablePythonPath(rootDir: string): string {
  if (process.platform === "win32") return path.join(rootDir, "python", "python.exe");
  return path.join(rootDir, "python", "bin", "python3");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const value = bytes / Math.pow(1024, Math.floor(Math.log(bytes) / Math.log(1024)));
  const unit = units[Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)];
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

function readPythonVersion(pythonPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    appendLog("runtime", `检查 Python 版本：${pythonPath} --version`);
    const child = spawn(pythonPath, ["--version"], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const appendOutput = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      output += text;
      appendLog("runtime", text);
    };
    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);
    child.on("error", (error) => {
      appendLog("runtime", `检查 Python 版本失败：${error.message}`);
      resolve(null);
    });
    child.on("exit", (code) => {
      appendLog("runtime", code === 0 ? "检查 Python 版本完成" : `检查 Python 版本失败：退出码 ${code}`);
      resolve(code === 0 ? output.trim() || null : null);
    });
  });
}

export async function inspectPortablePython(runtimeDir: string): Promise<RuntimeIntegrityCheck> {
  const identity = await readPythonIdentity(runtimeDir);
  if (identity?.startsWith("system|")) {
    const pythonPath = identity.slice("system|".length);
    if (await pathExists(pythonPath)) {
      const version = await readPythonVersion(pythonPath);
      if (version && isSupportedSystemPythonVersion(version)) {
        return { complete: true, message: `系统 Python 已就绪：${version.trim()}` };
      }
    }
    return { complete: false, message: "系统 Python 不可用或版本不匹配" };
  }

  const pythonPath = getPortablePythonPath(getPortablePythonRoot(runtimeDir));
  if (!(await pathExists(pythonPath))) {
    return { complete: false, message: "未找到便携式 Python" };
  }

  const installedVersion = await readPythonVersion(pythonPath);
  if (!installedVersion || !matchesPortablePythonVersion(installedVersion, resolvePythonAsset().version)) {
    return { complete: false, message: "便携式 Python 不可用或版本不匹配" };
  }

  return { complete: true, message: "便携式 Python 已就绪" };
}

interface SystemPythonCandidate {
  pythonPath: string;
  version: string;
  identity: string;
}

function getPythonIdentityPath(runtimeDir: string): string {
  return path.join(runtimeDir, PYTHON_IDENTITY_MARKER);
}

async function readPythonIdentity(runtimeDir: string): Promise<string | null> {
  try {
    const raw = await readFile(getPythonIdentityPath(runtimeDir), "utf-8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

async function writePythonIdentity(runtimeDir: string, identity: string): Promise<void> {
  try {
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(getPythonIdentityPath(runtimeDir), `${identity}\n`, "utf-8");
  } catch (error) {
    appendLog("runtime", `写入解释器标记失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function runCapture(
  command: string,
  args: string[],
  timeoutMs = SYSTEM_PYTHON_PROBE_TIMEOUT_MS,
): Promise<{ code: number | null; output: string } | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer | string) => {
      output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    };
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.trim() });
    });
  });
}

/** Windows 上用 py 启动器枚举已安装解释器路径（覆盖未加入 PATH 的安装）。 */
async function listWindowsLauncherPythons(): Promise<string[]> {
  const result = await runCapture("py", ["-0p"]);
  if (!result || result.code !== 0) return [];
  return result.output
    .split(/\r?\n/)
    .map((line) => {
      const exePath = line.match(/([A-Za-z]:\\[^\r\n]*python(?:3(?:\.\d+)?)?\.exe)\s*$/)?.[1];
      // 行首的 -V:<version> 用于按版本从新到旧排序。
      const listedVersion = line.match(/-V:(?:Astral\/CPython|CPython)?(\d+)\.(\d+)/);
      const minor = listedVersion ? Number.parseInt(listedVersion[2], 10) : 0;
      return exePath ? { exePath, minor } : null;
    })
    .filter((entry): entry is { exePath: string; minor: number } => entry !== null)
    .sort((left, right) => right.minor - left.minor)
    .map((entry) => entry.exePath);
}

function listPathPythonNames(): string[] {
  return process.platform === "win32"
    ? ["python3.13", "python3.12", "python"]
    : ["python3.13", "python3.12", "python3", "python"];
}

/**
 * 查找可复用的系统 Python（3.12/3.13 且能创建带 pip 的 venv）。
 * 找不到返回 null，调用方回退到下载内置便携 Python。
 */
export async function findSystemPython(): Promise<SystemPythonCandidate | null> {
  const candidates = process.platform === "win32" ? await listWindowsLauncherPythons() : [];
  const names = listPathPythonNames();
  const probed = new Set<string>();

  for (const pythonPath of [...candidates, ...names]) {
    if (probed.has(pythonPath)) continue;
    probed.add(pythonPath);
    const versionResult = await runCapture(pythonPath, ["--version"]);
    if (!versionResult || versionResult.code !== 0) continue;
    if (!isSupportedSystemPythonVersion(versionResult.output)) continue;
    const version = parsePythonVersion(versionResult.output);
    if (!version) continue;
    // 部分发行版的 Python 缺少 ensurepip，无法生成带 pip 的 venv。
    const venvReady = await runCapture(pythonPath, [
      "-c",
      "import ensurepip, venv; print('ok')",
    ]);
    if (!venvReady || venvReady.code !== 0 || !venvReady.output.includes("ok")) {
      appendLog("runtime", `系统 Python 缺少 ensurepip/venv，跳过：${pythonPath}`);
      continue;
    }
    appendLog("runtime", `发现可复用的系统 Python：${pythonPath}（${version}）`);
    return { pythonPath, version, identity: `system|${pythonPath}` };
  }

  appendLog("runtime", "未找到可复用的系统 Python（需要 3.12 或 3.13）");
  return null;
}

export async function ensurePortablePython(
  runtimeDir: string,
  onPhase: (phase: "download" | "extract", message: string) => void,
  onDownload: (progress: DownloadProgress) => void,
): Promise<PortablePython> {
  const rootDir = getPortablePythonRoot(runtimeDir);
  const pythonPath = getPortablePythonPath(rootDir);
  const asset = resolvePythonAsset();

  // 1. 沿用上次选定的解释器（系统 Python 或内置便携 Python），避免重复探测/下载。
  const identity = await readPythonIdentity(runtimeDir);
  if (identity?.startsWith("system|")) {
    const systemPythonPath = identity.slice("system|".length);
    const version = await pathExists(systemPythonPath)
      ? await readPythonVersion(systemPythonPath)
      : null;
    if (version && isSupportedSystemPythonVersion(version)) {
      appendLog("runtime", `沿用系统 Python：${systemPythonPath}`);
      return { pythonPath: systemPythonPath, rootDir, wasReplaced: false };
    }
    appendLog("runtime", "系统 Python 已不可用，重新选择");
  }

  appendLog("runtime", `开始检查便携式 Python：${rootDir}`);
  if (await pathExists(pythonPath)) {
    const installedVersion = await readPythonVersion(pythonPath);
    if (installedVersion && matchesPortablePythonVersion(installedVersion, asset.version)) {
      appendLog("runtime", `便携式 Python 已就绪：${installedVersion}`);
      await writePythonIdentity(runtimeDir, `bundled|${asset.version}`);
      return { pythonPath, rootDir, wasReplaced: false };
    }
    appendLog("runtime", "便携式 Python 版本不匹配或不可用，删除现有文件");
    await rm(rootDir, { recursive: true, force: true });
  }

  // 2. 优先复用用户已有的 Python，省掉一次几十 MB 的下载。
  const systemPython = await findSystemPython();
  if (systemPython) {
    onPhase("download", "使用系统 Python");
    await writePythonIdentity(runtimeDir, systemPython.identity);
    // 解释器来源与上次不同，调用方需要重建 venv。
    return { pythonPath: systemPython.pythonPath, rootDir, wasReplaced: true };
  }

  // A partial extraction may not contain the Python executable at all.
  await rm(rootDir, { recursive: true, force: true });

  const archivePath = path.join(runtimeDir, `python-${asset.version}-${asset.target}.tar.gz`);
  await mkdir(runtimeDir, { recursive: true });

  onPhase("download", `下载 Python ${asset.version}`);
  appendLog("runtime", `开始下载 Python ${asset.version}`);
  await downloadFile(
    asset.urls,
    archivePath,
    (received, total) => onDownload({ received, total }),
    (message) => appendLog("runtime", message),
  );

  onPhase("extract", "解压 Python");
  appendLog("runtime", "开始解压 Python");
  await extractTarGz(archivePath, rootDir, (message) => appendLog("runtime", message), undefined, false);

  if (!(await pathExists(pythonPath))) {
    throw new Error(`portable Python not found after extraction: ${pythonPath}`);
  }

  await rm(archivePath, { force: true });

  appendLog("runtime", "便携式 Python 安装完成");
  await writePythonIdentity(runtimeDir, `bundled|${asset.version}`);
  return { pythonPath, rootDir, wasReplaced: true };
}

export function describeDownloadProgress(progress: DownloadProgress): string {
  if (!progress.total) return formatBytes(progress.received);
  return `${formatBytes(progress.received)} / ${formatBytes(progress.total)}`;
}
