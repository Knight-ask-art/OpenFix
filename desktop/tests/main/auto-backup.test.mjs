// Synthetic filesystem verifies auto backup scan and rotation admission only.
// Run after build:main with node --experimental-vm-modules --test.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PREFIX = "OpenFix-backup-";
const SUFFIX = ".tar.gz";
const DAY_MS = 24 * 60 * 60 * 1000;
const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const autoBackupDistPath = path.join(repoRoot, "desktop/dist/main/auto-backup.js");
const tmpRoot = path.join(repoRoot, "tmp");

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !path.isAbsolute(relative)
    && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function archiveName(stamp) {
  return `${PREFIX}${stamp}${SUFFIX}`;
}

async function loadAutoBackup() {
  assert.equal(typeof vm.SourceTextModule, "function", "Use --experimental-vm-modules");
  const code = await fs.readFile(autoBackupDistPath, "utf8");
  const context = vm.createContext({});
  const synthetic = (identifier, exports) => new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    },
    { context, identifier },
  );
  const dependencies = {
    "node:fs/promises": synthetic("synthetic:fs-promises", {
      readdir: fs.readdir, lstat: fs.lstat, unlink: fs.unlink, stat: fs.stat,
    }),
    "node:path": synthetic("synthetic:path", { default: path }),
    "./logging.js": synthetic("synthetic:logging", {
      appendLog: () => { throw new Error("Unexpected auto backup rotation log"); },
    }),
    "./data-location.js": synthetic("synthetic:data-location", {
      resolveDataDir: (instance) => instance.dataDir,
    }),
    "./runtime/python.js": synthetic("synthetic:python", {
      resolveRuntimeDir: (installDir) => String(installDir ?? ""),
    }),
  };
  const module = new vm.SourceTextModule(code, {
    context,
    identifier: autoBackupDistPath,
    importModuleDynamically: () => { throw new Error("Forbidden dynamic import"); },
  });
  await module.link((specifier) => {
    const dependency = dependencies[specifier];
    if (!dependency) throw new Error(`Unknown auto-backup dependency: ${specifier}`);
    return dependency;
  });
  await module.evaluate();
  return module.namespace;
}

// Windows 路径大小写不敏感，realpath 与输入比较前先归一化。
function samePath(left, right) {
  const [a, b] = [path.resolve(left), path.resolve(right)];
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// 只接受真实目录/文件：符号链接、目录联接与别名路径一律拒绝。
async function requireUnlinked(target) {
  const info = await fs.lstat(target);
  assert.equal(info.isSymbolicLink(), false, `Refuse linked path: ${target}`);
  assert.ok(samePath(await fs.realpath(target), target), `Refuse aliased path: ${target}`);
  return info;
}

// 创建前先确认仓库根与隔离根都是真实目录，再记录 mkdtemp scratch 的 dev/ino 身份。
async function openScratch(prefix) {
  assert.ok((await requireUnlinked(repoRoot)).isDirectory(), "Repository root must be an unlinked directory");
  try {
    await fs.mkdir(tmpRoot);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  assert.ok(within(repoRoot, tmpRoot), "Workspace tmp must stay inside the repository");
  assert.ok((await requireUnlinked(tmpRoot)).isDirectory(), "Workspace tmp must be an unlinked directory");
  const root = await fs.mkdtemp(path.join(tmpRoot, prefix));
  assert.ok(within(tmpRoot, root), "Scratch must stay inside workspace tmp");
  assert.ok(samePath(path.dirname(root), tmpRoot), "Scratch must be a direct child of workspace tmp");
  const created = await requireUnlinked(root);
  assert.ok(created.isDirectory(), "Scratch must be a directory");
  return { root, dev: created.dev, ino: created.ino, links: [] };
}

async function withScratch(run) {
  const owned = await openScratch("openfix-auto-backup-");
  try {
    await run(owned.root, owned);
  } finally {
    await closeScratch(owned);
  }
}

// 正向回归用的目录联接在创建时登记精确路径、目标与 lstat 身份，清理时只删这些已核验联接。
async function registerDirectoryLink(owned, target, linkPath) {
  assert.ok(within(owned.root, target), "Link target must stay inside the owned scratch");
  assert.ok(within(owned.root, linkPath), "Link path must stay inside the owned scratch");
  const targetInfo = await requireUnlinked(target);
  assert.ok(targetInfo.isDirectory(), "Link target must be an unlinked directory");
  await createDirectoryLink(target, linkPath);
  const info = await fs.lstat(linkPath);
  assert.equal(info.isSymbolicLink(), true, "Registered link must be a link");
  owned.links.push({
    linkPath, target, dev: info.dev, ino: info.ino, targetDev: targetInfo.dev, targetIno: targetInfo.ino,
  });
}

async function unlinkOwnedLinks(owned) {
  const verified = [];
  for (const link of owned.links) {
    assert.ok(within(owned.root, link.linkPath), "Refuse to unlink outside the owned scratch");
    assert.ok(within(owned.root, link.target), "Registered link target must stay inside the owned scratch");
    const info = await fs.lstat(link.linkPath);
    assert.equal(info.isSymbolicLink(), true, `Registered link changed: ${link.linkPath}`);
    assert.equal(info.dev, link.dev, `Registered link device changed: ${link.linkPath}`);
    assert.equal(info.ino, link.ino, `Registered link inode changed: ${link.linkPath}`);
    assert.ok(samePath(await fs.realpath(link.linkPath), link.target), `Registered link retargeted: ${link.linkPath}`);
    const targetInfo = await requireUnlinked(link.target);
    assert.ok(targetInfo.isDirectory(), "Registered link target must remain an unlinked directory");
    assert.equal(targetInfo.dev, link.targetDev, `Registered link target device changed: ${link.linkPath}`);
    assert.equal(targetInfo.ino, link.targetIno, `Registered link target inode changed: ${link.linkPath}`);
    verified.push(link);
  }
  for (const link of verified) await fs.unlink(link.linkPath);
  owned.links = [];
}

// 只走真实目录，已知联接只登记不跟随；未知链接与特殊文件一律拒绝，验证失败时保留 scratch 供排查。
async function inspectOwnedTree(target, tree, knownLinks) {
  const info = await fs.lstat(target);
  if (info.isSymbolicLink()) {
    assert.ok(knownLinks.has(target), `Refuse unknown link: ${target}`);
    tree.links.push(target);
    return;
  }
  assert.ok(samePath(await fs.realpath(target), target), `Refuse aliased path: ${target}`);
  if (info.isDirectory()) {
    tree.directories.push(target);
    for (const name of await fs.readdir(target)) await inspectOwnedTree(path.join(target, name), tree, knownLinks);
    return;
  }
  assert.ok(info.isFile(), `Refuse special file: ${target}`);
  tree.files.push(target);
}

// 清理前先核对仓库根/隔离根/scratch 身份，再完整验证已登记联接与真实条目，全部通过后才逐层删除。
async function closeScratch(owned) {
  const root = owned.root;
  assert.ok(within(repoRoot, tmpRoot) && within(tmpRoot, root), "Refuse to remove outside workspace tmp");
  assert.ok(samePath(path.dirname(root), tmpRoot), "Refuse to remove a shared directory");
  assert.equal(samePath(root, repoRoot) || samePath(root, tmpRoot), false, "Refuse to remove a shared root");
  assert.ok((await requireUnlinked(repoRoot)).isDirectory(), "Repository root changed; cleanup refused");
  assert.ok((await requireUnlinked(tmpRoot)).isDirectory(), "Workspace tmp changed; cleanup refused");
  const current = await requireUnlinked(root);
  assert.ok(current.isDirectory(), "Scratch must be a directory");
  assert.equal(current.dev, owned.dev, "Scratch device changed; cleanup refused");
  assert.equal(current.ino, owned.ino, "Scratch inode changed; cleanup refused");
  const knownLinks = new Map(owned.links.map((link) => [link.linkPath, link]));
  const tree = { directories: [], files: [], links: [] };
  await inspectOwnedTree(root, tree, knownLinks);
  assert.equal(tree.links.length, owned.links.length, "Owned tree links must match the registered links");
  await unlinkOwnedLinks(owned);
  for (const file of tree.files) await fs.unlink(file);
  for (const directory of tree.directories.reverse()) await fs.rmdir(directory);
  await assert.rejects(fs.lstat(root), (error) => error?.code === "ENOENT");
}

async function writeArchive(directory, name, mtime) {
  const fullPath = path.join(directory, name);
  await fs.writeFile(fullPath, "synthetic archive\n");
  await fs.utimes(fullPath, mtime, mtime);
  return fullPath;
}

// Windows 目录联接不需要符号链接权限；POSIX 使用普通目录符号链接。
async function createDirectoryLink(target, linkPath) {
  if (process.platform === "win32") {
    await fs.symlink(target, linkPath, "junction");
    return;
  }
  await fs.symlink(target, linkPath);
}

test("an empty backup directory is due and has no latest time", async () => {
  await withScratch(async (scratch) => {
    const backupDir = path.join(scratch, "backups");
    await fs.mkdir(backupDir, { recursive: true });
    const auto = await loadAutoBackup();
    const now = new Date("2026-10-03T12:00:00.000Z");
    assert.equal(await auto.getLatestAutoBackupTime(backupDir), null);
    assert.equal(await auto.shouldRunAutoBackup(backupDir, now), true);
    assert.equal(await auto.rotateAutoBackups(backupDir, 3), 0);
    assert.match(auto.buildAutoBackupFileName(now), /^OpenFix-backup-\d{8}-\d{6}\.tar\.gz$/);
  });
});

test("unreadable backup paths tolerate scan errors", async () => {
  await withScratch(async (scratch) => {
    const auto = await loadAutoBackup();
    const now = new Date("2026-10-03T12:00:00.000Z");
    const missing = path.join(scratch, "missing");
    const notADirectory = path.join(scratch, "file.txt");
    await fs.writeFile(notADirectory, "not a directory\n");
    for (const target of [missing, notADirectory]) {
      assert.equal(await auto.getLatestAutoBackupTime(target), null);
      assert.equal(await auto.shouldRunAutoBackup(target, now), true);
      assert.equal(await auto.rotateAutoBackups(target, 1), 0);
    }
  });
});

test("the daily interval uses ordinary archive modification time", async () => {
  await withScratch(async (scratch) => {
    const auto = await loadAutoBackup();
    const now = new Date("2026-10-03T12:00:00.000Z");
    const freshDir = path.join(scratch, "fresh");
    const boundaryDir = path.join(scratch, "boundary");
    const almostDir = path.join(scratch, "almost");
    await Promise.all([freshDir, boundaryDir, almostDir].map((dir) => fs.mkdir(dir, { recursive: true })));
    await writeArchive(freshDir, archiveName("20261003-115900"), new Date(now.getTime() - 60_000));
    await writeArchive(boundaryDir, archiveName("20261002-120000"), new Date(now.getTime() - DAY_MS));
    await writeArchive(almostDir, archiveName("20261002-115900"), new Date(now.getTime() - DAY_MS + 60_000));

    assert.equal(await auto.shouldRunAutoBackup(freshDir, now), false);
    assert.equal(await auto.shouldRunAutoBackup(boundaryDir, now), true);
    assert.equal(await auto.shouldRunAutoBackup(almostDir, now), false);
  });
});

test("matching directories and junctions are ignored, never followed or removed", async () => {
  await withScratch(async (scratch, owned) => {
    const auto = await loadAutoBackup();
    const backupDir = path.join(scratch, "backups");
    const linkTarget = path.join(scratch, "link-target");
    await Promise.all([fs.mkdir(backupDir, { recursive: true }), fs.mkdir(linkTarget, { recursive: true })]);
    const sentinel = path.join(linkTarget, "sentinel.txt");
    await fs.writeFile(sentinel, "keep me\n");

    const directoryName = archiveName("20200101-000000");
    const junctionName = archiveName("19990101-000000");
    await fs.mkdir(path.join(backupDir, directoryName));
    const future = new Date(Date.now() + 10 * DAY_MS);
    await fs.utimes(path.join(backupDir, directoryName), future, future);
    const junctionPath = path.join(backupDir, junctionName);
    await registerDirectoryLink(owned, linkTarget, junctionPath);
    await fs.writeFile(path.join(backupDir, "notes.txt"), "unrelated\n");
    await fs.writeFile(path.join(backupDir, `${PREFIX}notes.txt`), "unrelated\n");

    const now = new Date("2026-10-03T12:00:00.000Z");
    assert.equal(await auto.getLatestAutoBackupTime(backupDir), null);
    assert.equal(await auto.shouldRunAutoBackup(backupDir, now), true);
    assert.equal(await auto.rotateAutoBackups(backupDir, 0), 0);

    assert.ok((await fs.lstat(path.join(backupDir, directoryName))).isDirectory());
    assert.equal((await fs.lstat(path.join(backupDir, junctionName))).isSymbolicLink(), true);
    assert.equal(await fs.readFile(sentinel, "utf8"), "keep me\n");
  });
});

test("rotation keeps the newest ordinary archives and preserves non-ordinary entries", async () => {
  await withScratch(async (scratch, owned) => {
    const auto = await loadAutoBackup();
    const backupDir = path.join(scratch, "backups");
    const linkTarget = path.join(scratch, "link-target");
    await Promise.all([fs.mkdir(backupDir, { recursive: true }), fs.mkdir(linkTarget, { recursive: true })]);
    const base = new Date("2026-09-01T00:00:00.000Z").getTime();
    const stamps = ["20260901-000000", "20260902-000000", "20260903-000000", "20260904-000000"];
    for (const [index, stamp] of stamps.entries()) {
      const mtime = new Date(base + index * DAY_MS);
      await writeArchive(backupDir, archiveName(stamp), mtime);
    }
    const directoryName = archiveName("20260905-000000");
    const junctionName = archiveName("20260906-000000");
    await fs.mkdir(path.join(backupDir, directoryName));
    await registerDirectoryLink(owned, linkTarget, path.join(backupDir, junctionName));

    assert.equal(await auto.rotateAutoBackups(backupDir, 2), 2);
    const remaining = (await fs.readdir(backupDir)).sort();
    const expected = [
      archiveName("20260903-000000"), archiveName("20260904-000000"), directoryName, junctionName,
    ].sort();
    assert.deepEqual(remaining, expected);
    assert.equal((await fs.lstat(path.join(backupDir, junctionName))).isSymbolicLink(), true);
  });
});

test("a matching directory does not consume a retention slot", async () => {
  await withScratch(async (scratch) => {
    const auto = await loadAutoBackup();
    const backupDir = path.join(scratch, "backups");
    await fs.mkdir(backupDir, { recursive: true });
    const ordinaryName = archiveName("20260101-000000");
    const directoryName = archiveName("20260102-000000");
    await writeArchive(backupDir, ordinaryName, new Date("2026-01-01T00:00:00.000Z"));
    await fs.mkdir(path.join(backupDir, directoryName));
    const future = new Date(Date.now() + 10 * DAY_MS);
    await fs.utimes(path.join(backupDir, directoryName), future, future);

    assert.equal(await auto.rotateAutoBackups(backupDir, 1), 0);
    assert.ok((await fs.lstat(path.join(backupDir, ordinaryName))).isFile());
    assert.ok((await fs.lstat(path.join(backupDir, directoryName))).isDirectory());
  });
});
