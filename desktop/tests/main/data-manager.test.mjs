import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  backupDataDir,
  arePathsEqual,
  doPathsOverlap,
  getDataOperationOptions,
  inspectDataDir,
  isPathWithin,
  migrateDataDir,
  removeDataDir,
  restoreDataDir,
} from "../../dist/main/data-manager.js";

async function createDataDir(base, name) {
  const dir = path.join(base, name);
  await mkdir(path.join(dir, "covers"), { recursive: true });
  await writeFile(path.join(dir, "openfic.db"), "sqlite", "utf8");
  await writeFile(path.join(dir, ".key"), "secret-key", "utf8");
  await writeFile(path.join(dir, "covers", "cover.png"), "png", "utf8");
  return dir;
}

// Windows 目录联接不需要符号链接权限；POSIX 使用普通目录符号链接。
async function createDirectoryLink(target, linkPath) {
  if (process.platform === "win32") {
    await symlink(target, linkPath, "junction");
    return;
  }
  await symlink(target, linkPath);
}

test("inspects a data directory with recognizable OpenFic data", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const dir = await createDataDir(base, "src");
    const inspection = await inspectDataDir(dir);
    assert.equal(inspection.valid, true);
    assert.equal(inspection.hasData, true);
    assert.equal(inspection.entryCount, 3);
    assert.ok(inspection.sizeBytes > 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("inspects an empty directory as having no data", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const dir = path.join(base, "empty");
    await mkdir(dir, { recursive: true });
    const inspection = await inspectDataDir(dir);
    assert.equal(inspection.valid, false);
    assert.equal(inspection.hasData, false);
    assert.equal(inspection.entryCount, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("backup and restore round-trips data directory contents", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const source = await createDataDir(base, "src");
    const archivePath = path.join(base, "backup.tar.gz");
    const restored = path.join(base, "restored");

    await backupDataDir(source, archivePath);
    assert.ok((await stat(archivePath)).size > 0);

    await restoreDataDir(archivePath, restored);
    assert.equal(await readFile(path.join(restored, "openfic.db"), "utf8"), "sqlite");
    assert.equal(await readFile(path.join(restored, ".key"), "utf8"), "secret-key");
    assert.equal(await readFile(path.join(restored, "covers", "cover.png"), "utf8"), "png");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("backup excludes the configured app runtime while keeping project data", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const source = await createDataDir(base, "src");
    const runtime = path.join(source, "runtime", "python");
    await mkdir(runtime, { recursive: true });
    await writeFile(path.join(runtime, "python.exe"), "runtime-binary", "utf8");
    const archivePath = path.join(base, "backup.tar.gz");
    const restored = path.join(base, "restored");

    await backupDataDir(source, archivePath, undefined, undefined, {
      excludedTopLevelEntries: ["runtime"],
    });
    await restoreDataDir(archivePath, restored);

    assert.equal(await readFile(path.join(restored, "openfic.db"), "utf8"), "sqlite");
    await assert.rejects(stat(path.join(restored, "runtime")));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("migrate copies data and preserves the source directory", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const source = await createDataDir(base, "src");
    await mkdir(path.join(source, "runtime"), { recursive: true });
    await writeFile(path.join(source, "runtime", "marker.txt"), "keep during migration", "utf8");
    const target = path.join(base, "target");

    await migrateDataDir(source, target);
    assert.equal(await readFile(path.join(target, "openfic.db"), "utf8"), "sqlite");
    assert.equal(
      await readFile(path.join(target, "runtime", "marker.txt"), "utf8"),
      "keep during migration",
    );
    assert.equal(await readFile(path.join(source, "openfic.db"), "utf8"), "sqlite");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("migrate cleans up the target directory when the source is missing", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const missingSource = path.join(base, "missing");
    const target = path.join(base, "target");

    await assert.rejects(migrateDataDir(missingSource, target));
    await assert.rejects(stat(target));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("removeDataDir deletes the directory recursively", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const dir = await createDataDir(base, "src");
    await removeDataDir(dir);
    await assert.rejects(stat(dir));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("restore preserves the configured app runtime while restoring user data", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const source = await createDataDir(base, "src");
    await mkdir(path.join(source, "runtime"), { recursive: true });
    await writeFile(path.join(source, "runtime", "marker.txt"), "archived-runtime", "utf8");
    const archivePath = path.join(base, "backup.tar.gz");
    await backupDataDir(source, archivePath, undefined, undefined, {
      excludedTopLevelEntries: ["runtime"],
    });

    const live = await createDataDir(base, "live");
    await writeFile(path.join(live, "openfic.db"), "live-db", "utf8");
    await writeFile(path.join(live, ".key"), "live-key", "utf8");
    await writeFile(path.join(live, "covers", "cover.png"), "live-cover", "utf8");
    await mkdir(path.join(live, "runtime", "python"), { recursive: true });
    await writeFile(path.join(live, "runtime", "python", "python.exe"), "live-runtime", "utf8");

    await restoreDataDir(archivePath, live, undefined, undefined, {
      preservedTopLevelEntries: ["runtime"],
    });

    assert.equal(await readFile(path.join(live, "openfic.db"), "utf8"), "sqlite");
    assert.equal(await readFile(path.join(live, ".key"), "utf8"), "secret-key");
    assert.equal(await readFile(path.join(live, "covers", "cover.png"), "utf8"), "png");
    assert.equal(
      await readFile(path.join(live, "runtime", "python", "python.exe"), "utf8"),
      "live-runtime",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("restore keeps the configured runtime when an older verified backup contains it", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const source = await createDataDir(base, "src");
    await mkdir(path.join(source, "runtime", "python"), { recursive: true });
    await writeFile(path.join(source, "runtime", "python", "python.exe"), "archived-runtime", "utf8");
    const archivePath = path.join(base, "backup.tar.gz");
    await backupDataDir(source, archivePath);

    const live = await createDataDir(base, "live");
    await mkdir(path.join(live, "runtime", "python"), { recursive: true });
    await writeFile(path.join(live, "runtime", "python", "python.exe"), "live-runtime", "utf8");

    await restoreDataDir(archivePath, live, undefined, undefined, {
      preservedTopLevelEntries: ["runtime"],
    });

    assert.equal(
      await readFile(path.join(live, "runtime", "python", "python.exe"), "utf8"),
      "live-runtime",
    );
    assert.equal(await readFile(path.join(live, "openfic.db"), "utf8"), "sqlite");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("restore still removes stale user data that is absent from the backup", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const source = await createDataDir(base, "src");
    const archivePath = path.join(base, "backup.tar.gz");
    await backupDataDir(source, archivePath);

    const live = await createDataDir(base, "live");
    await mkdir(path.join(live, "old-notes"), { recursive: true });
    await writeFile(path.join(live, "old-notes", "note.txt"), "stale", "utf8");
    await writeFile(path.join(live, "stale.txt"), "stale", "utf8");
    await mkdir(path.join(live, "runtime"), { recursive: true });
    await writeFile(path.join(live, "runtime", "marker.txt"), "live-runtime", "utf8");

    await restoreDataDir(archivePath, live, undefined, undefined, {
      preservedTopLevelEntries: ["runtime"],
    });

    await assert.rejects(stat(path.join(live, "old-notes")));
    await assert.rejects(stat(path.join(live, "stale.txt")));
    assert.equal(await readFile(path.join(live, "runtime", "marker.txt"), "utf8"), "live-runtime");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("failed restore rolls back original user data and keeps the configured runtime", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const source = await createDataDir(base, "src");
    await mkdir(path.join(source, "notes"), { recursive: true });
    await writeFile(path.join(source, "notes", "note.txt"), "archived-note", "utf8");
    const archivePath = path.join(base, "backup.tar.gz");
    await backupDataDir(source, archivePath);

    const live = await createDataDir(base, "live");
    await writeFile(path.join(live, "openfic.db"), "live-db", "utf8");
    await writeFile(path.join(live, ".key"), "live-key", "utf8");
    await writeFile(path.join(live, "covers", "cover.png"), "live-cover", "utf8");
    // A file where the archive has a directory forces the copy step to fail.
    await writeFile(path.join(live, "notes"), "original-notes", "utf8");
    await mkdir(path.join(live, "runtime"), { recursive: true });
    await writeFile(path.join(live, "runtime", "marker.txt"), "live-runtime", "utf8");

    await assert.rejects(
      restoreDataDir(archivePath, live, undefined, undefined, {
        preservedTopLevelEntries: ["runtime"],
      }),
    );

    assert.equal(await readFile(path.join(live, "notes"), "utf8"), "original-notes");
    assert.equal(await readFile(path.join(live, "openfic.db"), "utf8"), "live-db");
    assert.equal(await readFile(path.join(live, ".key"), "utf8"), "live-key");
    assert.equal(await readFile(path.join(live, "covers", "cover.png"), "utf8"), "live-cover");
    assert.equal(await readFile(path.join(live, "runtime", "marker.txt"), "utf8"), "live-runtime");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("path comparisons resolve aliases and parent-child overlap", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const parent = path.join(base, "parent");
    const child = path.join(parent, "child");
    await mkdir(child, { recursive: true });

    assert.equal(await arePathsEqual(parent, parent), true);
    assert.equal(await isPathWithin(parent, child), true);
    assert.equal(await doPathsOverlap(parent, child), true);
    assert.equal(await doPathsOverlap(child, parent), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("backup and restore treat a case-variant runtime name as the configured runtime on Windows", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows 文件系统大小写不敏感；其他平台保持大小写敏感");
    return;
  }
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const source = await createDataDir(base, "src");
    await mkdir(path.join(source, "Runtime", "python"), { recursive: true });
    await writeFile(path.join(source, "Runtime", "python", "python.exe"), "runtime-binary", "utf8");
    const archivePath = path.join(base, "backup.tar.gz");
    const restored = path.join(base, "restored");

    await backupDataDir(source, archivePath, undefined, undefined, {
      excludedTopLevelEntries: ["runtime"],
    });
    await restoreDataDir(archivePath, restored);

    assert.equal(await readFile(path.join(restored, "openfic.db"), "utf8"), "sqlite");
    await assert.rejects(stat(path.join(restored, "Runtime")));

    const live = await createDataDir(base, "live");
    await writeFile(path.join(live, "openfic.db"), "live-db", "utf8");
    await mkdir(path.join(live, "Runtime", "python"), { recursive: true });
    await writeFile(path.join(live, "Runtime", "python", "python.exe"), "live-runtime", "utf8");

    await restoreDataDir(archivePath, live, undefined, undefined, {
      preservedTopLevelEntries: ["runtime"],
    });

    assert.equal(
      await readFile(path.join(live, "Runtime", "python", "python.exe"), "utf8"),
      "live-runtime",
    );
    assert.equal(await readFile(path.join(live, "openfic.db"), "utf8"), "sqlite");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("runtime exclusion stays case-sensitive on POSIX platforms", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows 文件系统大小写不敏感，已由大小写变体用例覆盖");
    return;
  }
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const source = await createDataDir(base, "src");
    await mkdir(path.join(source, "Runtime", "python"), { recursive: true });
    await writeFile(path.join(source, "Runtime", "python", "python.exe"), "runtime-binary", "utf8");
    const archivePath = path.join(base, "backup.tar.gz");
    const restored = path.join(base, "restored");

    await backupDataDir(source, archivePath, undefined, undefined, {
      excludedTopLevelEntries: ["runtime"],
    });
    await restoreDataDir(archivePath, restored);

    assert.equal(
      await readFile(path.join(restored, "Runtime", "python", "python.exe"), "utf8"),
      "runtime-binary",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("IPC data policy preserves a configured external runtime link during backup and restore", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const source = await createDataDir(base, "src");
    const archivePath = path.join(base, "backup.tar.gz");
    await backupDataDir(source, archivePath);

    const target = path.join(base, "runtime-target");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "python.exe"), "external-runtime", "utf8");

    const live = await createDataDir(base, "live");
    await writeFile(path.join(live, "openfic.db"), "live-db", "utf8");
    const runtimeLink = path.join(live, "runtime");
    try {
      await createDirectoryLink(target, runtimeLink);
    } catch (error) {
      t.skip(`当前环境无法创建目录链接：${error?.code ?? error?.message ?? error}`);
      return;
    }

    const options = await getDataOperationOptions(live, runtimeLink);
    assert.deepEqual(options, {
      backup: { excludedTopLevelEntries: ["runtime"] },
      restore: { preservedTopLevelEntries: ["runtime"] },
    });
    const liveBackup = path.join(base, "live-backup.tar.gz");
    await backupDataDir(live, liveBackup, undefined, undefined, options.backup);
    const backupContents = path.join(base, "backup-contents");
    await restoreDataDir(liveBackup, backupContents);
    await assert.rejects(stat(path.join(backupContents, "runtime")), { code: "ENOENT" });
    await restoreDataDir(archivePath, live, undefined, undefined, options.restore);

    assert.equal(await readFile(path.join(runtimeLink, "python.exe"), "utf8"), "external-runtime");
    assert.equal(await readFile(path.join(target, "python.exe"), "utf8"), "external-runtime");
    assert.equal(await readFile(path.join(live, "openfic.db"), "utf8"), "sqlite");
    // 通过链接写入外部目录，确认 runtime 仍是原来的链接而不是被还原复制的普通目录。
    await writeFile(path.join(target, "marker.txt"), "shared", "utf8");
    assert.equal(await readFile(path.join(runtimeLink, "marker.txt"), "utf8"), "shared");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("IPC data policy supports direct children and disjoint paths and rejects unsupported overlap", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const data = await createDataDir(base, "data");
    assert.deepEqual(await getDataOperationOptions(data, path.join(data, "runtime")), {
      backup: { excludedTopLevelEntries: ["runtime"] },
      restore: { preservedTopLevelEntries: ["runtime"] },
    });
    assert.deepEqual(await getDataOperationOptions(data, path.join(base, "runtime")), { backup: {}, restore: {} });
    await assert.rejects(getDataOperationOptions(data, data), /不能与数据目录相同/);
    await assert.rejects(getDataOperationOptions(data, base), /数据目录不能位于运行环境目录内部/);
    await assert.rejects(getDataOperationOptions(data, path.join(data, "nested", "runtime")), /必须是数据目录的直接子目录/);
    const dottedChild = path.join(data, "..install", "runtime");
    assert.equal(await isPathWithin(data, dottedChild), true);
    assert.equal(await isPathWithin(data, base), false);
    await assert.rejects(getDataOperationOptions(data, dottedChild), /必须是数据目录的直接子目录/);
    assert.equal(await readFile(path.join(data, "openfic.db"), "utf8"), "sqlite");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("IPC data policy rejects a runtime link to another data subtree", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const data = await createDataDir(base, "data");
    const target = path.join(data, "engine");
    await mkdir(target);
    await writeFile(path.join(target, "python.exe"), "runtime-binary", "utf8");
    const link = path.join(data, "runtime");
    try {
      await createDirectoryLink(target, link);
    } catch (error) {
      t.skip(`当前环境无法创建目录链接：${error?.code ?? error?.message ?? error}`);
      return;
    }
    await assert.rejects(getDataOperationOptions(data, link), /不能链接到数据目录中的其他条目/);
    assert.equal(await readFile(path.join(target, "python.exe"), "utf8"), "runtime-binary");
    assert.equal(await readFile(path.join(data, "openfic.db"), "utf8"), "sqlite");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("restore keeps user data whose on-disk name differs from the archive only by case on Windows", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only case-insensitive filesystem regression");
    return;
  }
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const source = await createDataDir(base, "source");
    const archive = path.join(base, "backup.tar.gz");
    await backupDataDir(source, archive);
    const live = path.join(base, "live");
    await mkdir(path.join(live, "Covers"), { recursive: true });
    await createDataDir(base, "live");
    await writeFile(path.join(live, "Covers", "cover.png"), "old-cover", "utf8");
    await restoreDataDir(archive, live);
    assert.equal(await readFile(path.join(live, "Covers", "cover.png"), "utf8"), "png");
    assert.equal(await readFile(path.join(live, "openfic.db"), "utf8"), "sqlite");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("restore still rejects an unprotected symlink before modifying data", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfic-data-"));
  try {
    const source = await createDataDir(base, "src");
    const archivePath = path.join(base, "backup.tar.gz");
    await backupDataDir(source, archivePath);

    const target = path.join(base, "extra-target");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "note.txt"), "external", "utf8");

    const live = await createDataDir(base, "live");
    await writeFile(path.join(live, "openfic.db"), "live-db", "utf8");
    const extraLink = path.join(live, "extra-link");
    try {
      await createDirectoryLink(target, extraLink);
    } catch (error) {
      t.skip(`当前环境无法创建目录链接：${error?.code ?? error?.message ?? error}`);
      return;
    }
    assert.equal((await lstat(extraLink)).isSymbolicLink(), true);

    await assert.rejects(
      restoreDataDir(archivePath, live, undefined, undefined, {
        preservedTopLevelEntries: ["runtime"],
      }),
      /拒绝处理符号链接/,
    );

    assert.equal(await readFile(path.join(live, "openfic.db"), "utf8"), "live-db");
    assert.equal(await readFile(path.join(target, "note.txt"), "utf8"), "external");
    assert.equal((await lstat(extraLink)).isSymbolicLink(), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
