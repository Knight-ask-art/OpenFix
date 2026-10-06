/**
 * 字数统计的前后端同协议回归（Node 运行，不启动浏览器、不访问网络）。
 *
 * 直接从真实源码 frontend/src/lib/word-count.ts 转译后执行，并消费共享 fixture
 * fixtures/word-count-cases.json：用例、CJK 区间表和后端测试读取的是同一份数据，
 * 因此这里不复制规则，只校验前端实现对共享协议的符合程度。
 * 控制字符与不可见字符统一按码点构造，避免转义被改写后口径漂移。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, "../../fixtures/word-count-cases.json");
const wordCountPath = path.resolve(here, "../src/lib/word-count.ts");
const editorPath = path.resolve(here, "../src/features/writing/components/chapter-editor.tsx");
const packageJsonPath = path.resolve(here, "../package.json");

const LINE_FEED = String.fromCodePoint(10);
const COMBINING_ACUTE = String.fromCodePoint(0x301);
const GRINNING_FACE = String.fromCodePoint(0x1f600);

let checks = 0;
let failures = 0;

/** 记录一次断言，失败时打印可定位的标签。 */
function check(label, run) {
  checks += 1;
  try {
    run();
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 用例正文：给出 text，或给出 codePoints（控制字符、组合音标、emoji 等）。 */
function caseText(testCase) {
  if (Array.isArray(testCase.codePoints)) {
    return String.fromCodePoint(...testCase.codePoints);
  }
  return testCase.text;
}

/** 沿用已有脚本的 TS 转译导入方式：转译为 ESM 后从内存模块导入。 */
async function loadTsModule(absolutePath) {
  const source = await readFile(absolutePath, "utf8");
  const { outputText, diagnostics } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  if (diagnostics && diagnostics.length > 0) {
    for (const diagnostic of diagnostics) {
      console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    }
    throw new Error(`transpile failed: ${absolutePath}`);
  }
  const base64 = Buffer.from(outputText, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${base64}`);
}

const { CJK_RANGES, countWords } = await loadTsModule(wordCountPath);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

check("前端 CJK 区间表与共享 fixture 一致", () => {
  assert.deepEqual(
    CJK_RANGES.map(([start, end]) => [start, end]),
    fixture.cjkRanges,
  );
});

for (const testCase of fixture.cases) {
  check(`fixture 用例：${testCase.name}`, () => {
    assert.equal(countWords(caseText(testCase)), testCase.words);
  });
}

for (const [start, end] of fixture.cjkRanges) {
  const rangeLabel = `${start.toString(16).toUpperCase()}-${end.toString(16).toUpperCase()}`;
  check(`CJK 区间端点逐字符计：${rangeLabel}`, () => {
    assert.equal(countWords(String.fromCodePoint(start)), 1);
    assert.equal(countWords(String.fromCodePoint(end)), 1);
    assert.equal(countWords(String.fromCodePoint(start) + String.fromCodePoint(end)), 2);
    assert.equal(countWords(`a${String.fromCodePoint(start)}b`), 3);
  });
}

check("空文本与纯空白计 0", () => {
  const blank = String.fromCodePoint(32, 9, 10, 13, 12288);

  assert.equal(countWords(""), 0);
  assert.equal(countWords(blank), 0);
});

check("英文撇号按边界分词", () => {
  assert.equal(countWords("don't"), 2);
  assert.equal(countWords(`don${String.fromCodePoint(0x2019)}t`), 2);
});

check("字母数字连续串计 1", () => {
  assert.equal(countWords("abc123"), 1);
  assert.equal(countWords("abc123 xyz789"), 2);
  assert.equal(countWords("abc-123"), 2);
});

check("组合音标随前字符且不切断连续串", () => {
  assert.equal(countWords(`cafe${COMBINING_ACUTE}`), 1);
  assert.equal(countWords(`cafe${COMBINING_ACUTE} bar`), 2);
  assert.equal(countWords(`字${COMBINING_ACUTE}`), 1);
});

check("标点、空白与 emoji 作为边界", () => {
  assert.equal(countWords("你好，世界！"), 4);
  assert.equal(countWords(`一。${LINE_FEED}二`), 2);
  assert.equal(countWords(`ab${GRINNING_FACE}cd`), 2);
  assert.equal(countWords(GRINNING_FACE), 0);
});

const editorSource = await readFile(editorPath, "utf8");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

check("章节编辑器改用本地 countWords", () => {
  assert.ok(editorSource.includes('import { countWords } from "@/lib/word-count";'));
  assert.ok(!editorSource.includes('"words-count"'));
  assert.ok(editorSource.includes("const currentWordCount = countWords("));
});

check("保留 words-count 依赖，不新增依赖改动", () => {
  assert.ok(packageJson.dependencies["words-count"]);
});

console.log(`Word count suite: ${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`Word count suite: ${failures} check(s) failed`);
  process.exitCode = 1;
}
