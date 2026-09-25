/**
 * 自动备份调度 - 定期把本地数据目录备份到用户指定目录。
 *
 * 复用现有 backupDataDir 生成 tar.gz 备份，并按保留数量轮换历史文件。
 * 调度器在 registerIpc 内启动，与手动备份/恢复共用配置变更队列互斥。
 */

import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { appendLog } from "./logging.js";
import { resolveDataDir } from "./data-location.js";
import type { AutoBackupSettings, DesktopConfig } from "../shared/config.js";

export const AUTO_BACKUP_PREFIX = "OpenFix-backup-";
export const AUTO_BACKUP_SUFFIX = ".tar.gz";
export const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AUTO_BACKUP_STARTUP_DELAY_MS = 2 * 60 * 1000;
export const AUTO_BACKUP_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export interface AutoBackupTarget {
  instanceId: string;
  dataDir: string;
  settings: AutoBackupSettings;
}

export function buildAutoBackupFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${AUTO_BACKUP_PREFIX}` +
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    AUTO_BACKUP_SUFFIX
  );
}

export function getAutoBackupTarget(config: DesktopConfig | null): AutoBackupTarget | null {
  const settings = config?.autoBackup;
  if (!settings || !settings.enabled || !settings.dir) return null;
  const instance = config.instances.find(
    (item) => item.mode === "local" && item.id === (config.activeInstanceId ?? ""),
  ) ?? config.instances.find((item) => item.mode === "local");
  if (!instance) return null;
  return {
    instanceId: instance.id,
    dataDir: resolveDataDir(instance),
    settings,
  };
}

/** 目录中最新的自动备份文件修改时间；没有历史备份时返回 null。 */
export async function getLatestAutoBackupTime(backupDir: string): Promise<Date | null> {
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch {
    return null;
  }
  let latest: Date | null = null;
  for (const name of names) {
    if (!name.startsWith(AUTO_BACKUP_PREFIX) || !name.endsWith(AUTO_BACKUP_SUFFIX)) continue;
    try {
      const info = await stat(path.join(backupDir, name));
      if (latest === null || info.mtime > latest) latest = info.mtime;
    } catch {
      // 文件可能在扫描期间被删除，忽略。
    }
  }
  return latest;
}

export async function shouldRunAutoBackup(
  backupDir: string,
  now: Date = new Date(),
): Promise<boolean> {
  const latest = await getLatestAutoBackupTime(backupDir);
  if (latest === null) return true;
  return now.getTime() - latest.getTime() >= AUTO_BACKUP_INTERVAL_MS;
}

/** 删除超出保留数量的历史备份，返回删除的文件数。 */
export async function rotateAutoBackups(
  backupDir: string,
  keep: number,
): Promise<number> {
  let names: string[];
  try {
    names = (await readdir(backupDir)).filter(
      (name) => name.startsWith(AUTO_BACKUP_PREFIX) && name.endsWith(AUTO_BACKUP_SUFFIX),
    );
  } catch {
    return 0;
  }
  const entries = await Promise.all(
    names.map(async (name) => {
      const fullPath = path.join(backupDir, name);
      try {
        const info = await stat(fullPath);
        return { fullPath, mtime: info.mtime };
      } catch {
        return null;
      }
    }),
  );
  const sorted = entries
    .filter((entry): entry is { fullPath: string; mtime: Date } => entry !== null)
    .sort((left, right) => right.mtime.getTime() - left.mtime.getTime());
  let removed = 0;
  for (const entry of sorted.slice(Math.max(keep, 0))) {
    try {
      await unlink(entry.fullPath);
      removed += 1;
    } catch (error) {
      appendLog("data", `删除过期自动备份失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return removed;
}
