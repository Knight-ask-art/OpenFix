import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { backupDataDir, getDataOperationOptions, restoreDataDir } from "../../dist/main/data-manager.js";

async function seed(root, relative, content) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content);
}

test("live session network/locks are excluded, while SQLite, credentials and IndexedDB drafts round-trip", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfix-profile-backup-"));
  try {
    const source = path.join(base, "profile");
    const partition = "Partitions/openfic-instance-test";
    const retained = {
      "openfic.db": "synthetic novel database",
      ".key": "synthetic local encryption marker",
      "covers/Network": "a user asset called Network",
      "covers/LOCK": "a user asset called LOCK",
      "notes/IndexedDB/example.leveldb/LOCK": "user material outside the browser layout",
      [`${partition}/IndexedDB/app.leveldb/000003.log`]: "pending writing and prompt drafts",
      [`${partition}/IndexedDB/app.leveldb/CURRENT`]: "MANIFEST-000001",
      [`${partition}/Local Storage/leveldb/000003.log`]: "user preferences",
      "Partitions/foreign-project/Network/Cookies": "unrelated user directory",
    };
    const excluded = ["Network/Cookies", "Cookies", `${partition}/Network/Cookies`,
      `${partition}/IndexedDB/app.leveldb/LOCK`, `${partition}/Local Storage/leveldb/LOCK`];
    for (const [name, content] of Object.entries(retained)) await seed(source, name, content);
    for (const name of excluded) await seed(source, name, "browser transient state");
    await seed(source, "runtime/python/python.exe", "app runtime");
    const options = await getDataOperationOptions(source, path.join(source, "runtime"), source);
    const archive = path.join(base, "backup.tar.gz");
    await backupDataDir(source, archive, undefined, undefined, options.backup);
    const restored = path.join(base, "restored");
    await restoreDataDir(archive, restored);
    for (const [name, content] of Object.entries(retained)) {
      assert.equal(await readFile(path.join(restored, name), "utf8"), content, name);
      assert.equal(await readFile(path.join(source, name), "utf8"), content, "Original data must remain intact");
    }
    for (const name of [...excluded, "runtime"]) await assert.rejects(stat(path.join(restored, name)), /ENOENT/);
    assert.ok((await stat(archive)).size > 0);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("custom data folders never lose user content named Network or LOCK", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfix-profile-backup-"));
  try {
    const source = path.join(base, "custom-data");
    const session = path.join(base, "browser-profile");
    await seed(source, "Network/Cookies", "user-owned material");
    await seed(source, "Partitions/openfic-custom/IndexedDB/user.leveldb/LOCK", "user-owned lock-named material");
    const options = await getDataOperationOptions(source, path.join(base, "runtime"), session);
    assert.deepEqual(options, { backup: {}, restore: {} });
    const archive = path.join(base, "backup.tar.gz");
    await backupDataDir(source, archive, undefined, undefined, options.backup);
    const restored = path.join(base, "restored");
    await restoreDataDir(archive, restored);
    assert.equal(await readFile(path.join(restored, "Network/Cookies"), "utf8"), "user-owned material");
    assert.equal(await readFile(path.join(restored, "Partitions/openfic-custom/IndexedDB/user.leveldb/LOCK"), "utf8"), "user-owned lock-named material");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a nested canonical session root is scoped exactly and its siblings are retained", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "openfix-profile-backup-"));
  try {
    const source = path.join(base, "data");
    const session = path.join(source, "browser");
    await seed(source, "browser/Network/Cookies", "transient");
    await seed(source, "browser-other/Network/Cookies", "user material");
    await seed(source, "openfic.db", "novel");
    const options = await getDataOperationOptions(source, path.join(base, "runtime"), session);
    const archive = path.join(base, "backup.tar.gz");
    await backupDataDir(source, archive, undefined, undefined, options.backup);
    const restored = path.join(base, "restored");
    await restoreDataDir(archive, restored);
    await assert.rejects(stat(path.join(restored, "browser/Network/Cookies")), /ENOENT/);
    assert.equal(await readFile(path.join(restored, "browser-other/Network/Cookies"), "utf8"), "user material");
    assert.equal(await readFile(path.join(restored, "openfic.db"), "utf8"), "novel");
  } finally { await rm(base, { recursive: true, force: true }); }
});
