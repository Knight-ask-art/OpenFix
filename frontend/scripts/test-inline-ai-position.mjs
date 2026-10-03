/**
 * Inline AI 浮层定位的纯几何回归（Node 运行，不启动浏览器、不访问网络）。
 *
 * 通过 TypeScript AST 从真实组件源码 inline-ai-menu.tsx 中提取
 * resolveFloatingPlacement，转译后用显式几何输入直接执行；不复制算法，也不依赖 DOM。
 *
 * 覆盖已观测的 449 高菜单 / 217 锚点失败、上方与下方、右侧与左侧、大视口与
 * 1280x720、触发器尺寸、阶段高度变化以及超高表面边界。所有断言保持严格相等。
 *
 * 同时以同样方式提取并执行真实的 handleScroll 回调：用合成 ref 与合成 Node
 * 接缝证明浮层内部滚动（菜单自身、子元素、结果 diff）不再关闭菜单，而菜单外部、
 * document、null、undefined 与非 Node 目标仍然关闭。执行的是真实回调体，不是复制的策略。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(
  here,
  "../src/features/inline-ai/components/inline-ai-menu.tsx",
);
const source = await readFile(sourcePath, "utf8");

const sourceFile = ts.createSourceFile(
  "inline-ai-menu.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

const declaration = sourceFile.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "resolveFloatingPlacement",
);

if (!declaration) {
  console.error("FAIL resolveFloatingPlacement not found in inline-ai-menu.tsx");
  process.exit(1);
}

const functionText = declaration.getText(sourceFile);

const moduleSource = `${functionText}\nexport { resolveFloatingPlacement };\n`;
const { outputText, diagnostics } = ts.transpileModule(moduleSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
if (diagnostics && diagnostics.length > 0) {
  for (const diagnostic of diagnostics) {
    console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  }
  process.exit(1);
}

const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText, "utf8").toString("base64")}`;
const { resolveFloatingPlacement } = await import(moduleUrl);

let checks = 0;
let failures = 0;

/**
 * @param {boolean} ok
 * @param {string} label
 * @param {string} [detail]
 */
function record(ok, label, detail) {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

/**
 * @param {string} label
 * @param {unknown} actual
 * @param {unknown} expected
 */
function same(label, actual, expected) {
  record(
    Object.is(actual, expected),
    label,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

// ============================================================
// 1. 提取的是纯几何函数，且组件确实在调用它，旧的固定推断已退役
// ============================================================

record(
  !/\bwindow\b|\bdocument\b|getBoundingClientRect/.test(functionText),
  "extracted positioning function never touches the DOM",
);
record(
  source.split("resolveFloatingPlacement").length - 1 >= 2,
  "component actually calls the positioning function",
);
record(
  !source.includes("coords.top > 200"),
  "retires the fixed 200px above-room guess",
);
record(
  !source.includes("window.innerWidth - 240"),
  "retires the guessed 240px horizontal cap",
);
record(
  !source.includes("translateY(-100%)"),
  "retires the generic translateY(-100%) flip",
);

// ============================================================
// 2. 显式几何用例：默认 margin / gap 为 8
// ============================================================

/**
 * @typedef {{ left: number, top: number, bottom: number }} AnchorRect
 * @typedef {{ width: number, height: number }} Size
 * @typedef {{ anchor: AnchorRect, surface: Size, viewport: Size, margin?: number, gap?: number }} PlacementInput
 * @typedef {{ left: number, top: number }} Placement
 * @typedef {[string, PlacementInput, Placement]} PlacementCase
 */

/** @type {PlacementCase[]} */
const cases = [
  [
    "observed 449px menu under a 217px anchor flips below instead of above",
    {
      anchor: { left: 389, top: 225.390625, bottom: 249.390625 },
      surface: { width: 480, height: 449 },
      viewport: { width: 1600, height: 1000 },
    },
    { left: 389, top: 257.390625 },
  ],
  [
    "prefers above when the whole surface fits above the selection",
    {
      anchor: { left: 100, top: 800, bottom: 824 },
      surface: { width: 480, height: 300 },
      viewport: { width: 1600, height: 1000 },
    },
    { left: 100, top: 492 },
  ],
  [
    "flips below when there is no room above the selection",
    {
      anchor: { left: 100, top: 50, bottom: 74 },
      surface: { width: 480, height: 300 },
      viewport: { width: 1600, height: 1000 },
    },
    { left: 100, top: 82 },
  ],
  [
    "clamps to the right viewport edge using the real surface width",
    {
      anchor: { left: 1500, top: 400, bottom: 424 },
      surface: { width: 480, height: 200 },
      viewport: { width: 1600, height: 1000 },
    },
    { left: 1112, top: 192 },
  ],
  [
    "clamps to the left viewport margin",
    {
      anchor: { left: 2, top: 400, bottom: 424 },
      surface: { width: 480, height: 200 },
      viewport: { width: 1600, height: 1000 },
    },
    { left: 8, top: 192 },
  ],
  [
    "large viewport fits the surface above the selection",
    {
      anchor: { left: 900, top: 1100, bottom: 1124 },
      surface: { width: 480, height: 400 },
      viewport: { width: 2560, height: 1440 },
    },
    { left: 900, top: 692 },
  ],
  [
    "1280x720 keeps the 449px menu fully inside the viewport",
    {
      anchor: { left: 389, top: 225.390625, bottom: 249.390625 },
      surface: { width: 480, height: 449 },
      viewport: { width: 1280, height: 720 },
    },
    { left: 389, top: 257.390625 },
  ],
  [
    "clamps to the top margin when neither side fully fits",
    {
      anchor: { left: 389, top: 360, bottom: 384 },
      surface: { width: 480, height: 500 },
      viewport: { width: 1280, height: 720 },
    },
    { left: 389, top: 8 },
  ],
  [
    "small trigger surface still fits above the same anchor",
    {
      anchor: { left: 389, top: 225.390625, bottom: 249.390625 },
      surface: { width: 96, height: 28 },
      viewport: { width: 1600, height: 1000 },
    },
    { left: 389, top: 189.390625 },
  ],
  [
    "shorter phase content stays above the same anchor",
    {
      anchor: { left: 389, top: 225.390625, bottom: 249.390625 },
      surface: { width: 480, height: 200 },
      viewport: { width: 1600, height: 1000 },
    },
    { left: 389, top: 17.390625 },
  ],
  [
    "oversized surface pins to the top margin and relies on CSS max-height",
    {
      anchor: { left: 389, top: 400, bottom: 424 },
      surface: { width: 480, height: 2000 },
      viewport: { width: 1600, height: 1000 },
    },
    { left: 389, top: 8 },
  ],
  [
    "honours explicit margin and gap",
    {
      anchor: { left: 100, top: 500, bottom: 524 },
      surface: { width: 300, height: 400 },
      viewport: { width: 1000, height: 800 },
      margin: 16,
      gap: 12,
    },
    { left: 100, top: 88 },
  ],
];

for (const [label, input, expected] of cases) {
  const actual = resolveFloatingPlacement(input);
  same(`${label} :: left`, actual.left, expected.left);
  same(`${label} :: top`, actual.top, expected.top);
}

// ============================================================
// 3. handleScroll：只关闭来自浮层外部的滚动（执行真实回调体）
// ============================================================

/**
 * 在组件源码 AST 中查找名为 handleScroll 的箭头函数初始化表达式源码。
 * @param {import("typescript").SourceFile} file
 * @param {string} name
 * @returns {string | null}
 */
function findArrowInitializerText(file, name) {
  /** @type {string | null} */
  let found = null;
  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      found = node.initializer.getText(file);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const handleScrollText = findArrowInitializerText(sourceFile, "handleScroll");
if (!handleScrollText) {
  console.error("FAIL handleScroll callback not found in inline-ai-menu.tsx");
  process.exit(1);
}

record(
  /\bfloatingRef\b/.test(handleScrollText) && /\bclose\b/.test(handleScrollText),
  "extracted handleScroll body is wired to the floating ref and close action",
);

const seamSource = [
  "export function createHandleScroll(floatingRef, close, Node) {",
  `  return ${handleScrollText};`,
  "}",
].join("\n");

const seamModule = ts.transpileModule(seamSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
if (seamModule.diagnostics && seamModule.diagnostics.length > 0) {
  for (const diagnostic of seamModule.diagnostics) {
    console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  }
  process.exit(1);
}

const seamUrl = `data:text/javascript;base64,${Buffer.from(seamModule.outputText, "utf8").toString("base64")}`;
const { createHandleScroll } = await import(seamUrl);

/** 合成节点：只实现 contains 语义，作为 instanceof Node 的严格接缝替身。 */
class SyntheticNode {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
    /** @type {Set<unknown>} */
    this.descendants = new Set();
  }

  /**
   * 登记一个直接或间接后代。
   * @param {SyntheticNode} node
   * @returns {this}
   */
  own(node) {
    this.descendants.add(node);
    return this;
  }

  /**
   * @param {unknown} node
   * @returns {boolean}
   */
  contains(node) {
    return node === this || this.descendants.has(node);
  }
}

const menu = new SyntheticNode("menu");
const menuAction = new SyntheticNode("menu-action");
const resultDiff = new SyntheticNode("result-diff");
menu.own(menuAction).own(resultDiff);

const editorScroller = new SyntheticNode("editor-scroller");
const documentNode = new SyntheticNode("document");
const plainObject = { tag: "plain-object" };

/**
 * @typedef {{ label: string, target: unknown, closes: boolean }} ScrollCase
 */

/** @type {ScrollCase[]} */
const scrollCases = [
  { label: "scroll on the menu itself keeps it open", target: menu, closes: false },
  { label: "scroll on a direct menu child keeps it open", target: menuAction, closes: false },
  { label: "scroll on the nested result diff keeps it open", target: resultDiff, closes: false },
  { label: "scroll outside the menu still closes it", target: editorScroller, closes: true },
  { label: "scroll on the document still closes it", target: documentNode, closes: true },
  { label: "a null scroll target still closes", target: null, closes: true },
  { label: "an undefined scroll target still closes", target: undefined, closes: true },
  { label: "a non-Node scroll target still closes", target: plainObject, closes: true },
];

for (const scrollCase of scrollCases) {
  let closes = 0;
  const handleScroll = createHandleScroll(
    { current: menu },
    () => {
      closes += 1;
    },
    SyntheticNode,
  );
  handleScroll({ target: scrollCase.target });
  same(scrollCase.label, closes, scrollCase.closes ? 1 : 0);
}

let detachedCloses = 0;
const detachedScroll = createHandleScroll(
  { current: null },
  () => {
    detachedCloses += 1;
  },
  SyntheticNode,
);
detachedScroll({ target: menu });
same("a vanished floating surface still closes on scroll", detachedCloses, 1);

console.log(`inline-ai-position suite: ${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`inline-ai-position suite: ${failures} check(s) failed`);
  process.exitCode = 1;
}
