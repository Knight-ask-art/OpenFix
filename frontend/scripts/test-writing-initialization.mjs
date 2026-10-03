/**
 * 写作页初始化（最后访问章节恢复）的源码级回归（Node 运行，不启动浏览器、不访问网络）。
 *
 * 从真实源码 writing-page.tsx 中用 TypeScript AST 提取唯一的 loadLastChapter useEffect：
 * 校验守卫条件与真实依赖数组，并把真实回调体转译后在严格合成接缝下直接执行。
 * 不复制修复逻辑，也不复制初始化策略；执行的就是生产回调体本身。
 *
 * 覆盖：缺少 projectId、tabs 未加载、章节树加载中、chaptersData 未定义但 loading 为 false、
 * 本地 tabs 先就绪而章节树延迟到达（记住的章节只恢复一次）、就绪空树完成初始化、
 * 已就绪的有效 tabs 保持原行为（含空标签页仍重置导航键）、无效记住 id 在桌面端不自动打开
 * 第一章、移动端第一章回退。
 *
 * 反向用例：把真实守卫中的章节树就绪项移除后重新执行同一批接缝，必须复现已确认的
 * 「在未知章节树上完成初始化」闩锁；依赖数组检查同样对移除后的名字集合敏感。
 * 所有接缝数据均为合成值，不读写真实文件系统、数据库或网络。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(here, "../src/features/writing/pages/writing-page.tsx");
const source = await readFile(sourcePath, "utf8");

const sourceFile = ts.createSourceFile(
  "writing-page.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

let checks = 0;
let failures = 0;

/**
 * 记录一次严格深度相等断言。
 * @param {string} label
 * @param {unknown} actual
 * @param {unknown} expected
 */
function same(label, actual, expected) {
  checks += 1;
  if (isDeepStrictEqual(actual, expected)) return;
  failures += 1;
  console.error(`FAIL ${label}`);
  console.error(`  expected ${JSON.stringify(expected)}`);
  console.error(`  actual   ${JSON.stringify(actual)}`);
}

/**
 * 记录一次布尔断言。
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail]
 */
function record(ok, label, detail) {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
}

/**
 * 前置条件：提取失败时立即终止，因为没有可执行的接缝。
 * @param {unknown} value
 * @param {string} message
 */
function requireExtraction(value, message) {
  if (!value) {
    console.error(`FAIL ${message}`);
    process.exit(1);
  }
  return value;
}

const normalize = (text) => text.replace(/\s+/g, " ").trim();

// ============================================================
// 1. 提取真实的 loadLastChapter useEffect、守卫条件与依赖数组
// ============================================================

/**
 * 在整棵语法树中查找符合条件的 useEffect 调用表达式。
 * @param {import("typescript").SourceFile} file
 * @returns {import("typescript").CallExpression[]}
 */
function findInitializationEffects(file) {
  /** @type {import("typescript").CallExpression[]} */
  const matches = [];
  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === "useEffect" &&
      node.arguments[0]?.getText(file).includes("const loadLastChapter = async")
    ) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return matches;
}

const effectCalls = findInitializationEffects(sourceFile);
requireExtraction(
  effectCalls.length === 1,
  `expected exactly one loadLastChapter useEffect, found ${effectCalls.length}`,
);
record(effectCalls.length === 1, "exactly one loadLastChapter useEffect in writing-page.tsx");

const effectCall = effectCalls[0];
const callback = requireExtraction(effectCall.arguments[0], "the effect has no callback argument");
requireExtraction(
  ts.isArrowFunction(callback),
  "the initialization effect callback is not an arrow",
);

/**
 * 在回调内查找包含 hasInitialized.current 的守卫语句。
 * @param {import("typescript").Node} node
 * @param {import("typescript").SourceFile} file
 * @returns {import("typescript").IfStatement | null}
 */
function findInitializationGuard(node, file) {
  /** @type {import("typescript").IfStatement | null} */
  let found = null;
  /** @param {import("typescript").Node} current */
  const visit = (current) => {
    if (found) return;
    if (
      ts.isIfStatement(current) &&
      current.expression.getText(file).includes("hasInitialized.current")
    ) {
      found = current;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

const guard = requireExtraction(
  findInitializationGuard(callback, sourceFile),
  "the initialization guard (hasInitialized.current) was not found",
);

const guardCondition = normalize(guard.expression.getText(sourceFile));

/** 生产守卫必须包含的两项章节树就绪条件。 */
const READINESS_TERMS = [" || isChaptersLoading", " || !chaptersData"];
/** 本次修复退役的旧守卫：只等 tabs 加载，不等章节树。 */
const RETIRED_GUARD_CONDITION = "!projectId || !isTabsLoaded || hasInitialized.current";

same(
  "the initialization guard requires a ready chapter tree",
  guardCondition,
  "!projectId || !isTabsLoaded || isChaptersLoading || !chaptersData || hasInitialized.current",
);
record(
  !source.includes(`if (${RETIRED_GUARD_CONDITION}) return;`),
  "retires the tabs-only initialization guard that completed on an unknown chapter tree",
);

// 依赖数组：必须是同一个 useEffect 的第二个实参。
const dependencyList = requireExtraction(
  effectCall.arguments[1],
  "the initialization effect has no dependency array",
);
requireExtraction(
  ts.isArrayLiteralExpression(dependencyList),
  "the second argument of the initialization effect is not an array literal",
);

const dependencyElements = dependencyList.elements;
const dependencyNames = dependencyElements.map((element) => element.getText(sourceFile));

/**
 * 依赖项只允许两种形状：普通标识符，或本次修复前就存在的 `tabs.length` 属性访问。
 * 不接受任意表达式，避免把「依赖数组」检查放宽成空断言。
 * @param {import("typescript").Node} element
 */
function isPlainDependency(element) {
  if (ts.isIdentifier(element)) return true;
  return (
    ts.isPropertyAccessExpression(element) &&
    element.expression.getText(sourceFile) === "tabs" &&
    element.name.getText(sourceFile) === "length"
  );
}

const nonPlainDependencies = dependencyElements
  .map((element, index) => (isPlainDependency(element) ? null : dependencyNames[index]))
  .filter((name) => name !== null);
record(
  nonPlainDependencies.length === 0,
  "the initialization dependency array only contains plain identifiers and tabs.length",
  dependencyNames.join(", "),
);

/** 章节树就绪依赖项必须存在，否则章节树到达时不会重新评估初始化。 */
const REQUIRED_DEPENDENCIES = ["chaptersData", "isChaptersLoading"];

/**
 * @param {string[]} names
 * @returns {string[]} 缺失的必需依赖项
 */
function missingDependencies(names) {
  return REQUIRED_DEPENDENCIES.filter((name) => !names.includes(name));
}

same(
  "the initialization dependency array contains both chapter tree readiness inputs",
  missingDependencies(dependencyNames),
  [],
);
record(
  dependencyNames.includes("tabs.length") && dependencyNames.includes("activeTabId"),
  "the initialization dependency array still tracks tabs and the active tab",
  dependencyNames.join(", "),
);

// 依赖检查本身必须对「移除后」的名字集合敏感，避免空断言。
same(
  "the dependency check reports both names once they are removed",
  missingDependencies(dependencyNames.filter((name) => !REQUIRED_DEPENDENCIES.includes(name))),
  [...REQUIRED_DEPENDENCIES],
);

// ============================================================
// 2. 回调体的自由标识符：接缝必须严格覆盖真实引用
// ============================================================

/**
 * 收集回调体内引用的自由标识符（排除属性名与局部声明）。
 * @param {import("typescript").Node} node
 * @returns {string[]}
 */
function collectFreeIdentifiers(node) {
  /** @type {Set<string>} */
  const referenced = new Set();
  /** @type {Set<string>} */
  const declared = new Set();

  /** @param {import("typescript").Node} current */
  const visit = (current) => {
    if (ts.isIdentifier(current)) {
      const parent = current.parent;
      const isDeclarationName =
        (ts.isVariableDeclaration(parent) && parent.name === current) ||
        (ts.isParameter(parent) && parent.name === current);
      const isMemberName =
        (ts.isPropertyAccessExpression(parent) && parent.name === current) ||
        (ts.isPropertyAssignment(parent) && parent.name === current) ||
        (ts.isPropertySignature(parent) && parent.name === current);
      if (!isDeclarationName && !isMemberName) referenced.add(current.text);
      return;
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      declared.add(current.name.text);
    }
    if (ts.isParameter(current) && ts.isIdentifier(current.name)) {
      declared.add(current.name.text);
    }
    ts.forEachChild(current, visit);
  };

  visit(node);
  return [...referenced].filter((name) => !declared.has(name));
}

const freeIdentifiers = collectFreeIdentifiers(callback);

/**
 * 生产回调体真实引用的自由标识符集合（含本次修复新增的两项就绪输入）。
 * 任何新增引用都会让接缝失效，因此这里做集合级严格校验。
 */
const SEAM_IDENTIFIERS = [
  "activeTabId",
  "allChapters",
  "chaptersData",
  "getLastChapterId",
  "hasInitialized",
  "isEmptyTab",
  "isChaptersLoading",
  "isMobile",
  "isTabsLoaded",
  "openSingleTab",
  "openTab",
  "projectId",
  "setInitialCurrentChapterNavigationKey",
  "tabs",
].sort();

same(
  "the executed seams cover exactly the free identifiers of the production callback",
  [...freeIdentifiers].sort(),
  SEAM_IDENTIFIERS,
);

// ============================================================
// 3. 合成接缝：直接执行真实回调体
// ============================================================

const CALLBACK_TEXT = callback.getText(sourceFile);

/**
 * 把回调体包装成可注入自由变量的工厂并转译为 ESM。
 * @param {string} callbackText
 * @param {string} label
 * @returns {Promise<(...args: unknown[]) => () => void>}
 */
async function loadEffectFactory(callbackText, label) {
  const moduleSource = `export function createInitializationEffect(${SEAM_IDENTIFIERS.join(
    ", ",
  )}) {\n  return ${callbackText};\n}\n`;
  const { outputText, diagnostics } = ts.transpileModule(moduleSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  if (diagnostics && diagnostics.length > 0) {
    for (const diagnostic of diagnostics) {
      console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    }
    throw new Error(`${label}: transpile failed`);
  }
  const base64 = Buffer.from(outputText, "utf8").toString("base64");
  const moduleUrl = `data:text/javascript;base64,${base64}`;
  const module = await import(moduleUrl);
  return module.createInitializationEffect;
}

const createInitializationEffect = await loadEffectFactory(CALLBACK_TEXT, "production callback");

const PROJECT_ID = "synthetic-project";
const REMEMBERED_ID = "synthetic-remembered-chapter";
const FIRST_ID = "synthetic-first-chapter";
const MISSING_ID = "synthetic-missing-chapter";
const EMPTY_TAB_ID = "empty:synthetic-tab";

/**
 * 用章节 id 构造与 useVolumeTree 消费形状一致的树（只提供 allChapters 与 chaptersData）。
 * @param {string[]} chapterIds
 */
function chapterTree(chapterIds) {
  const chapters = chapterIds.map((id, index) => ({
    id,
    title: `Synthetic ${id}`,
    order: index + 1,
  }));
  return {
    chaptersData: { volumes: [{ id: "synthetic-volume", chapters }] },
    allChapters: chapters.map((chapter) => ({ id: chapter.id, title: chapter.title })),
  };
}

const READY_EMPTY_TREE = chapterTree([]);
const READY_TREE = chapterTree([FIRST_ID, REMEMBERED_ID]);

/** 刷新微任务队列：真实回调未 await loadLastChapter，因此需要一次事件循环。 */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 创建一个跨「渲染」共享 useRef 对象的合成会话。
 *
 * render() 模拟一次 React 渲染：用当前 props/state 生成新的回调实例，
 * 但 hasInitialized ref 对象在渲染之间保持不变（与生产 useRef 语义一致）。
 *
 * @param {(...args: unknown[]) => () => void} effectFactory
 * @param {{ rememberedId?: string | null, base?: Record<string, unknown> }} [options]
 */
function createSession(effectFactory, options = {}) {
  const { rememberedId = null, base = {} } = options;
  const trace = {
    hasInitialized: { current: false },
    opened: [],
    openedSingle: [],
    navigationKeys: [],
    lastChapterReads: [],
  };

  /** @param {Record<string, unknown>} [overrides] */
  const render = (overrides = {}) => {
    const environment = {
      projectId: PROJECT_ID,
      isTabsLoaded: true,
      isChaptersLoading: false,
      chaptersData: READY_EMPTY_TREE.chaptersData,
      hasInitialized: trace.hasInitialized,
      tabs: [],
      activeTabId: null,
      isEmptyTab: (tabId) => typeof tabId === "string" && tabId.startsWith("empty:"),
      getLastChapterId: async (projectId) => {
        trace.lastChapterReads.push(projectId);
        return rememberedId;
      },
      allChapters: READY_EMPTY_TREE.allChapters,
      isMobile: false,
      openTab: (id, title) => {
        trace.opened.push({ id, title });
      },
      openSingleTab: (id, title) => {
        trace.openedSingle.push({ id, title });
      },
      setInitialCurrentChapterNavigationKey: (key) => {
        trace.navigationKeys.push(key);
      },
      ...base,
      ...overrides,
    };
    return effectFactory(...SEAM_IDENTIFIERS.map((name) => environment[name]));
  };

  const snapshot = () => ({
    hasInitialized: trace.hasInitialized.current,
    opened: [...trace.opened],
    openedSingle: [...trace.openedSingle],
    navigationKeys: [...trace.navigationKeys],
    lastChapterReads: [...trace.lastChapterReads],
  });

  return { render, snapshot };
}

/**
 * 执行一次渲染产出的回调并快照结果。
 * @param {() => void} effect
 * @param {() => unknown} snapshot
 */
async function run(effect, snapshot) {
  effect();
  await settle();
  return snapshot();
}

/** 生产会话与「已退役守卫」会话使用同一套接缝。 */
const productionSession = (options) => createSession(createInitializationEffect, options);

const IDLE = {
  hasInitialized: false,
  opened: [],
  openedSingle: [],
  navigationKeys: [],
  lastChapterReads: [],
};

/** 加载中的章节树：loading 为真、数据未定义、章节列表为空。 */
const LOADING_TREE = { isChaptersLoading: true, chaptersData: undefined, allChapters: [] };
/** 未定义的章节树且 loading 为假（请求失败/未启用）。 */
const UNDEFINED_TREE = { isChaptersLoading: false, chaptersData: undefined, allChapters: [] };

// ============================================================
// 4. 正向用例：真实回调体在真实就绪语义下必须正确
// ============================================================

{
  const session = productionSession({ rememberedId: REMEMBERED_ID });
  const result = await run(session.render({ ...READY_TREE, projectId: null }), session.snapshot);
  same("missing projectId does not read, open, or latch", result, IDLE);
}

{
  const session = productionSession({ rememberedId: REMEMBERED_ID });
  const result = await run(
    session.render({ ...READY_TREE, isTabsLoaded: false }),
    session.snapshot,
  );
  same("tabs not loaded does not read, open, or latch", result, IDLE);
}

{
  const session = productionSession({ rememberedId: REMEMBERED_ID });
  const result = await run(session.render(LOADING_TREE), session.snapshot);
  same("a loading chapter tree does not read, open, or latch", result, IDLE);
}

{
  const session = productionSession({ rememberedId: REMEMBERED_ID });
  const result = await run(session.render(UNDEFINED_TREE), session.snapshot);
  same("an undefined chapter tree without loading does not read, open, or latch", result, IDLE);
}

{
  // 本地 tabs 先就绪（空），章节树延迟到达：延迟期间不得闩锁，就绪后精确恢复一次。
  const session = productionSession({ rememberedId: REMEMBERED_ID });
  const beforeTree = await run(session.render(LOADING_TREE), session.snapshot);
  same(
    "empty tabs with a delayed chapter tree stay uninitialized before the tree is ready",
    beforeTree,
    IDLE,
  );

  const afterTree = await run(session.render(READY_TREE), session.snapshot);
  same("a delayed ready tree restores the remembered chapter exactly once", afterTree, {
    hasInitialized: true,
    opened: [{ id: REMEMBERED_ID, title: `Synthetic ${REMEMBERED_ID}` }],
    openedSingle: [],
    navigationKeys: [],
    lastChapterReads: [PROJECT_ID],
  });

  const thirdRender = await run(session.render(READY_TREE), session.snapshot);
  same(
    "the initialization latch keeps later renders from opening a second chapter",
    thirdRender,
    afterTree,
  );
}

{
  // 就绪的空树：桌面端完成初始化并写入 null 导航键，且只写一次。
  const session = productionSession();
  const first = await run(session.render(READY_EMPTY_TREE), session.snapshot);
  same("a ready empty tree completes initialization with the null navigation key", first, {
    hasInitialized: true,
    opened: [],
    openedSingle: [],
    navigationKeys: [null],
    lastChapterReads: [PROJECT_ID],
  });

  const second = await run(session.render(READY_EMPTY_TREE), session.snapshot);
  same("the ready empty tree path does not repeat the navigation reset", second, first);
}

{
  // 已就绪的有效 tabs：保持原行为，不打开新标签页，也不重置导航键。
  const session = productionSession({ rememberedId: REMEMBERED_ID });
  const activeTabId = `chapter:${REMEMBERED_ID}`;
  const tabs = [{ id: activeTabId, refId: REMEMBERED_ID, type: "chapter" }];
  const beforeTree = await run(
    session.render({ ...LOADING_TREE, tabs, activeTabId }),
    session.snapshot,
  );
  same("existing tabs wait for the chapter tree instead of latching early", beforeTree, IDLE);

  const afterTree = await run(
    session.render({ ...READY_TREE, tabs, activeTabId }),
    session.snapshot,
  );
  same("a ready tree preserves existing tabs without opening or resetting navigation", afterTree, {
    hasInitialized: true,
    opened: [],
    openedSingle: [],
    navigationKeys: [],
    lastChapterReads: [],
  });
}

{
  // 活动标签页是空标签页时，仍需重置初始导航键。
  const session = productionSession({ rememberedId: REMEMBERED_ID });
  const tabs = [{ id: EMPTY_TAB_ID, refId: null, type: "chapter" }];
  const result = await run(
    session.render({ ...READY_TREE, tabs, activeTabId: EMPTY_TAB_ID }),
    session.snapshot,
  );
  same("an empty active tab still resets the initial navigation key", result, {
    hasInitialized: true,
    opened: [],
    openedSingle: [],
    navigationKeys: [null],
    lastChapterReads: [],
  });
}

{
  // 记住的 id 不在就绪树中：桌面端不得自动打开第一章。
  const session = productionSession({ rememberedId: MISSING_ID });
  const result = await run(session.render(chapterTree([FIRST_ID])), session.snapshot);
  same("an unknown remembered id on desktop never auto-opens the first chapter", result, {
    hasInitialized: true,
    opened: [],
    openedSingle: [],
    navigationKeys: [null],
    lastChapterReads: [PROJECT_ID],
  });
}

{
  // 移动端：没有记住的 id 时回退到第一章。
  const session = productionSession();
  const result = await run(session.render({ ...READY_TREE, isMobile: true }), session.snapshot);
  same("mobile falls back to the first chapter when nothing is remembered", result, {
    hasInitialized: true,
    opened: [],
    openedSingle: [{ id: FIRST_ID, title: `Synthetic ${FIRST_ID}` }],
    navigationKeys: [],
    lastChapterReads: [PROJECT_ID],
  });
}

{
  // 移动端：记住的 id 不在树中时同样回退到第一章。
  const session = productionSession({ rememberedId: MISSING_ID });
  const result = await run(
    session.render({ ...chapterTree([FIRST_ID, REMEMBERED_ID]), isMobile: true }),
    session.snapshot,
  );
  same("mobile falls back to the first chapter when the remembered id is unknown", result, {
    hasInitialized: true,
    opened: [],
    openedSingle: [{ id: FIRST_ID, title: `Synthetic ${FIRST_ID}` }],
    navigationKeys: [],
    lastChapterReads: [PROJECT_ID],
  });
}

{
  // 移动端：记住的章节通过单标签页打开，且只打开一次。
  const session = productionSession({ rememberedId: REMEMBERED_ID });
  const beforeTree = await run(
    session.render({ ...LOADING_TREE, isMobile: true }),
    session.snapshot,
  );
  same("mobile waits for the chapter tree before opening the remembered chapter", beforeTree, IDLE);

  const afterTree = await run(session.render({ ...READY_TREE, isMobile: true }), session.snapshot);
  same("mobile opens exactly the remembered chapter in a single tab", afterTree, {
    hasInitialized: true,
    opened: [],
    openedSingle: [{ id: REMEMBERED_ID, title: `Synthetic ${REMEMBERED_ID}` }],
    navigationKeys: [],
    lastChapterReads: [PROJECT_ID],
  });

  const withOpenTab = [{ id: `chapter:${REMEMBERED_ID}`, refId: REMEMBERED_ID, type: "chapter" }];
  const nextRender = await run(
    session.render({
      ...READY_TREE,
      isMobile: true,
      tabs: withOpenTab,
      activeTabId: withOpenTab[0].id,
    }),
    session.snapshot,
  );
  same("mobile keeps the opened remembered chapter across later renders", nextRender, afterTree);
}

{
  // 移动端 + 就绪空树：无章节可回退时写入 null 导航键。
  const session = productionSession();
  const result = await run(
    session.render({ ...READY_EMPTY_TREE, isMobile: true }),
    session.snapshot,
  );
  same("mobile with a ready empty tree completes with the null navigation key", result, {
    hasInitialized: true,
    opened: [],
    openedSingle: [],
    navigationKeys: [null],
    lastChapterReads: [PROJECT_ID],
  });
}

// ============================================================
// 5. 反向用例：移除章节树就绪项必须复现已确认的闩锁
// ============================================================

const retiredGuardCondition = normalize(
  READINESS_TERMS.reduce((text, term) => text.replace(term, ""), guardCondition),
);
requireExtraction(
  retiredGuardCondition === RETIRED_GUARD_CONDITION,
  `removing the readiness terms produced ${JSON.stringify(retiredGuardCondition)}`,
);

let retiredCallbackText = CALLBACK_TEXT;
for (const term of READINESS_TERMS) {
  requireExtraction(
    retiredCallbackText.includes(term),
    `the production guard does not contain the readiness term ${JSON.stringify(term)}`,
  );
  retiredCallbackText = retiredCallbackText.replace(term, "");
}
requireExtraction(
  retiredCallbackText !== CALLBACK_TEXT,
  "the retired guard mutation changed nothing",
);

const createRetiredEffect = await loadEffectFactory(retiredCallbackText, "retired guard");
const retiredSession = (options) => createSession(createRetiredEffect, options);

{
  const session = retiredSession({ rememberedId: REMEMBERED_ID });
  const result = await run(session.render(LOADING_TREE), session.snapshot);
  same("without the readiness guard a loading tree latches on an empty chapter list", result, {
    hasInitialized: true,
    opened: [],
    openedSingle: [],
    navigationKeys: [null],
    lastChapterReads: [PROJECT_ID],
  });
}

{
  const session = retiredSession({ rememberedId: REMEMBERED_ID });
  const result = await run(session.render(UNDEFINED_TREE), session.snapshot);
  same(
    "without the readiness guard an undefined chapter tree latches on an empty chapter list",
    result,
    {
      hasInitialized: true,
      opened: [],
      openedSingle: [],
      navigationKeys: [null],
      lastChapterReads: [PROJECT_ID],
    },
  );
}

{
  // 关键回归：本地 tabs 先就绪、章节树延迟到达时，旧守卫会永久闩锁。
  const session = retiredSession({ rememberedId: REMEMBERED_ID });
  const beforeTree = await run(session.render(LOADING_TREE), session.snapshot);
  same("the retired guard latches before the chapter tree is ready", beforeTree, {
    hasInitialized: true,
    opened: [],
    openedSingle: [],
    navigationKeys: [null],
    lastChapterReads: [PROJECT_ID],
  });

  const afterTree = await run(session.render(READY_TREE), session.snapshot);
  same(
    "the retired guard never recovers the remembered chapter once the tree arrives",
    afterTree,
    beforeTree,
  );
}

{
  // 移动端同样：旧守卫在空章节列表上闩锁后不再回退到第一章。
  const session = retiredSession({ rememberedId: REMEMBERED_ID });
  const beforeTree = await run(
    session.render({ ...LOADING_TREE, isMobile: true }),
    session.snapshot,
  );
  same("the retired guard latches on the mobile loading tree", beforeTree, {
    hasInitialized: true,
    opened: [],
    openedSingle: [],
    navigationKeys: [null],
    lastChapterReads: [PROJECT_ID],
  });

  const afterTree = await run(session.render({ ...READY_TREE, isMobile: true }), session.snapshot);
  same("the retired guard never opens the remembered mobile chapter", afterTree, beforeTree);
}

// ============================================================
// 6. 结果
// ============================================================

console.log(
  `writing-initialization suite: ${checks - failures}/${checks} checks passed ` +
    `(actual-source guard + dependency array + ${freeIdentifiers.length} synthetic seams)`,
);
if (failures > 0) {
  console.error(`writing-initialization suite: ${failures} check(s) failed`);
  process.exitCode = 1;
}
