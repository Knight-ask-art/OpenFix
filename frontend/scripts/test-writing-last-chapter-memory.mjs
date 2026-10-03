/**
 * 记忆章节（最后访问章节）恢复的源码级回归（Node 运行，不启动浏览器、不访问网络、不读写真实数据库）。
 * 用 AST 从真实源码提取并原样执行写作页的 loadLastChapter 初始化回调与最后访问章节生产者回调，并把
 * src/lib/local-db.ts 真实的 getLastChapterId / setLastChapterId 绑定到只提供 projectLastChapters
 * .get/put 的内存接缝上，形成真实读写链路；不复制修复逻辑，也不复制归一化策略。
 * 覆盖：原始 / 带 "chapter:" 前缀记忆的桌面与移动端恢复、第一章与记住章节不同、只剥离一次前缀、空
 * 前缀、note / empty / 无效 / 缺失记忆、空章节树、未知（加载中 / 未定义）树、已存在标签页、规范生
 * 产者写入与 note / 空 / 无活动跳过、项目绑定、真实依赖数组与 14 接缝；反向用例撤回读取归一化与生产
 * 者写入，复原修复前的 tab-id/chapter-id 不匹配。所有数据均为合成值。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = path.resolve(here, "../src/features/writing/pages/writing-page.tsx");
const DB_PATH = path.resolve(here, "../src/lib/local-db.ts");
const pageSource = await readFile(PAGE_PATH, "utf8");
const dbSource = await readFile(DB_PATH, "utf8");
const pageFile = ts.createSourceFile("writing-page.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const dbFile = ts.createSourceFile("local-db.ts", dbSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

let checks = 0;
let failures = 0;

/** 记录一次严格深度相等断言。 */
function same(label, actual, expected) {
  checks += 1;
  if (isDeepStrictEqual(actual, expected)) return;
  failures += 1;
  console.error(`FAIL ${label}`);
  console.error(`  expected ${JSON.stringify(expected)}`);
  console.error(`  actual   ${JSON.stringify(actual)}`);
}

/** 记录一次布尔断言。 */
function record(ok, label, detail) {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
}

/** 前置条件：提取失败时立即终止，因为没有可执行的接缝。 */
function requireExtraction(value, message) {
  if (!value) {
    console.error(`FAIL ${message}`);
    process.exit(1);
  }
  return value;
}

const normalize = (text) => text.replace(/\s+/g, " ").trim();

/** 深度优先查找第一个满足 predicate 的节点。 */
function findNode(node, predicate) {
  let found = null;
  const visit = (current) => {
    if (found) return;
    if (predicate(current)) {
      found = current;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

// ============================================================
// 1. 提取两个真实 useEffect 回调、依赖数组与守卫
// ============================================================

/** 查找第一个实参文本含 marker、且不含 excludeMarker 的 useEffect 调用。 */
function findEffects(file, marker, excludeMarker) {
  const matches = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "useEffect" && node.arguments[0]) {
      const text = node.arguments[0].getText(file);
      if (text.includes(marker) && !(excludeMarker && text.includes(excludeMarker))) matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return matches;
}

const initializerCalls = findEffects(pageFile, "const loadLastChapter = async");
const producerCalls = findEffects(pageFile, "setLastChapterId(", "const loadLastChapter = async");
requireExtraction(
  initializerCalls.length === 1 && producerCalls.length === 1,
  `expected one initializer and one producer effect, found ${initializerCalls.length} / ${producerCalls.length}`,
);

const initializerCall = initializerCalls[0];
const producerCall = producerCalls[0];
requireExtraction(
  ts.isArrowFunction(initializerCall.arguments[0]) && ts.isArrowFunction(producerCall.arguments[0]),
  "the extracted effects are not arrow callbacks",
);
const initializerText = initializerCall.arguments[0].getText(pageFile);
const producerText = producerCall.arguments[0].getText(pageFile);

/** 读取一个 useEffect 第二个实参的依赖名字。 */
function dependencyNames(file, call, label) {
  const list = requireExtraction(call.arguments[1], `${label} has no dependency array`);
  requireExtraction(ts.isArrayLiteralExpression(list), `${label} dependency is not an array`);
  return list.elements.map((element) => element.getText(file));
}

same("the initializer keeps the chapter-tree readiness dependencies", dependencyNames(pageFile, initializerCall, "initializer"), [
  "activeTabId", "allChapters", "chaptersData", "isChaptersLoading", "isMobile", "isTabsLoaded",
  "openSingleTab", "openTab", "projectId", "tabs.length",
]);
same("the producer depends on the canonical chapter inputs", dependencyNames(pageFile, producerCall, "producer"), ["projectId", "currentChapterId"]);

const guard = requireExtraction(
  findNode(initializerCall.arguments[0], (node) => ts.isIfStatement(node) && node.expression.getText(pageFile).includes("hasInitialized.current")),
  "the initialization guard was not found",
);
same(
  "the initialization guard still requires a ready chapter tree",
  normalize(guard.expression.getText(pageFile)),
  "!projectId || !isTabsLoaded || isChaptersLoading || !chaptersData || hasInitialized.current",
);
record(!pageSource.includes("setLastChapterId(projectId, activeTabId)"), "retires the producer that persisted the prefixed tab id");

// ============================================================
// 2. 接缝集合：初始化回调的自由标识符必须仍是同 14 项
// ============================================================

/** 收集节点内引用的自由标识符（排除属性名与局部声明）。 */
function collectFreeIdentifiers(node) {
  const referenced = new Set();
  const declared = new Set();
  const visit = (current) => {
    if (ts.isIdentifier(current)) {
      const parent = current.parent;
      const isDeclarationName =
        (ts.isVariableDeclaration(parent) && parent.name === current) || (ts.isParameter(parent) && parent.name === current);
      const isMemberName =
        (ts.isPropertyAccessExpression(parent) && parent.name === current) ||
        (ts.isPropertyAssignment(parent) && parent.name === current) ||
        (ts.isPropertySignature(parent) && parent.name === current);
      if (!isDeclarationName && !isMemberName) referenced.add(current.text);
      return;
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) declared.add(current.name.text);
    if (ts.isParameter(current) && ts.isIdentifier(current.name)) declared.add(current.name.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return [...referenced].filter((name) => !declared.has(name));
}

/** 初始化回调的 14 个自由接缝（与既有初始化回归保持一致）。 */
const INITIALIZER_SEAMS = [
  "activeTabId", "allChapters", "chaptersData", "getLastChapterId", "hasInitialized", "isEmptyTab",
  "isChaptersLoading", "isMobile", "isTabsLoaded", "openSingleTab", "openTab", "projectId",
  "setInitialCurrentChapterNavigationKey", "tabs",
].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
same("the initializer seams are exactly the same 14 free identifiers", [...collectFreeIdentifiers(initializerCall.arguments[0])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), INITIALIZER_SEAMS);
same("the producer seams are only the canonical chapter inputs", [...collectFreeIdentifiers(producerCall.arguments[0])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), ["currentChapterId", "projectId", "setLastChapterId"]);

// ============================================================
// 3. 真实 local-db 读写：提取函数体并绑定内存 projectLastChapters
// ============================================================

const dbFunctions = dbFile.statements.filter(ts.isFunctionDeclaration).map((node) => node.getText(dbFile));

/** 唯一匹配包含 prefix 的 local-db 函数声明文本。 */
function uniqueFunction(prefix) {
  const found = dbFunctions.filter((text) => text.includes(prefix));
  requireExtraction(found.length === 1, `expected exactly one ${prefix} in local-db.ts`);
  return found[0];
}

const getterText = uniqueFunction("export async function getLastChapterId(");
const setterText = uniqueFunction("export async function setLastChapterId(");
record(getterText.includes("db.projectLastChapters.get(projectId)"), "the extracted reader is the real projectLastChapters getter");
record(setterText.includes("db.projectLastChapters.put("), "the extracted writer is the real projectLastChapters putter");

/** 转译为 ESM 并动态导入，供接缝注入使用。 */
async function importModule(source, label) {
  const { outputText, diagnostics } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  if (diagnostics && diagnostics.length > 0) {
    for (const diagnostic of diagnostics) console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    throw new Error(`${label}: transpile failed`);
  }
  return import(`data:text/javascript;base64,${Buffer.from(outputText, "utf8").toString("base64")}`);
}

function stripExport(text, label) {
  const stripped = text.replace(/\bexport\s+(?=async function)/, "");
  requireExtraction(stripped !== text, `${label} did not carry an export keyword`);
  return stripped;
}

const { createReader } = await importModule(
  `export function createReader(db) {\n${stripExport(getterText, "getter")}\n  return getLastChapterId;\n}\n`,
  "reader",
);
const { createWriter } = await importModule(
  `export function createWriter(db) {\n${stripExport(setterText, "setter")}\n  return setLastChapterId;\n}\n`,
  "writer",
);

/** 只暴露真实回调体引用的 projectLastChapters.get/put，其余状态一律不存在。 */
function createStore(initial = {}) {
  const records = new Map();
  for (const [projectId, chapterId] of Object.entries(initial)) records.set(projectId, { projectId, chapterId, updatedAt: new Date(0) });
  return {
    db: {
      projectLastChapters: {
        get: async (projectId) => records.get(projectId),
        put: async (value) => {
          records.set(value.projectId, value);
        },
      },
    },
    chapterIdFor: (projectId) => records.get(projectId)?.chapterId ?? null,
  };
}

// ============================================================
// 4. 把真实回调体包装成可注入自由变量的工厂与会话
// ============================================================

async function importEffectFactory(callbackText, parameterNames, label) {
  const module = await importModule(`export function createEffect(${parameterNames.join(", ")}) {\n  return ${callbackText};\n}\n`, label);
  return module.createEffect;
}

const createInitializer = await importEffectFactory(initializerText, INITIALIZER_SEAMS, "initializer");
const PRODUCER_SEAMS = ["projectId", "currentChapterId", "setLastChapterId"];
const createProducer = await importEffectFactory(producerText, PRODUCER_SEAMS, "producer");

const PROJECT_ID = "synthetic-project-a";
const OTHER_PROJECT_ID = "synthetic-project-b";
const FIRST_ID = "synthetic-first-chapter";
const REMEMBERED_ID = "synthetic-remembered-chapter";
const NOTE_ID = "synthetic-note";
const OTHER_REMEMBERED_ID = "synthetic-other-remembered-chapter";
const titleFor = (id) => `Synthetic ${id}`;

/** 与 useVolumeTree 消费形状一致的最小章节树。 */
function chapterTree(ids) {
  const chapters = ids.map((id, index) => ({ id, title: titleFor(id), order: index + 1 }));
  return {
    chaptersData: { volumes: [{ id: "synthetic-volume", chapters }] },
    allChapters: chapters.map(({ id, title }) => ({ id, title })),
  };
}

const READY_TREE = chapterTree([FIRST_ID, REMEMBERED_ID]);
const EMPTY_TREE = chapterTree([]);
const READY_INPUTS = { chaptersData: READY_TREE.chaptersData, allChapters: READY_TREE.allChapters };
const LOADING_TREE = { isChaptersLoading: true, chaptersData: undefined, allChapters: [] };
const UNDEFINED_TREE = { isChaptersLoading: false, chaptersData: undefined, allChapters: [] };

/** 刷新微任务队列：真实回调未 await loadLastChapter，因此需要一次事件循环。 */
async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 合成初始化会话：render() 生成一次回调实例，hasInitialized ref 与追踪数组跨渲染共享，与生产
 * useRef 语义一致；getLastChapterId 被包装以记录真实读取的 projectId。
 */
function createInitializerSession(effectFactory, overrides = {}) {
  const trace = { hasInitialized: { current: false }, opened: [], openedSingle: [], navigationKeys: [], reads: [] };
  const base = {
    projectId: PROJECT_ID,
    isTabsLoaded: true,
    isChaptersLoading: false,
    chaptersData: EMPTY_TREE.chaptersData,
    allChapters: EMPTY_TREE.allChapters,
    hasInitialized: trace.hasInitialized,
    tabs: [],
    activeTabId: null,
    isMobile: false,
    isEmptyTab: (tabId) => typeof tabId === "string" && tabId.startsWith("empty:"),
    getLastChapterId: async () => null,
    openTab: (id, title) => trace.opened.push({ id, title }),
    openSingleTab: (id, title) => trace.openedSingle.push({ id, title }),
    setInitialCurrentChapterNavigationKey: (key) => trace.navigationKeys.push(key),
    ...overrides,
  };
  return {
    render: (frame = {}) => {
      const environment = { ...base, ...frame };
      const read = environment.getLastChapterId;
      environment.getLastChapterId = async (projectId) => {
        trace.reads.push(projectId);
        return read(projectId);
      };
      return effectFactory(...INITIALIZER_SEAMS.map((name) => environment[name]));
    },
    snapshot: () => ({
      hasInitialized: trace.hasInitialized.current,
      opened: [...trace.opened],
      openedSingle: [...trace.openedSingle],
      navigationKeys: [...trace.navigationKeys],
      reads: [...trace.reads],
    }),
  };
}

/** 单次渲染 + 结算 + 快照。 */
async function runInitializer(overrides = {}, effectFactory = createInitializer) {
  const session = createInitializerSession(effectFactory, overrides);
  session.render()();
  await settle();
  return session.snapshot();
}

/** 执行一次真实生产者回调。 */
async function runProducer(store, overrides = {}) {
  const environment = { projectId: PROJECT_ID, currentChapterId: null, setLastChapterId: createWriter(store.db), ...overrides };
  createProducer(...PRODUCER_SEAMS.map((name) => environment[name]))();
  await settle();
}

const at = (id) => ({ id, title: titleFor(id) });
/** 快照构造器：默认「完成初始化、未打开任何章节、读取本合成项目」。 */
const snapshot = (overrides = {}) => ({ hasInitialized: true, opened: [], openedSingle: [], navigationKeys: [], reads: [PROJECT_ID], ...overrides });
const IDLE = { hasInitialized: false, opened: [], openedSingle: [], navigationKeys: [], reads: [] };
const DESKTOP_RESTORE = snapshot({ opened: [at(REMEMBERED_ID)] });
const MOBILE_RESTORE = snapshot({ openedSingle: [at(REMEMBERED_ID)] });
/** 读取成功但没有可打开的章节：完成初始化并重置导航键（桌面回退、空树、非章节记忆）。 */
const NO_OPEN = snapshot({ navigationKeys: [null] });
const MOBILE_FIRST = snapshot({ openedSingle: [at(FIRST_ID)] });

/** 用给定记忆值（null 表示无记录）构造真实读取器并跑一次就绪树初始化。 */
async function scenario(stored, isMobile, effectFactory = createInitializer) {
  const store = createStore(stored === null ? {} : { [PROJECT_ID]: stored });
  return runInitializer({ ...READY_INPUTS, getLastChapterId: createReader(store.db), isMobile }, effectFactory);
}

// ============================================================
// 5. 正向：旧版原始 / 前缀记忆在桌面与移动端的恢复
// ============================================================

for (const [name, stored] of [
  ["raw", REMEMBERED_ID],
  ["prefixed", `chapter:${REMEMBERED_ID}`],
]) {
  same(`a legacy ${name} memory restores the remembered chapter on desktop`, await scenario(stored, false), DESKTOP_RESTORE);
  same(`a legacy ${name} memory restores the remembered chapter on mobile`, await scenario(stored, true), MOBILE_RESTORE);
}
record(MOBILE_FIRST.openedSingle[0].id !== DESKTOP_RESTORE.opened[0].id, "the first-chapter fallback differs from the remembered chapter");

// 非章节记忆：note / empty / 双前缀（只剥离一次）/ 空前缀 / 未知 id / 缺失记录都不得映射到章节。
for (const [name, stored] of [
  ["note tab id", `note:${NOTE_ID}`],
  ["empty tab id", "empty:synthetic-empty-tab"],
  ["double prefix", `chapter:chapter:${REMEMBERED_ID}`],
  ["empty suffix", "chapter:"],
  ["unknown id", "synthetic-unknown-chapter"],
  ["missing memory", null],
]) {
  same(`a ${name} memory never opens a chapter on desktop`, await scenario(stored, false), NO_OPEN);
  same(`a ${name} memory falls back to the first chapter on mobile`, await scenario(stored, true), MOBILE_FIRST);
}

{
  // 空章节树 / 未知章节树 / 已存在标签页。
  const store = createStore({ [PROJECT_ID]: REMEMBERED_ID });
  const reader = createReader(store.db);
  same("an empty chapter tree completes without opening on desktop", await runInitializer({ getLastChapterId: reader }), NO_OPEN);
  same("an empty chapter tree completes without opening on mobile", await runInitializer({ getLastChapterId: reader, isMobile: true }), NO_OPEN);
  same("a loading chapter tree does not read, open, or latch", await runInitializer({ getLastChapterId: reader, ...LOADING_TREE }), IDLE);
  same("an undefined chapter tree does not read, open, or latch", await runInitializer({ getLastChapterId: reader, ...UNDEFINED_TREE }), IDLE);

  const activeTabId = `chapter:${REMEMBERED_ID}`;
  const chapterTab = { id: activeTabId, refId: REMEMBERED_ID, type: "chapter" };
  same(
    "existing tabs keep their state without re-reading memory",
    await runInitializer({ ...READY_INPUTS, getLastChapterId: reader, tabs: [chapterTab], activeTabId }),
    snapshot({ reads: [] }),
  );
  same(
    "an empty active tab still resets the initial navigation key",
    await runInitializer({ ...READY_INPUTS, getLastChapterId: reader, tabs: [{ id: "empty:t", refId: null, type: "chapter" }], activeTabId: "empty:t" }),
    snapshot({ reads: [], navigationKeys: [null] }),
  );
}

{
  // 章节树延迟到达：加载期间不得闩锁，就绪后精确恢复一次。
  const store = createStore({ [PROJECT_ID]: REMEMBERED_ID });
  const session = createInitializerSession(createInitializer, { ...READY_INPUTS, getLastChapterId: createReader(store.db) });
  session.render({ ...LOADING_TREE })();
  await settle();
  same("a delayed tree stays uninitialized while loading", session.snapshot(), IDLE);
  session.render()();
  await settle();
  const restored = session.snapshot();
  same("the ready tree restores the remembered chapter exactly once", restored, DESKTOP_RESTORE);
  session.render()();
  await settle();
  same("the initialization latch does not open a second chapter", session.snapshot(), restored);
}

// ============================================================
// 6. 生产者：规范写入、跳过与项目绑定
// ============================================================

{
  const store = createStore();
  await runProducer(store, { currentChapterId: REMEMBERED_ID });
  same("the producer stores the canonical raw chapter id", store.chapterIdFor(PROJECT_ID), REMEMBERED_ID);
}
{
  // note / 空标签页 / 无活动标签页都会让 currentChapterId 为 null，必须保留已记住的章节。
  const store = createStore({ [PROJECT_ID]: REMEMBERED_ID });
  await runProducer(store, { currentChapterId: null });
  same("a note/empty/no-active producer run preserves the remembered chapter", store.chapterIdFor(PROJECT_ID), REMEMBERED_ID);
}
{
  const store = createStore({ [OTHER_PROJECT_ID]: OTHER_REMEMBERED_ID });
  await runProducer(store, { projectId: OTHER_PROJECT_ID, currentChapterId: "synthetic-other-active" });
  same("the producer writes only the bound project's record", [store.chapterIdFor(OTHER_PROJECT_ID), store.chapterIdFor(PROJECT_ID)], ["synthetic-other-active", null]);
}

// ============================================================
// 7. 反向用例：撤回读取归一化 / 生产者写入，复原旧的不匹配
// ============================================================

/** 查找声明了 name 的唯一 VariableStatement。 */
function findDeclaration(node, name) {
  return findNode(
    node,
    (current) =>
      ts.isVariableStatement(current) &&
      current.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name),
  );
}

const storedStatement = requireExtraction(findDeclaration(initializerCall.arguments[0], "storedChapterId"), "the normalization statement was not found");
const lastStatement = requireExtraction(findDeclaration(initializerCall.arguments[0], "lastChapterId"), "the reader statement was not found");
const revertedInitializerText = initializerText
  .replace(storedStatement.getText(pageFile), "")
  .replace(lastStatement.getText(pageFile), "const lastChapterId = await getLastChapterId(projectId);");
requireExtraction(revertedInitializerText !== initializerText, "the reader reversion changed nothing");
record(
  !revertedInitializerText.includes("storedChapterId") && !revertedInitializerText.includes('startsWith("chapter:")'),
  "the reverted reader drops the one-prefix normalization",
);

const revertedProducerText = producerText.replaceAll("currentChapterId", "activeTabId");
requireExtraction(revertedProducerText !== producerText, "the producer reversion changed nothing");

const createRevertedInitializer = await importEffectFactory(revertedInitializerText, INITIALIZER_SEAMS, "reverted initializer");
const createRevertedProducer = await importEffectFactory(revertedProducerText, ["projectId", "activeTabId", "setLastChapterId"], "reverted producer");

{
  // 旧生产：写回 chapter:xxx；旧读取：既不归一化也找不到章节，桌面不恢复、移动端错开第一章。
  const store = createStore();
  createRevertedProducer(PROJECT_ID, `chapter:${REMEMBERED_ID}`, createWriter(store.db))();
  await settle();
  same("the reverted producer persists the prefixed tab id", store.chapterIdFor(PROJECT_ID), `chapter:${REMEMBERED_ID}`);
  same("the reverted reader fails to restore the prefixed memory on desktop", await scenario(`chapter:${REMEMBERED_ID}`, false, createRevertedInitializer), NO_OPEN);
  same("the reverted reader wrongly opens the first chapter on mobile", await scenario(`chapter:${REMEMBERED_ID}`, true, createRevertedInitializer), MOBILE_FIRST);
}

// ============================================================
// 8. 结果
// ============================================================

console.log(
  `writing-last-chapter-memory suite: ${checks - failures}/${checks} checks passed ` +
    `(actual initializer + actual producer + real getter/setter, ${INITIALIZER_SEAMS.length} initializer seams)`,
);
if (failures > 0) {
  console.error(`writing-last-chapter-memory suite: ${failures} check(s) failed`);
  process.exitCode = 1;
}
