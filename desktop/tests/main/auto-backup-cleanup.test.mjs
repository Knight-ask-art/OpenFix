// Executes the actual AST-extracted cleanup helpers from the three backup suites over a strict
// virtual filesystem: zero real writes or deletes. Verifies once-only scratch removal, refusal of
// unknown links, scratch identity replacement, and registered junction target replacement/retarget.
// Run after build:main with node --experimental-vm-modules --test.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const tmpRoot = path.join(repoRoot, "tmp");
const testsDir = path.join(repoRoot, "desktop/tests/main");
const ts = require("typescript");

// Exact whitelist per suite: only the real cleanup helpers are lifted, nothing else.
const SUITES = [
  {
    file: "auto-backup.test.mjs",
    helpers: ["within", "samePath", "requireUnlinked", "inspectOwnedTree", "unlinkOwnedLinks", "closeScratch"],
  },
  {
    file: "auto-backup-ipc.test.mjs",
    helpers: ["within", "samePath", "requireUnlinked", "inspectOwnedTree", "closeScratch"],
  },
  {
    file: "auto-backup-config.test.mjs",
    helpers: ["within", "samePath", "requireUnlinked", "inspectOwnedTree", "closeScratch"],
  },
];

// TypeScript AST extraction of the real functions; no regex or textual rewriting of the suites.
async function extractCloseScratch(suite) {
  const filename = path.join(testsDir, suite.file);
  const source = await readFile(filename, "utf8");
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const snippets = new Map();
  for (const node of ast.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && suite.helpers.includes(node.name.text)) {
      assert.equal(snippets.has(node.name.text), false, `Duplicate ${node.name.text} in ${suite.file}`);
      snippets.set(node.name.text, node.getText(ast));
    }
  }
  for (const name of suite.helpers) assert.ok(snippets.has(name), `${suite.file} must define ${name}`);
  return [...suite.helpers.map((name) => snippets.get(name)), "module.exports = { closeScratch };"].join("\n");
}

const sources = new Map();
async function loadSource(suite) {
  if (!sources.has(suite.file)) sources.set(suite.file, await extractCloseScratch(suite));
  return sources.get(suite.file);
}

const virtualScratch = path.join(tmpRoot, "openfix-auto-backup-cleanup-virtual");

function baseKinds() {
  return { [repoRoot]: "dir", [tmpRoot]: "dir", [virtualScratch]: "dir" };
}

function ownedScratch(links = []) {
  return { root: virtualScratch, dev: 1, ino: 3, links };
}

function normalCase() {
  const sub = path.join(virtualScratch, "sub");
  return {
    paths: { sub },
    kinds: {
      ...baseKinds(),
      [sub]: "dir",
      [path.join(virtualScratch, "sentinel.txt")]: "file",
      [path.join(sub, "nested.txt")]: "file",
    },
    idents: new Map([[virtualScratch, { dev: 1, ino: 3 }]]),
    owned: ownedScratch(),
  };
}

function unknownLinkCase() {
  const target = path.join(virtualScratch, "real-target");
  const link = path.join(virtualScratch, "mystery-link");
  return {
    paths: { target, link },
    kinds: { ...baseKinds(), [target]: "dir", [link]: "link" },
    links: new Map([[link, target]]),
    idents: new Map([[virtualScratch, { dev: 1, ino: 3 }]]),
    owned: ownedScratch(),
  };
}

function junctionCase({ retargetTo = null, targetIno = 21 } = {}) {
  const backupDir = path.join(virtualScratch, "backups");
  const linkTarget = path.join(virtualScratch, "link-target");
  const junction = path.join(backupDir, "junction");
  return {
    paths: { backupDir, linkTarget, junction },
    kinds: {
      ...baseKinds(),
      [backupDir]: "dir",
      [linkTarget]: "dir",
      [junction]: "link",
      [path.join(backupDir, "archive.txt")]: "file",
      [path.join(linkTarget, "sentinel.txt")]: "file",
    },
    links: new Map([[junction, linkTarget]]),
    realpaths: retargetTo ? new Map([[junction, retargetTo]]) : new Map(),
    idents: new Map([
      [virtualScratch, { dev: 1, ino: 3 }],
      [junction, { dev: 1, ino: 20 }],
      [linkTarget, { dev: 1, ino: targetIno }],
    ]),
    owned: ownedScratch([
      { linkPath: junction, target: linkTarget, dev: 1, ino: 20, targetDev: 1, targetIno: 21 },
    ]),
  };
}

// Strict virtual filesystem: every call must name a declared path or fail visibly with EVIRTUAL.
async function executeCleanup(source, spec) {
  const kinds = spec.kinds;
  const links = spec.links ?? new Map();
  const realpaths = spec.realpaths ?? new Map();
  const idents = spec.idents ?? new Map();
  const present = new Set(Object.keys(kinds));
  const removed = [];
  const missing = (target) => Object.assign(new Error(`Synthetic ENOENT: ${target}`), { code: "ENOENT" });
  const requirePresent = (operation, target) => {
    if (!Object.hasOwn(kinds, target)) {
      throw Object.assign(new Error(`Unknown virtual ${operation}: ${target}`), { code: "EVIRTUAL" });
    }
    if (!present.has(target)) throw missing(target);
  };
  const infoOf = (target) => {
    const kind = kinds[target];
    const ident = idents.get(target) ?? { dev: 1, ino: 0 };
    return {
      dev: ident.dev,
      ino: ident.ino,
      isSymbolicLink: () => kind === "link",
      isDirectory: () => kind === "dir",
      isFile: () => kind === "file",
    };
  };
  const fs = {
    lstat: async (target) => { requirePresent("lstat", target); return infoOf(target); },
    realpath: async (target) => {
      requirePresent("realpath", target);
      return kinds[target] === "link" ? (realpaths.get(target) ?? links.get(target)) : target;
    },
    readdir: async (target) => {
      requirePresent("readdir", target);
      assert.equal(kinds[target], "dir", `readdir on a non-directory: ${target}`);
      return [...present]
        .filter((entry) => path.dirname(entry) === target)
        .map((entry) => path.basename(entry))
        .sort();
    },
    unlink: async (target) => {
      requirePresent("unlink", target);
      assert.ok(kinds[target] === "file" || kinds[target] === "link", `unlink on a directory: ${target}`);
      present.delete(target);
      removed.push({ kind: kinds[target], path: target });
    },
    rmdir: async (target) => {
      requirePresent("rmdir", target);
      assert.equal(kinds[target], "dir", `rmdir on a non-directory: ${target}`);
      assert.deepEqual(
        [...present].filter((entry) => path.dirname(entry) === target),
        [],
        `rmdir on a non-empty directory: ${target}`,
      );
      present.delete(target);
      removed.push({ kind: "dir", path: target });
    },
  };
  const context = vm.createContext({
    assert, fs, path, process: { platform: process.platform }, repoRoot, tmpRoot, module: { exports: {} },
  });
  new vm.Script(source).runInContext(context);
  const closeScratch = context.module.exports.closeScratch;
  assert.equal(typeof closeScratch, "function", "The extracted closeScratch must be exported");
  let error = null;
  try {
    await closeScratch(spec.owned);
  } catch (caught) {
    error = caught;
  }
  return { error, removed, present };
}

for (const suite of SUITES) {
  test(`${suite.file}: virtual cleanup removes the scratch root exactly once`, async () => {
    const spec = normalCase();
    const { error, removed, present } = await executeCleanup(await loadSource(suite), spec);
    assert.equal(error, null, `Unexpected cleanup error: ${error?.message}`);
    const dirs = removed.filter((entry) => entry.kind === "dir").map((entry) => entry.path);
    assert.deepEqual(dirs.slice().sort(), [virtualScratch, spec.paths.sub].sort());
    assert.equal(dirs.filter((entry) => entry === virtualScratch).length, 1, "Scratch must be removed once");
    assert.equal(removed.filter((entry) => entry.kind === "file").length, 2, "Every owned file must be removed");
    assert.equal(present.has(virtualScratch), false, "The owned scratch must be gone");
    assert.ok(present.has(repoRoot) && present.has(tmpRoot), "Shared roots must survive");
  });

  test(`${suite.file}: an unknown link aborts before any deletion`, async () => {
    const { error, removed } = await executeCleanup(await loadSource(suite), unknownLinkCase());
    assert.ok(error, "An unknown link must abort cleanup");
    assert.notEqual(error.code, "EVIRTUAL", "An undeclared path escaped the strict filesystem");
    assert.match(error.message, /Refuse (unknown link|linked path)/);
    assert.equal(removed.length, 0, "Nothing may be deleted before the tree is fully validated");
  });

  test(`${suite.file}: a replaced scratch identity aborts before any deletion`, async () => {
    for (const ident of [{ dev: 2, ino: 3 }, { dev: 1, ino: 99 }]) {
      const spec = normalCase();
      spec.idents.set(virtualScratch, ident);
      const { error, removed } = await executeCleanup(await loadSource(suite), spec);
      assert.ok(error, "A replaced scratch identity must abort cleanup");
      assert.notEqual(error.code, "EVIRTUAL", "An undeclared path escaped the strict filesystem");
      assert.match(error.message, /Scratch (device|inode) changed/);
      assert.equal(removed.length, 0, "Nothing may be deleted after a failed identity check");
    }
  });
}

const helperSuite = SUITES[0];

test(`${helperSuite.file}: a retargeted known junction aborts before any deletion`, async () => {
  const spec = junctionCase({ retargetTo: path.join(virtualScratch, "elsewhere") });
  const { error, removed } = await executeCleanup(await loadSource(helperSuite), spec);
  assert.ok(error, "A retargeted junction must abort cleanup");
  assert.notEqual(error.code, "EVIRTUAL", "An undeclared path escaped the strict filesystem");
  assert.match(error.message, /Registered link retargeted/);
  assert.equal(removed.length, 0, "Nothing may be deleted before the registered link is verified");
});

test(`${helperSuite.file}: a replaced junction target aborts before any deletion`, async () => {
  const spec = junctionCase({ targetIno: 99 });
  const { error, removed } = await executeCleanup(await loadSource(helperSuite), spec);
  assert.ok(error, "A replaced junction target must abort cleanup");
  assert.notEqual(error.code, "EVIRTUAL", "An undeclared path escaped the strict filesystem");
  assert.match(error.message, /Registered link target inode changed/);
  assert.equal(removed.length, 0, "Nothing may be deleted before the link target is verified");
});
