import { createReadStream, createWriteStream } from "node:fs";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack } from "tar-stream";
import { BACKUP_MANIFEST_NAME, computeBackupManifest } from "./backup-manifest.js";
import {
  assertDirNoSymlink,
  copyTree,
  copyWithRetry,
  CORE_DATA_ENTRIES,
  createTopLevelEntryMatcher,
  extractTarGz,
  isExcludedRuntimeEntry,
  measureTreeSize,
  type CopyTreeOptions,
  type DataPhaseReporter,
  type TopLevelEntryMatcher,
} from "./runtime/tar-extract.js";

export interface DataDirInspection {
  valid: boolean;
  hasData: boolean;
  entryCount: number;
  sizeBytes: number;
}

export interface BackupDataOptions {
  /**
   * App-managed directories outside the user's project data, relative to the data root.
   *
   * 名称匹配遵循 {@link createTopLevelEntryMatcher} 的平台策略，与还原保留保持一致。
   */
  excludedTopLevelEntries?: readonly string[];
  /** Electron's actual sessionData root, supplied by the main process. */
  sessionDataDir?: string;
}

export interface RestoreDataOptions {
  /** Data-root top-level entries to preserve during restore, such as the configured app runtime. */
  preservedTopLevelEntries?: readonly string[];
}

export interface DataOperationOptions {
  backup: BackupDataOptions;
  restore: RestoreDataOptions;
}

/** Derive the shared backup/restore policy before stopping the backend or modifying data. */
export async function getDataOperationOptions(dataDir: string, runtimeDir: string, sessionDataDir?: string): Promise<DataOperationOptions> {
  const dataPath = await resolveForCompare(dataDir);
  const runtimePath = await resolveForCompare(runtimeDir);
  const runtimeParent = await resolveForCompare(path.dirname(path.resolve(runtimeDir)));
  const entryName = path.basename(path.resolve(runtimeDir));
  const runtimeEntryPath = path.join(runtimeParent, entryName);
  const sessionPath = sessionDataDir ? await resolveForCompare(sessionDataDir) : undefined;
  const sessionOptions: BackupDataOptions = sessionPath && (pathEquals(dataPath, sessionPath) || pathContains(dataPath, sessionPath))
    ? { sessionDataDir: sessionPath } : {};

  if (pathEquals(dataPath, runtimePath)) {
    throw new Error("运行环境目录不能与数据目录相同，无法安全执行数据操作");
  }
  if (pathContains(runtimePath, dataPath)) {
    throw new Error("数据目录不能位于运行环境目录内部，无法安全执行数据操作");
  }
  if (pathEquals(dataPath, runtimeParent)) {
    // A direct child may link to an external runtime. Preserve the configured entry itself.
    // A link to another data subtree cannot be protected by preserving this entry alone.
    if (pathContains(dataPath, runtimePath) && !pathEquals(runtimeEntryPath, runtimePath)) {
      throw new Error("运行环境目录不能链接到数据目录中的其他条目，无法安全执行数据操作");
    }
    return {
      backup: { ...sessionOptions, excludedTopLevelEntries: [entryName] },
      restore: { preservedTopLevelEntries: [entryName] },
    };
  }
  if (
    pathContains(dataPath, runtimePath) ||
    pathContains(dataPath, runtimeEntryPath) ||
    pathContains(normalizeForCompare(dataDir), normalizeForCompare(runtimeDir))
  ) {
    throw new Error("运行环境目录必须是数据目录的直接子目录，无法安全执行数据操作");
  }
  return { backup: sessionOptions, restore: {} };
}

/** Browser network state is app-owned, while IndexedDB contains recoverable
 * writing/prompt drafts. Scope exclusions to the canonical Electron session
 * root and OpenFix's persist:openfic-* partitions; preserve their actual data.
 */
function createSessionBackupFilter(sessionDataDir?: string): ((entryPath: string) => boolean) | undefined {
  if (!sessionDataDir) return undefined;
  const sessionRoot = path.resolve(sessionDataDir);
  return (entryPath) => {
    const relative = path.relative(sessionRoot, path.resolve(entryPath));
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    let parts = relative.split(path.sep);
    if (process.platform === "win32") parts = parts.map((part) => part.toLowerCase());
    const match = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    if (parts[0] === match("Partitions")) {
      if (!parts[1]?.startsWith("openfic-")) return false;
      parts = parts.slice(2);
    }
    if (parts[0] === match("Network") || (parts.length === 1 && parts[0] === match("Cookies"))) return true;
    // LevelDB's LOCK is a live process mutex, not a database record. Its .log,
    // .ldb/.sst, CURRENT and MANIFEST files (including pending drafts) stay in the archive.
    return parts.at(-1) === match("LOCK") && (
      (parts.length === 3 && parts[0] === match("IndexedDB") && parts[1].endsWith(".leveldb"))
      || (parts.length === 3 && parts[0] === match("Local Storage") && parts[1] === "leveldb")
    );
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

interface WalkSummary {
  entryCount: number;
  sizeBytes: number;
  hasDatabase: boolean;
  hasCoversDir: boolean;
  hasKeyFile: boolean;
}

async function summarizeDirectory(dir: string): Promise<WalkSummary> {
  const summary: WalkSummary = { entryCount: 0, sizeBytes: 0, hasDatabase: false, hasCoversDir: false, hasKeyFile: false };
  const root = path.resolve(dir);
  if (!(await pathExists(root))) return summary;

  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (isExcludedRuntimeEntry(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(entry.parentPath, entry.name);
    if (entry.isFile()) {
      summary.entryCount += 1;
      try {
        summary.sizeBytes += (await stat(fullPath)).size;
      } catch {
        // Ignore transient stat failures when estimating size.
      }
      if (entry.name === "openfic.db") summary.hasDatabase = true;
      if (entry.name === ".key") summary.hasKeyFile = true;
      continue;
    }
    if (entry.isDirectory() && entry.name === "covers") summary.hasCoversDir = true;
  }
  return summary;
}

export async function inspectDataDir(dataDir: string): Promise<DataDirInspection> {
  const summary = await summarizeDirectory(dataDir);
  return {
    valid: summary.hasDatabase || summary.hasCoversDir || summary.hasKeyFile,
    hasData: summary.entryCount > 0,
    entryCount: summary.entryCount,
    sizeBytes: summary.sizeBytes,
  };
}

async function addDirectoryToPack(
  archive: ReturnType<typeof pack>,
  directory: string,
  baseDir: string,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const archiveName = path.relative(baseDir, fullPath).split(path.sep).join("/");
    if (entry.isDirectory()) {
      archive.entry({ name: `${archiveName}/`, type: "directory" });
      await addDirectoryToPack(archive, fullPath, baseDir);
      continue;
    }
    if (entry.isFile()) {
      const size = (await stat(fullPath)).size;
      const writable = archive.entry({ name: archiveName, size });
      await pipeline(createReadStream(fullPath), writable);
      continue;
    }
  }
}

export async function backupDataDir(
  dataDir: string,
  targetPath: string,
  onLog?: (message: string) => void,
  onPhase?: DataPhaseReporter,
  options: BackupDataOptions = {},
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const stagingDir = await mkdtemp(path.join(os.tmpdir(), "openfic-backup-"));
  const tmpPath = `${targetPath}.tmp`;
  try {
    await copyDirectoryWithRetry(
      dataDir,
      stagingDir,
      onLog,
      onPhase,
      createTopLevelEntryMatcher(options.excludedTopLevelEntries ?? []),
      // 备份必须整树成功：被占用的文件或符号链接一旦跳过，随后生成的清单就会把缺少用户数据的目录树认证为完整备份。
      { failOnLockedFile: true, failOnSymlink: true, skipSourcePath: createSessionBackupFilter(options.sessionDataDir) },
    );
    await writeFile(path.join(stagingDir, BACKUP_MANIFEST_NAME), JSON.stringify(await computeBackupManifest(stagingDir), null, 2));
    onPhase?.("pack");
    const archive = pack();
    const output = createWriteStream(tmpPath);
    const done = pipeline(archive, createGzip(), output);
    await addDirectoryToPack(archive, stagingDir, stagingDir);
    archive.finalize();
    await done;
    await rename(tmpPath, targetPath);
  } finally {
    await rm(tmpPath, { force: true });
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function copyDirectoryWithRetry(
  sourceDir: string,
  targetDir: string,
  onLog?: (message: string) => void,
  onPhase?: DataPhaseReporter,
  excludedTopLevelEntries: TopLevelEntryMatcher = createTopLevelEntryMatcher(),
  options: CopyTreeOptions = {},
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`无法读取数据目录 ${sourceDir}：${error instanceof Error ? error.message : String(error)}`);
  }
  await assertDirNoSymlink(targetDir);
  let total = 0;
  const coreSizes = new Map<string, number>();
  const copyable: { name: string; core: boolean }[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (excludedTopLevelEntries.has(name)) continue;
    if (isExcludedRuntimeEntry(name)) continue;
    if (name === BACKUP_MANIFEST_NAME) continue;
    const sourcePath = path.join(sourceDir, name);
    if (options.skipSourcePath?.(sourcePath)) continue;
    const size = await measureTreeSize(sourcePath, options.skipSourcePath);
    copyable.push({ name, core: CORE_DATA_ENTRIES.has(name) });
    if (CORE_DATA_ENTRIES.has(name)) coreSizes.set(name, size);
    total += size;
  }
  let copied = 0;
  let lastRounded = -1;
  const report = () => {
    const rounded = total > 0 ? Math.floor((copied / total) * 100) : 100;
    if (rounded !== lastRounded) {
      lastRounded = rounded;
      onPhase?.("copy", rounded / 100);
    }
  };
  for (const { name, core } of copyable) {
    const sourcePath = path.join(sourceDir, name);
    const targetPath = path.join(targetDir, name);
    if (core) {
      await copyWithRetry(sourcePath, targetPath);
      copied += coreSizes.get(name) ?? 0;
      report();
    } else {
      await copyTree(sourcePath, targetPath, onLog, (bytes) => {
        copied += bytes;
        report();
      }, false, options);
    }
  }
  report();
}

export async function restoreDataDir(
  sourcePath: string,
  targetDir: string,
  onLog?: (message: string) => void,
  onPhase?: DataPhaseReporter,
  options: RestoreDataOptions = {},
): Promise<void> {
  await extractTarGz(sourcePath, targetDir, onLog, onPhase, true, {
    preservedTopLevelEntries: options.preservedTopLevelEntries,
  });
}

export async function migrateDataDir(
  fromDir: string,
  toDir: string,
  onLog?: (message: string) => void,
  onPhase?: DataPhaseReporter,
): Promise<void> {
  const resolvedFrom = await resolveForCompare(fromDir);
  const resolvedTo = await resolveForCompare(toDir);
  if (pathEquals(resolvedFrom, resolvedTo)) {
    throw new Error("迁移目标目录不能与源目录相同");
  }
  if (pathContains(resolvedFrom, resolvedTo)) {
    throw new Error("迁移目标目录不能位于源目录内部");
  }
  if (pathContains(resolvedTo, resolvedFrom)) {
    throw new Error("迁移源目录不能位于目标目录内部");
  }
  await mkdir(toDir, { recursive: true });
  try {
    await copyDirectoryWithRetry(fromDir, toDir, onLog, onPhase);
  } catch (error) {
    await rm(toDir, { recursive: true, force: true });
    throw error;
  }
}

function normalizeForCompare(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function resolveForCompare(filePath: string): Promise<string> {
  try {
    return normalizeForCompare(await realpath(filePath));
  } catch {
    const missing: string[] = [];
    let current = filePath;
    while (true) {
      try {
        const real = await realpath(current);
        return normalizeForCompare(path.join(real, ...missing));
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return normalizeForCompare(filePath);
        missing.unshift(path.basename(current));
        current = parent;
      }
    }
  }
}

function pathEquals(left: string, right: string): boolean {
  return normalizeForCompare(left) === normalizeForCompare(right);
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(normalizeForCompare(parent), normalizeForCompare(child));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function arePathsEqual(left: string, right: string): Promise<boolean> {
  return pathEquals(await resolveForCompare(left), await resolveForCompare(right));
}

export async function isPathWithin(parent: string, child: string): Promise<boolean> {
  return pathContains(await resolveForCompare(parent), await resolveForCompare(child));
}

export async function doPathsOverlap(left: string, right: string): Promise<boolean> {
  const resolvedLeft = await resolveForCompare(left);
  const resolvedRight = await resolveForCompare(right);
  return pathEquals(resolvedLeft, resolvedRight) || pathContains(resolvedLeft, resolvedRight) || pathContains(resolvedRight, resolvedLeft);
}

/**
 * 备份目标目录必须完全位于数据目录之外。
 *
 * 目标与数据目录相同、位于其内部或包住数据目录时，已经存在的历史备份会在后续备份中
 * 被反复收进新备份，还原时也会连同这些备份覆盖用户数据；因此在执行备份前直接拒绝，
 * 不做任何删除或改动。
 */
export async function assertBackupDirOutsideDataDir(dataDir: string, backupDir: string): Promise<void> {
  if (await doPathsOverlap(dataDir, backupDir)) {
    throw new Error("备份目录不能与数据目录相同、位于数据目录内部或包含数据目录，请选择数据目录之外的目录");
  }
}

export async function removeDataDir(dataDir: string): Promise<void> {
  await rm(dataDir, { recursive: true, force: true });
}
