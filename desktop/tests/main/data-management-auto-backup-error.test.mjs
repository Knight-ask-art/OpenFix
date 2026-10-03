// The actual data management page auto backup handlers are AST-extracted from page.tsx and executed
// against a synthetic desktop bridge: a rejected directory must surface the existing localized error
// and must never reach the page state, while a safe directory still saves and clears the stored
// automatic failure. The rendered failure surface and the locale strings are checked as source facts.
// No renderer, filesystem, i18n runtime or Electron access. Run with node --test.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const pagePath = path.join(repoRoot, "desktop/src/ui/pages/data-management/page.tsx");
const SAVE_FAILED_KEY = "desktop.data.autoBackup.saveFailed";
const REJECTION = "备份目录不能与数据目录相同、位于数据目录内部或包含数据目录，请选择数据目录之外的目录";
// Exact whitelist: only the existing auto backup save owner and its picker caller are lifted.
const HANDLERS = ["saveAutoBackup", "handleAutoBackupDirPick", "handleAutoBackupToggle"];

async function createHandlers({ autoBackup, selectDirectory = async () => null, saveConfig = async () => {} }) {
  const ts = require("typescript");
  const source = await fs.readFile(pagePath, "utf8");
  const sourceFile = ts.createSourceFile(pagePath, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const snippets = new Map();
  const visit = (node) => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
      const [declaration] = node.declarationList.declarations;
      if (ts.isIdentifier(declaration.name) && HANDLERS.includes(declaration.name.text)) {
        snippets.set(declaration.name.text, node.getText(sourceFile));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const name of HANDLERS) assert.ok(snippets.has(name), `page.tsx must still define ${name}`);
  const combined = [
    ...HANDLERS.map((name) => snippets.get(name)),
    ...HANDLERS.map((name) => `exports.${name} = ${name};`),
  ].join("\n");
  const outputText = ts.transpileModule(combined, {
    fileName: "data-management-auto-backup-handlers.tsx",
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;

  const calls = { saved: [], autoBackup: [], errors: [], notices: [], autoBackupErrors: [], keys: [], configChanged: 0 };
  const desktopApi = {
    getConfig: async () => ({ activeInstanceId: "inst-local", instances: [] }),
    saveConfig: async (config) => saveConfig(config, calls),
    selectDirectory: async () => selectDirectory(calls),
  };
  const moduleObject = { exports: {} };
  const factory = new Function(
    "exports", "module", "window", "t", "autoBackup", "setAutoBackup", "setError", "setNotice",
    "setAutoBackupError", "onConfigChanged",
    outputText,
  );
  factory(
    moduleObject.exports,
    moduleObject,
    { openficDesktop: desktopApi },
    // 真实实现走 i18n；这里记录 key 与插值，用来证明提示文案来自 i18n 而不是新硬编码字符串。
    (key, options) => {
      calls.keys.push(key);
      return `${key}|${options?.message ?? ""}`;
    },
    autoBackup,
    (next) => calls.autoBackup.push(next),
    (next) => calls.errors.push(next),
    (next) => calls.notices.push(next),
    (next) => calls.autoBackupErrors.push(next),
    () => { calls.configChanged += 1; },
  );
  return { calls, handlers: moduleObject.exports };
}

test("a rejected auto backup directory shows the localized error and is not persisted", async () => {
  const handler = await createHandlers({
    autoBackup: { enabled: true, dir: "D:/exports/backups", keep: 3 },
    selectDirectory: async () => "D:/data/backups",
    saveConfig: async (config, calls) => {
      calls.saved.push(config);
      throw new Error(REJECTION);
    },
  });

  await handler.handlers.handleAutoBackupDirPick();

  assert.equal(handler.calls.saved.length, 1, "The picker must attempt to store the chosen directory");
  assert.equal(handler.calls.saved[0].autoBackup.dir, "D:/data/backups");
  assert.deepEqual(handler.calls.autoBackup, [], "A rejected directory must not reach the page state");
  assert.equal(handler.calls.configChanged, 0, "A rejected directory must not reload the config");
  assert.deepEqual(handler.calls.keys, [SAVE_FAILED_KEY], "The visible message must come from i18n");
  assert.equal(handler.calls.errors.length, 2, "The previous error is cleared and the rejection shown");
  assert.equal(handler.calls.errors[0], null);
  assert.ok(handler.calls.errors[1].startsWith(`${SAVE_FAILED_KEY}|`));
  assert.ok(handler.calls.errors[1].includes(REJECTION), "The rejection reason must stay visible");
  assert.deepEqual(
    handler.calls.autoBackupErrors,
    [],
    "A rejected directory must not clear a stored automatic failure",
  );
});

test("a rejected directory on the enable toggle shows the same error and is not persisted", async () => {
  const handler = await createHandlers({
    autoBackup: { enabled: false, dir: "D:/data/backups", keep: 3 },
    saveConfig: async (config, calls) => {
      calls.saved.push(config);
      throw new Error(REJECTION);
    },
  });

  await handler.handlers.handleAutoBackupToggle(true);

  assert.equal(handler.calls.saved.length, 1);
  assert.equal(handler.calls.saved[0].autoBackup.enabled, true);
  assert.deepEqual(handler.calls.autoBackup, [], "A rejected save must not reach the page state");
  assert.equal(handler.calls.configChanged, 0);
  assert.equal(handler.calls.errors.length, 2);
  assert.ok(handler.calls.errors[1].includes(REJECTION));
  assert.deepEqual(handler.calls.autoBackupErrors, [], "A rejected enable must not clear a stored failure");
});

test("a safe auto backup directory is saved and clears the previous error", async () => {
  const handler = await createHandlers({
    autoBackup: { enabled: false, dir: "D:/exports/backups", keep: 3 },
    selectDirectory: async () => "D:/exports/daily",
    saveConfig: async (config, calls) => { calls.saved.push(config); },
  });

  await handler.handlers.handleAutoBackupDirPick();

  assert.equal(handler.calls.saved.length, 1);
  assert.deepEqual(handler.calls.autoBackup, [{ enabled: false, dir: "D:/exports/daily", keep: 3 }]);
  assert.equal(handler.calls.configChanged, 1);
  assert.deepEqual(handler.calls.errors, [null]);
  assert.deepEqual(handler.calls.autoBackupErrors, [null], "The stored failure of the old directory must go");
  assert.deepEqual(handler.calls.keys, [], "A successful save must not raise a localized error");
});

test("a cancelled directory pick never saves", async () => {
  const handler = await createHandlers({
    autoBackup: { enabled: true, dir: "D:/exports/backups", keep: 3 },
    selectDirectory: async () => null,
  });

  await handler.handlers.handleAutoBackupDirPick();

  assert.deepEqual(handler.calls.saved, []);
  assert.deepEqual(handler.calls.autoBackup, []);
  assert.deepEqual(handler.calls.errors, []);
  assert.deepEqual(handler.calls.notices, []);
});

// 主进程只在重新校验过备份目录时清除失败记录，页面必须按同一条件清除。
test("a corrected destination clears the stored automatic failure", async () => {
  const handler = await createHandlers({
    autoBackup: { enabled: true, dir: "D:/data/backups", keep: 3 },
    saveConfig: async (config, calls) => { calls.saved.push(config); },
  });

  await handler.handlers.saveAutoBackup({ enabled: true, dir: "D:/exports/daily", keep: 3 });

  assert.deepEqual(handler.calls.autoBackupErrors, [null], "A verified destination must clear the failure");
  assert.equal(handler.calls.configChanged, 1);
});

test("re-enabling the same destination clears the stored automatic failure", async () => {
  const handler = await createHandlers({
    autoBackup: { enabled: false, dir: "D:/exports/daily", keep: 3 },
    saveConfig: async (config, calls) => { calls.saved.push(config); },
  });

  await handler.handlers.saveAutoBackup({ enabled: true, dir: "D:/exports/daily", keep: 3 });

  assert.deepEqual(handler.calls.autoBackupErrors, [null], "Re-enabling re-runs admission and clears the failure");
});

test("a retention-only change keeps the stored automatic failure", async () => {
  const handler = await createHandlers({
    autoBackup: { enabled: true, dir: "D:/data/backups", keep: 3 },
    saveConfig: async (config, calls) => { calls.saved.push(config); },
  });

  await handler.handlers.saveAutoBackup({ enabled: true, dir: "D:/data/backups", keep: 5 });

  assert.deepEqual(handler.calls.autoBackup, [{ enabled: true, dir: "D:/data/backups", keep: 5 }]);
  assert.deepEqual(
    handler.calls.autoBackupErrors,
    [],
    "An unchanged destination is not re-validated, so a standing failure must stay visible",
  );
});

test("disabling automatic backup clears the stored failure surface", async () => {
  const handler = await createHandlers({
    autoBackup: { enabled: true, dir: "D:/data/backups", keep: 3 },
    saveConfig: async (config, calls) => { calls.saved.push(config); },
  });

  await handler.handlers.saveAutoBackup({ enabled: false, dir: "D:/data/backups", keep: 3 });

  assert.deepEqual(handler.calls.autoBackupErrors, [null], "A disabled feature has no failure to show");
});

// 状态被写入还不够：错误变量必须仍然渲染在既有的错误提示里，用户才看得到。
test("the page still renders the error state in the existing error alert", async () => {
  const ts = require("typescript");
  const source = await fs.readFile(pagePath, "utf8");
  const sourceFile = ts.createSourceFile(pagePath, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const rendered = new Set();
  const visit = (node) => {
    if (ts.isJsxExpression(node) && node.expression && ts.isIdentifier(node.expression)) {
      rendered.add(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  assert.ok(rendered.has("error"), "The data page must render its error state");
  assert.ok(source.includes("data-alert-error"), "The error state must keep the existing alert surface");
});

// 定时备份的失败必须渲染出来，并且常驻监听自动备份的终态事件，用户才可能在离开页面之前看到它。
test("the page renders the stored automatic failure and listens for automatic progress", async () => {
  const source = await fs.readFile(pagePath, "utf8");

  assert.ok(
    /autoBackupError \? \(/.test(source),
    "The stored automatic failure must be rendered conditionally",
  );
  assert.ok(
    source.includes('t("desktop.data.autoBackup.failed"'),
    "The visible failure message must come from i18n",
  );
  assert.ok(
    source.includes("event.automatic"),
    "The progress listener must distinguish automatic backups from manual operations",
  );
});

test("both locales define the automatic backup failure strings without emoji", async () => {
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}]/u;
  for (const locale of ["en.json", "zh-CN.json"]) {
    const messages = JSON.parse(
      await fs.readFile(path.join(repoRoot, "desktop/src/ui/locales", locale), "utf8"),
    );
    // 原始语言文件只按 data 分组；`desktop.` 是 i18n 运行时挂载的命名空间前缀，不存在于 JSON 里。
    const autoBackup = messages.data.autoBackup;
    for (const key of ["failed", "failedNoDetail"]) {
      assert.equal(typeof autoBackup[key], "string", `${locale} must define autoBackup.${key}`);
      assert.equal(emoji.test(autoBackup[key]), false, `${locale} autoBackup.${key} must not use emoji`);
    }
    assert.ok(
      autoBackup.failed.includes("{{message}}"),
      `${locale} must interpolate the failure reason`,
    );
  }
});
