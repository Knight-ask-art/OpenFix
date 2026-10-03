import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readlink, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import { BACKUP_MANIFEST_NAME, hashFile, verifyBackupManifest } from "../backup-manifest.js";
import type { DataOperationPhase } from "../../shared/ipc.js";

const EXCLUDED_RUNTIME_ENTRIES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "Crashpad",
  "Session Storage",
  "WebStorage",
  "lockfile",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
]);

export function isExcludedRuntimeEntry(name: string): boolean {
  return EXCLUDED_RUNTIME_ENTRIES.has(name);
}

/**
 * 顶层条目名称匹配器。
 *
 * 备份排除与还原保留必须共用同一个匹配器：Windows 文件系统大小写不敏感，
 * 其他平台保持大小写敏感，否则同一配置路径会在备份与还原两侧得出不同结论，
 * 导致大小写变体的运行环境目录被当作普通用户数据清理或覆盖。
 */
export interface TopLevelEntryMatcher {
  has(entryName: string): boolean;
}

function normalizeTopLevelEntryName(name: string): string {
  return process.platform === "win32" ? name.toLowerCase() : name;
}

export function createTopLevelEntryMatcher(entryNames: Iterable<string> = []): TopLevelEntryMatcher {
  const normalizedNames = new Set<string>();
  for (const entryName of entryNames) normalizedNames.add(normalizeTopLevelEntryName(entryName));
  return { has: (entryName: string) => normalizedNames.has(normalizeTopLevelEntryName(entryName)) };
}

export interface ExtractTarGzOptions {
  /**
   * 数据根目录下必须在还原过程中保留的顶层条目名称。
   *
   * 用于保护配置的运行环境目录：还原时不覆盖、不清理，回滚时也不参与快照与恢复，
   * 目标校验遍历同样跳过它们。名称匹配遵循 {@link createTopLevelEntryMatcher} 的平台策略。
   */
  preservedTopLevelEntries?: readonly string[];
}

/** 校验保留条目名称；仅接受单个顶层名称，拒绝空值、分隔符与路径穿越。 */
function resolvePreservedTopLevelEntries(entries: readonly string[] | undefined): TopLevelEntryMatcher {
  for (const entry of entries ?? []) {
    if (
      entry.length === 0 ||
      entry === "." ||
      entry === ".." ||
      entry.includes("/") ||
      entry.includes("\\") ||
      path.isAbsolute(entry)
    ) {
      throw new Error(`无效的保留条目名称：${entry}`);
    }
  }
  return createTopLevelEntryMatcher(entries ?? []);
}

function isLockError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

export type DataPhaseReporter = (phase: DataOperationPhase, progress?: number) => void;

const BACKUP_RETRY_ATTEMPTS = 5;
const BACKUP_RETRY_BASE_DELAY_MS = 250;

async function assertNoSymlink(entryPath: string, skipTopLevelEntries?: TopLevelEntryMatcher): Promise<void> {
  const info = await lstat(entryPath);
  if (info.isSymbolicLink()) {
    throw new Error(`拒绝处理符号链接：${entryPath}`);
  }
  if (info.isDirectory()) {
    const entries = await readdir(entryPath);
    for (const entryName of entries) {
      if (skipTopLevelEntries?.has(entryName)) continue;
      await assertNoSymlink(path.join(entryPath, entryName));
    }
  }
}

export interface AssertDirNoSymlinkOptions {
  /**
   * 校验目标目录时整棵子树跳过的顶层条目。
   *
   * 仅用于配置的运行环境目录：还原过程从不读取、复制、清理或跟随它们，
   * 因此其中的符号链接（便携 Python 的链接或 Windows 目录联接）不应阻止还原。
   * 目录本身与所有未受保护的子目录仍按原有规则拒绝符号链接。
   */
  skipTopLevelEntries?: TopLevelEntryMatcher;
}

export async function assertDirNoSymlink(dir: string, options: AssertDirNoSymlinkOptions = {}): Promise<void> {
  try {
    await lstat(dir);
  } catch {
    return;
  }
  await assertNoSymlink(dir, options.skipTopLevelEntries);
}

export async function copyWithRetry(sourcePath: string, targetPath: string): Promise<void> {
  await assertNoSymlink(sourcePath);
  for (let attempt = 1; ; attempt++) {
    try {
      await cp(sourcePath, targetPath, { recursive: true });
      return;
    } catch (error) {
      if (attempt >= BACKUP_RETRY_ATTEMPTS || !isLockError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, BACKUP_RETRY_BASE_DELAY_MS * attempt));
    }
  }
}

export async function measureTreeSize(entryPath: string, skipSourcePath?: (entryPath: string) => boolean): Promise<number> {
  if (skipSourcePath?.(entryPath)) return 0;
  const info = await lstat(entryPath);
  if (info.isSymbolicLink()) return 0;
  if (info.isDirectory()) {
    let total = 0;
    const entries = await readdir(entryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (isExcludedRuntimeEntry(entry.name)) continue;
      total += await measureTreeSize(path.join(entryPath, entry.name), skipSourcePath);
    }
    return total;
  }
  return info.size;
}

export interface CopyTreeOptions {
  /** Explicit app-owned paths outside the backup payload; never inferred from a lock error. */
  skipSourcePath?: (entryPath: string) => boolean;
  /**
   * 备份路径必须开启：被占用的文件一旦按跳过处理，随后生成的清单就会把缺少用户数据的
   * 目录树认证为完整备份。还原路径保持既有的跳过语义，由还原校验与回滚负责一致性。
   */
  failOnLockedFile?: boolean;
  /**
   * 备份路径必须开启：符号链接与 Windows 目录联接一旦按跳过处理，清单同样会把缺少链接
   * 目标的目录树认证为完整备份。还原路径不启用该选项，继续跳过并记录这些链接。
   */
  failOnSymlink?: boolean;
}

export async function copyTree(
  sourcePath: string,
  targetPath: string,
  onLog?: (message: string) => void,
  onBytesCopied?: (bytes: number) => void,
  preserveSymlinks: boolean = false,
  options: CopyTreeOptions = {},
): Promise<void> {
  if (options.skipSourcePath?.(sourcePath)) return;
  const sourceStat = await lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    if (options.failOnSymlink) {
      // Windows 目录联接与符号链接一样被 lstat 判定为符号链接，两者都在这里拒绝。
      throw new Error(`备份失败：检测到符号链接或目录联接，无法生成完整备份 ${sourcePath}`);
    }
    if (!preserveSymlinks) {
      onLog?.(`跳过符号链接：${sourcePath}`);
      return;
    }
    const link = await readlink(sourcePath);
    if (path.isAbsolute(link)) {
      onLog?.(`跳过绝对路径符号链接：${sourcePath} -> ${link}`);
      return;
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await symlink(link, targetPath);
    return;
  }
  if (sourceStat.isDirectory()) {
    await mkdir(targetPath, { recursive: true });
    const entries = await readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      if (isExcludedRuntimeEntry(entry.name)) continue;
      await copyTree(path.join(sourcePath, entry.name), path.join(targetPath, entry.name), onLog, onBytesCopied, preserveSymlinks, options);
    }
    return;
  }
  try {
    await cp(sourcePath, targetPath);
  } catch (error) {
    if (isLockError(error)) {
      const code = (error as NodeJS.ErrnoException).code;
      if (options.failOnLockedFile) {
        throw new Error(`备份失败：文件被占用，无法复制 ${sourcePath}（${code}）`);
      }
      onLog?.(`跳过被占用的文件：${targetPath}（${code}）`);
      return;
    }
    throw error;
  }
  onBytesCopied?.(sourceStat.size);
}

function resolveArchiveEntryPath(outputDir: string, entryName: string): string {
  const outputRoot = path.resolve(outputDir);
  const entryPath = path.resolve(outputRoot, entryName);
  if (entryPath === outputRoot || !entryPath.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error(`archive entry escapes output directory: ${entryName}`);
  }
  return entryPath;
}

function resolveArchiveLinkPath(outputDir: string, entryPath: string, linkName: string): void {
  if (path.isAbsolute(linkName)) throw new Error(`archive link escapes output directory: ${linkName}`);
  const outputRoot = path.resolve(outputDir);
  const linkTarget = path.resolve(path.dirname(entryPath), linkName);
  if (!linkTarget.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error(`archive link escapes output directory: ${linkName}`);
  }
}

function logProcessOutput(stream: NodeJS.ReadableStream, onLog?: (message: string) => void): void {
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += (typeof chunk === "string" ? chunk : chunk.toString("utf8")).replace(/\r/g, "\n");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onLog?.(line);
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) onLog?.(buffer);
  });
}

/**
 * Windows 盘符路径的反斜杠会被 tar 当作转义字符：`C:\Users` 解析成 `C:Users`，
 * 目标目录因此打不开（GNU tar 报 `Cannot open: No such file or directory`）。
 * 改用正斜杠后 GNU tar 与 Windows 自带 tar 都能解析该路径。其余平台不做转换，
 * 避免改动同名反斜杠的合法路径。
 */
function toTarDestinationPath(outputDir: string): string {
  return process.platform === "win32" ? outputDir.replace(/\\/g, "/") : outputDir;
}

async function extractWithSystemTar(archivePath: string, outputDir: string, onLog?: (message: string) => void): Promise<void> {
  // Windows 盘符归档路径（如 C:\...）会被 tar 当成远程归档说明符（host:path）而拒绝解压，
  // 因此 Windows 改为经 stdin 传入归档文件；其余平台保持原有的命令行形式不变。
  const viaStdin = process.platform === "win32";
  const destinationDir = toTarDestinationPath(outputDir);
  const args = viaStdin ? ["-xzf", "-", "-C", destinationDir] : ["-xzf", archivePath, "-C", destinationDir];
  await new Promise<void>((resolve, reject) => {
    onLog?.(`执行解压命令：tar ${args.join(" ")}`);
    const child = spawn("tar", args, {
      windowsHide: true,
      stdio: viaStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });
    // stdio 是条件表达式，spawn 的元组重载不适用，三个流在类型上均为可空，因此逐个收窄后再使用。
    const { stderr, stdin, stdout } = child;
    if (stdout) logProcessOutput(stdout, onLog);
    if (stderr) logProcessOutput(stderr, onLog);
    if (viaStdin && stdin) {
      // spawn 失败或 tar 提前退出时管道写入会中断；启动与退出失败由下面的事件统一上报。
      void pipeline(createReadStream(archivePath), stdin).catch((error: unknown) => {
        onLog?.(`归档数据写入中断：${error instanceof Error ? error.message : String(error)}`);
      });
    }
    child.once("error", (error) => {
      onLog?.(`解压命令启动失败：${error.message}`);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code === 0) {
        onLog?.("解压命令执行完成");
        resolve();
        return;
      }
      const error = new Error(`tar exited with code ${code}`);
      onLog?.(`解压命令执行失败：${error.message}`);
      reject(error);
    });
  });
}

async function extractWithBuiltInTar(archivePath: string, outputDir: string): Promise<void> {
  const archive = extract();
  archive.on("entry", (header, stream, next) => {
    const extractEntry = async () => {
      const entryPath = resolveArchiveEntryPath(outputDir, header.name);
      if (header.type === "directory") {
        await mkdir(entryPath, { recursive: true });
        stream.resume();
        return;
      }
      if (header.type === "file") {
        await mkdir(path.dirname(entryPath), { recursive: true });
        await pipeline(stream, createWriteStream(entryPath, { mode: header.mode }));
        return;
      }
      if (header.type === "symlink" && header.linkname) {
        resolveArchiveLinkPath(outputDir, entryPath, header.linkname);
        await mkdir(path.dirname(entryPath), { recursive: true });
        await symlink(header.linkname, entryPath);
        stream.resume();
        return;
      }
      stream.resume();
    };

    void extractEntry().then(() => next(), next);
  });

  await pipeline(createReadStream(archivePath), createGunzip(), archive);
}

export async function extractTarGz(
  archivePath: string,
  outputDir: string,
  onLog?: (message: string) => void,
  onPhase?: DataPhaseReporter,
  verifyBackup: boolean = true,
  options: ExtractTarGzOptions = {},
): Promise<void> {
  const preservedEntries = resolvePreservedTopLevelEntries(options.preservedTopLevelEntries);
  const stagingDir = await mkdtemp(path.join(os.tmpdir(), "openfic-restore-"));
  const rollbackDir = await mkdtemp(path.join(os.tmpdir(), "openfic-rollback-"));
  let rollbackKept = false;
  const preserveSymlinks = !verifyBackup;
  try {
    onPhase?.("extract");
    await extractIntoDirectory(archivePath, stagingDir, onLog);
    if (verifyBackup) {
      onPhase?.("verify");
      await verifyBackupManifest(stagingDir);
      await assertDirNoSymlink(outputDir, { skipTopLevelEntries: preservedEntries });
    }
    await copyTopLevelEntries(outputDir, rollbackDir, "rollback", onLog, onPhase, preserveSymlinks, preservedEntries);
    try {
      await copyTopLevelEntries(stagingDir, outputDir, "copy", onLog, onPhase, preserveSymlinks, preservedEntries);
      if (verifyBackup) await verifyRestoredFiles(stagingDir, outputDir);
      onPhase?.("cleanup");
      await clearExtraEntries(outputDir, stagingDir, onLog, preservedEntries);
    } catch (error) {
      try {
        await clearTopLevelEntries(outputDir, onLog, preservedEntries);
        await copyTopLevelEntries(rollbackDir, outputDir, "copy", onLog, onPhase, preserveSymlinks, preservedEntries);
      } catch (rollbackError) {
        rollbackKept = true;
        const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(
          `还原失败，且自动回滚失败：${detail}。已保留回滚备份目录 ${rollbackDir}，可手动将其内容复制回 ${outputDir}`,
          { cause: error },
        );
      }
      throw error;
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    if (!rollbackKept) await rm(rollbackDir, { recursive: true, force: true });
  }
}

async function extractIntoDirectory(archivePath: string, outputDir: string, onLog?: (message: string) => void): Promise<void> {
  try {
    await extractWithSystemTar(archivePath, outputDir, onLog);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    onLog?.("未找到系统 tar，改用内置解压器");
    await extractWithBuiltInTar(archivePath, outputDir);
  }
}

async function copyTopLevelEntries(
  sourceDir: string,
  targetDir: string,
  phase: DataOperationPhase,
  onLog?: (message: string) => void,
  onPhase?: DataPhaseReporter,
  preserveSymlinks: boolean = false,
  preservedEntries: TopLevelEntryMatcher = createTopLevelEntryMatcher(),
): Promise<void> {
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch {
    return;
  }
  let total = 0;
  const coreSizes = new Map<string, number>();
  const copyable: { name: string; core: boolean }[] = [];
  for (const entry of entries) {
    if (isExcludedRuntimeEntry(entry.name)) continue;
    if (preservedEntries.has(entry.name)) continue;
    if (entry.name === BACKUP_MANIFEST_NAME) continue;
    const name = entry.name;
    const size = await measureTreeSize(path.join(sourceDir, name));
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
      onPhase?.(phase, rounded / 100);
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
      }, preserveSymlinks);
    }
  }
  report();
}

async function clearTopLevelEntries(
  dir: string,
  onLog?: (message: string) => void,
  preservedEntries: TopLevelEntryMatcher = createTopLevelEntryMatcher(),
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (isExcludedRuntimeEntry(entry.name)) continue;
    if (preservedEntries.has(entry.name)) continue;
    await removeEntry(path.join(dir, entry.name), onLog);
  }
}

async function removeEntry(fullPath: string, onLog?: (message: string) => void): Promise<void> {
  try {
    await rm(fullPath, { recursive: true, force: true });
  } catch (error) {
    if (isLockError(error)) {
      onLog?.(`保留被占用的文件：${fullPath}（${(error as NodeJS.ErrnoException).code}）`);
      return;
    }
    throw error;
  }
}

async function clearExtraEntries(
  dir: string,
  keepDir: string,
  onLog?: (message: string) => void,
  preservedEntries: TopLevelEntryMatcher = createTopLevelEntryMatcher(),
): Promise<void> {
  let keep: TopLevelEntryMatcher;
  try {
    keep = createTopLevelEntryMatcher(await readdir(keepDir));
  } catch {
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (isExcludedRuntimeEntry(entry.name)) continue;
    if (preservedEntries.has(entry.name)) continue;
    if (entry.name === BACKUP_MANIFEST_NAME) {
      await removeEntry(path.join(dir, entry.name), onLog);
      continue;
    }
    if (keep.has(entry.name)) continue;
    await removeEntry(path.join(dir, entry.name), onLog);
  }
}

export const CORE_DATA_ENTRIES = new Set(["openfic.db", ".key", "covers"]);

export const INSTANCE_DATA_ENTRIES = new Set([
  ".env",
  ".key",
  "openfic.db",
  "openfic.db-wal",
  "openfic.db-shm",
  "checkpoints.db",
  "checkpoints.db-wal",
  "checkpoints.db-shm",
  "covers",
  "character-images",
  "agent-attachments",
  "chapter-exports",
  "lancedb",
  "fastembed_cache",
  "model_provider_catalog",
  "icons",
]);

function isCoreDataPath(relativePath: string): boolean {
  return CORE_DATA_ENTRIES.has(relativePath.split(/[\\/]/)[0]);
}

async function verifyRestoredFiles(referenceDir: string, targetDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(referenceDir, { recursive: true, withFileTypes: true });
  } catch (error) {
    throw new Error(`校验还原结果失败：${error instanceof Error ? error.message : String(error)}`);
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const sourcePath = path.join(entry.parentPath, entry.name);
    const relativePath = path.relative(referenceDir, sourcePath);
    if (!isCoreDataPath(relativePath)) continue;
    const targetPath = path.join(targetDir, relativePath);
    let targetStat;
    try {
      targetStat = await stat(targetPath);
    } catch {
      throw new Error(`还原校验失败：缺少文件 ${relativePath}`);
    }
    let expectedSize: number;
    try {
      expectedSize = (await stat(sourcePath)).size;
    } catch (error) {
      throw new Error(`还原校验失败：无法读取备份文件 ${relativePath}：${error instanceof Error ? error.message : String(error)}`);
    }
    if (targetStat.size !== expectedSize) {
      throw new Error(`还原校验失败：文件大小不一致 ${relativePath}（期望 ${expectedSize}，实际 ${targetStat.size}）`);
    }
    let expectedHash: string;
    try {
      expectedHash = await hashFile(sourcePath);
    } catch (error) {
      throw new Error(`还原校验失败：无法读取备份文件 ${relativePath}：${error instanceof Error ? error.message : String(error)}`);
    }
    if ((await hashFile(targetPath)) !== expectedHash) {
      throw new Error(`还原校验失败：文件内容与备份不符 ${relativePath}`);
    }
  }
}
