// The actual built backup pipeline runs over a real scratch tree while only `cp` is intercepted, so
// a locked source file must fail the backup instead of publishing a manifest for a partial tree.
// Symlinks and Windows directory junctions inside the backup set must fail the same way, because
// skipping them would certify an archive that silently omits the linked user data.
// The restore copy path must keep its documented skip semantics. Run after build:main with
// node --experimental-vm-modules --test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip, createGzip } from "node:zlib";
import { extract, pack } from "tar-stream";
import test from "node:test";
import vm from "node:vm";

import * as backupManifest from "../../dist/main/backup-manifest.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const distMainDir = path.join(repoRoot, "desktop/dist/main");
const LOCKED_NAME = "chapter-notes.txt";
const LOCK_CODES = ["EBUSY", "EPERM", "EACCES"];

// 只拦截 cp：命中的源文件名表现为被占用，其余文件系统调用保持真实，避免复制整套文件系统语义。
async function loadModules({ lockedFileName = null, lockedErrorCode = "EBUSY" } = {}) {
  assert.equal(typeof vm.SourceTextModule, "function", "Use --experimental-vm-modules");
  const [tarCode, dataManagerCode] = await Promise.all([
    fs.readFile(path.join(distMainDir, "runtime/tar-extract.js"), "utf8"),
    fs.readFile(path.join(distMainDir, "data-manager.js"), "utf8"),
  ]);
  const context = vm.createContext({
    console,
    URL,
    setTimeout,
    clearTimeout,
    process: { platform: process.platform },
  });
  const lockErrors = [];
  const cp = async (source, target, options) => {
    if (lockedFileName !== null && path.basename(source) === lockedFileName) {
      lockErrors.push(source);
      throw Object.assign(new Error(`synthetic lock: ${path.basename(source)}`), { code: lockedErrorCode });
    }
    return fs.cp(source, target, options);
  };
  function synthetic(identifier, exports) {
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context, identifier },
    );
  }

  const manifest = synthetic("synthetic:backup-manifest", {
    BACKUP_MANIFEST_NAME: backupManifest.BACKUP_MANIFEST_NAME,
    computeBackupManifest: backupManifest.computeBackupManifest,
    hashFile: backupManifest.hashFile,
    verifyBackupManifest: backupManifest.verifyBackupManifest,
  });
  const fsPromises = synthetic("synthetic:fs-promises", {
    cp, lstat: fs.lstat, mkdir: fs.mkdir, mkdtemp: fs.mkdtemp, readdir: fs.readdir,
    readlink: fs.readlink, realpath: fs.realpath, rename: fs.rename, rm: fs.rm,
    stat: fs.stat, symlink: fs.symlink, writeFile: fs.writeFile,
  });
  const nodeFs = synthetic("synthetic:fs", { createReadStream, createWriteStream });
  const nodeOs = synthetic("synthetic:os", { default: os });
  const nodePath = synthetic("synthetic:path", { default: path });
  const nodeStreams = synthetic("synthetic:stream-promises", { pipeline });
  const nodeTarStream = synthetic("synthetic:tar-stream", { extract, pack });

  const tarExtract = new vm.SourceTextModule(tarCode, {
    context,
    identifier: path.join(distMainDir, "runtime/tar-extract.js"),
    importModuleDynamically: () => { throw new Error("Forbidden dynamic import"); },
  });
  const tarDependencies = {
    "node:child_process": synthetic("synthetic:child-process", { spawn }),
    "node:fs": nodeFs,
    "node:fs/promises": fsPromises,
    "node:os": nodeOs,
    "node:path": nodePath,
    "node:stream/promises": nodeStreams,
    "node:zlib": synthetic("synthetic:zlib", { createGunzip }),
    "tar-stream": nodeTarStream,
    "../backup-manifest.js": manifest,
  };
  await tarExtract.link((specifier) => {
    const dependency = tarDependencies[specifier];
    if (!dependency) throw new Error(`Unknown tar-extract dependency: ${specifier}`);
    return dependency;
  });
  await tarExtract.evaluate();

  const dataManager = new vm.SourceTextModule(dataManagerCode, {
    context,
    identifier: path.join(distMainDir, "data-manager.js"),
    importModuleDynamically: () => { throw new Error("Forbidden dynamic import"); },
  });
  const dataManagerDependencies = {
    "node:fs": nodeFs,
    "node:fs/promises": fsPromises,
    "node:os": nodeOs,
    "node:path": nodePath,
    "node:stream/promises": nodeStreams,
    "node:zlib": synthetic("synthetic:zlib:gzip", { createGzip }),
    "tar-stream": nodeTarStream,
    "./backup-manifest.js": manifest,
    "./runtime/tar-extract.js": tarExtract,
  };
  await dataManager.link((specifier) => {
    const dependency = dataManagerDependencies[specifier];
    if (!dependency) throw new Error(`Unknown data-manager dependency: ${specifier}`);
    return dependency;
  });
  await dataManager.evaluate();

  return { tarExtract: tarExtract.namespace, dataManager: dataManager.namespace, lockErrors };
}

async function createLockedDataDir(base, { name = LOCKED_NAME } = {}) {
  const source = path.join(base, "data");
  await fs.mkdir(path.join(source, "notes"), { recursive: true });
  await fs.writeFile(path.join(source, "openfic.db"), "sqlite", "utf8");
  await fs.writeFile(path.join(source, ".key"), "secret-key", "utf8");
  await fs.writeFile(path.join(source, "notes", name), "note text", "utf8");
  return source;
}

async function withScratch(run) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "openfix-backup-integrity-"));
  try {
    await run(base);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

// 虚拟机 realm 抛出的 Error 与宿主 realm 不同源，先取回再按消息断言。
async function failureOf(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return null;
}

const LINK_UNAVAILABLE = "当前主机不允许创建目录符号链接或目录联接（EPERM/EACCES）";

// Windows 用目录联接（无需开发者模式），POSIX 用目录符号链接；返回 false 表示能力不可用。
async function createDirectoryLink(targetDir, linkPath) {
  await fs.mkdir(targetDir, { recursive: true });
  try {
    await fs.symlink(targetDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES")) return false;
    throw error;
  }
}

// 拒绝时必须既不发布归档也不留下暂存归档，且源链接与链接目标保持原样。
async function assertLinkRefusedWithoutPublishing(failure, { archivePath, linkPath, externalFile, externalText }) {
  assert.ok(failure, "A symlink must fail the backup");
  assert.match(failure.message, /备份失败：/);
  assert.match(failure.message, /符号链接/);
  assert.doesNotMatch(failure.message, /文件被占用/, "链接拒绝必须是区别于占用文件的错误");
  await assert.rejects(fs.stat(archivePath), "The archive must not be published");
  await assert.rejects(fs.stat(`${archivePath}.tmp`), "The staging archive must not be left behind");
  assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true, "The source link must stay untouched");
  assert.equal(await fs.readFile(externalFile, "utf8"), externalText, "The link target must stay untouched");
}

// 归档条目名用于确认被排除的运行环境子树确实没有进入备份。
async function listArchiveEntries(archivePath) {
  const names = [];
  const archive = extract();
  archive.on("entry", (header, stream, next) => {
    names.push(header.name);
    stream.on("end", next);
    stream.resume();
  });
  await pipeline(createReadStream(archivePath), createGunzip(), archive);
  return names;
}

test("a locked source file fails the backup instead of certifying a partial tree", async () => {
  await withScratch(async (base) => {
    const source = await createLockedDataDir(base);
    const archivePath = path.join(base, "backup.tar.gz");
    const { dataManager, lockErrors } = await loadModules({ lockedFileName: LOCKED_NAME });

    const failure = await failureOf(() => dataManager.backupDataDir(source, archivePath));

    assert.ok(failure, "A locked file must fail the backup");
    assert.match(failure.message, /备份失败：文件被占用/);
    assert.ok(lockErrors.length > 0, "The locked file must actually be attempted");
    // 失败时既不能发布归档，也不能留下暂存归档。
    await assert.rejects(fs.stat(archivePath));
    await assert.rejects(fs.stat(`${archivePath}.tmp`));
  });
});

test("every lock code fails the backup", async () => {
  for (const code of LOCK_CODES) {
    await withScratch(async (base) => {
      const source = await createLockedDataDir(base);
      const archivePath = path.join(base, "backup.tar.gz");
      const { dataManager } = await loadModules({ lockedFileName: LOCKED_NAME, lockedErrorCode: code });

      const failure = await failureOf(() => dataManager.backupDataDir(source, archivePath));

      assert.ok(failure, `Lock code ${code} must fail the backup`);
      assert.match(failure.message, /备份失败：文件被占用/);
      await assert.rejects(fs.stat(archivePath));
    });
  }
});

test("an unlocked tree still publishes an archive with the same harness", async () => {
  await withScratch(async (base) => {
    const source = await createLockedDataDir(base);
    const archivePath = path.join(base, "backup.tar.gz");
    const { dataManager, lockErrors } = await loadModules();

    await dataManager.backupDataDir(source, archivePath);

    assert.ok((await fs.stat(archivePath)).size > 0);
    assert.deepEqual(lockErrors, []);
  });
});

test("the strict copy mode reports a nested locked file instead of skipping it", async () => {
  await withScratch(async (base) => {
    const source = await createLockedDataDir(base);
    const { tarExtract, lockErrors } = await loadModules({ lockedFileName: LOCKED_NAME });

    const failure = await failureOf(() =>
      tarExtract.copyTree(source, path.join(base, "strict-target"), undefined, undefined, false, {
        failOnLockedFile: true,
      }),
    );

    assert.ok(failure, "The strict copy mode must fail on a locked file");
    assert.match(failure.message, /备份失败：文件被占用/);
    assert.ok(lockErrors.length > 0);
  });
});

test("the restore copy semantics still skip a locked file and log it", async () => {
  await withScratch(async (base) => {
    const source = await createLockedDataDir(base);
    const target = path.join(base, "restore-target");
    const { tarExtract } = await loadModules({ lockedFileName: LOCKED_NAME });
    const logs = [];

    await tarExtract.copyTree(source, target, (message) => logs.push(message));

    assert.equal(await fs.readFile(path.join(target, "openfic.db"), "utf8"), "sqlite");
    assert.deepEqual(await fs.readdir(path.join(target, "notes")), [], "The locked file stays skipped");
    assert.ok(logs.some((message) => message.includes("跳过被占用的文件")), "The skip must stay visible");
  });
});

// Windows 盘符归档路径（C:\...）曾被 tar 当作远程主机说明符而解压失败；回归固定为经 stdin 传入归档。
test(
  "a drive-letter archive path restores through the system tar",
  { skip: process.platform !== "win32" },
  async () => {
    await withScratch(async (base) => {
      const source = await createLockedDataDir(base);
      const archivePath = path.join(base, "backup.tar.gz");
      const restored = path.join(base, "restored");
      const { dataManager } = await loadModules();

      await dataManager.backupDataDir(source, archivePath);
      await dataManager.restoreDataDir(archivePath, restored);

      assert.equal(await fs.readFile(path.join(restored, "openfic.db"), "utf8"), "sqlite");
      assert.equal(await fs.readFile(path.join(restored, "notes", LOCKED_NAME), "utf8"), "note text");
    });
  },
);

test("a top-level symlink fails the backup instead of being skipped", async (t) => {
  await withScratch(async (base) => {
    const source = await createLockedDataDir(base);
    const external = path.join(base, "external-notes");
    const externalFile = path.join(external, "linked.txt");
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(externalFile, "linked note", "utf8");
    const linkPath = path.join(source, "linked-notes");
    if (!(await createDirectoryLink(external, linkPath))) {
      t.skip(LINK_UNAVAILABLE);
      return;
    }
    const archivePath = path.join(base, "backup.tar.gz");
    const { dataManager } = await loadModules();

    const failure = await failureOf(() => dataManager.backupDataDir(source, archivePath));

    await assertLinkRefusedWithoutPublishing(failure, {
      archivePath,
      linkPath,
      externalFile,
      externalText: "linked note",
    });
  });
});

test("a nested symlink fails the backup instead of being skipped", async (t) => {
  await withScratch(async (base) => {
    const source = await createLockedDataDir(base);
    const external = path.join(base, "external-chapters");
    const externalFile = path.join(external, "chapter-1.txt");
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(externalFile, "chapter one", "utf8");
    const linkPath = path.join(source, "notes", "deep", "linked-chapters");
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    if (!(await createDirectoryLink(external, linkPath))) {
      t.skip(LINK_UNAVAILABLE);
      return;
    }
    const archivePath = path.join(base, "backup.tar.gz");
    const { dataManager } = await loadModules();

    const failure = await failureOf(() => dataManager.backupDataDir(source, archivePath));

    assert.ok(
      failure && failure.message.includes(path.join("notes", "deep", "linked-chapters")),
      "The refusal must name the nested link",
    );
    await assertLinkRefusedWithoutPublishing(failure, {
      archivePath,
      linkPath,
      externalFile,
      externalText: "chapter one",
    });
    assert.equal(await fs.readFile(path.join(source, "notes", LOCKED_NAME), "utf8"), "note text");
  });
});

// 配置的运行环境子树不属于备份集合：其中的链接既不阻止备份，也不进入归档。
test("an excluded runtime subtree may still contain links", async (t) => {
  await withScratch(async (base) => {
    const source = await createLockedDataDir(base);
    const external = path.join(base, "external-runtime");
    const externalFile = path.join(external, "python-link.txt");
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(externalFile, "runtime payload", "utf8");
    const linkPath = path.join(source, "runtime", "python-link");
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    if (!(await createDirectoryLink(external, linkPath))) {
      t.skip(LINK_UNAVAILABLE);
      return;
    }
    const archivePath = path.join(base, "backup.tar.gz");
    const { dataManager } = await loadModules();

    await dataManager.backupDataDir(source, archivePath, undefined, undefined, {
      excludedTopLevelEntries: ["runtime"],
    });

    assert.ok((await fs.stat(archivePath)).size > 0, "The backup must still publish an archive");
    const names = await listArchiveEntries(archivePath);
    assert.ok(names.includes("openfic.db"), "The archive must carry the core data");
    assert.ok(
      !names.some((name) => name === "runtime" || name === "runtime/" || name.startsWith("runtime/")),
      "The excluded runtime subtree must stay out of the archive",
    );
    assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true, "The excluded link must stay untouched");
    assert.equal(await fs.readFile(externalFile, "utf8"), "runtime payload");
  });
});

test("the strict copy mode refuses a symlink that the restore path would skip", async (t) => {
  await withScratch(async (base) => {
    const source = await createLockedDataDir(base);
    const external = path.join(base, "external-notes");
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(path.join(external, "linked.txt"), "linked note", "utf8");
    const linkPath = path.join(source, "linked-notes");
    if (!(await createDirectoryLink(external, linkPath))) {
      t.skip(LINK_UNAVAILABLE);
      return;
    }
    const { tarExtract } = await loadModules();
    const logs = [];

    const failure = await failureOf(() =>
      tarExtract.copyTree(linkPath, path.join(base, "strict-link-target"), (message) => logs.push(message), undefined, false, {
        failOnSymlink: true,
      }),
    );

    assert.ok(failure, "The strict copy mode must fail on a symlink");
    assert.match(failure.message, /备份失败：/);
    assert.match(failure.message, /符号链接/);
    assert.ok(!logs.some((message) => message.includes("跳过符号链接")), "The strict mode must not fall back to skipping");
    await assert.rejects(fs.stat(path.join(base, "strict-link-target")));
    assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true);
  });
});

test("the restore copy semantics still skip a symlink and log it", async (t) => {
  await withScratch(async (base) => {
    const source = await createLockedDataDir(base);
    const external = path.join(base, "external-notes");
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(path.join(external, "linked.txt"), "linked note", "utf8");
    const linkPath = path.join(source, "linked-notes");
    if (!(await createDirectoryLink(external, linkPath))) {
      t.skip(LINK_UNAVAILABLE);
      return;
    }
    const target = path.join(base, "restore-target");
    const { tarExtract } = await loadModules();
    const logs = [];

    await tarExtract.copyTree(source, target, (message) => logs.push(message));

    assert.equal(await fs.readFile(path.join(target, "notes", LOCKED_NAME), "utf8"), "note text");
    assert.ok(!(await fs.readdir(target)).includes("linked-notes"), "The link stays skipped");
    assert.ok(logs.some((message) => message.includes("跳过符号链接")), "The skip must stay visible");
    assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true);
  });
});
