/**
 * ai-error 纯函数负向矩阵（Node 运行，不启动浏览器、不访问网络）。
 *
 * 目标：证明「模型不可用」只由固定的 HTTP 400 + code 判定，
 * 绝不根据文案内容、关键字或前缀推断；同时证明 detail 读取器
 * 对未知输入是安全的。
 *
 * 直接转译并加载 src/lib/ai-error.ts，覆盖真实实现而不是复制一份。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(here, "../src/lib/ai-error.ts");
const source = await readFile(sourcePath, "utf8");

const { outputText, diagnostics } = ts.transpileModule(source, {
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
const aiError = await import(moduleUrl);

const {
  BACKGROUND_MODEL_UNAVAILABLE_CODE,
  MODEL_UNAVAILABLE_I18N_KEY,
  readHttpErrorDetail,
  isBackgroundModelUnavailableError,
  resolveAiErrorMessage,
} = aiError;

let checks = 0;
let failures = 0;

function record(ok, label, detail) {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

function same(label, actual, expected) {
  record(
    Object.is(actual, expected),
    label,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function different(label, actual, unexpected) {
  record(
    !Object.is(actual, unexpected),
    label,
    `value must not equal ${JSON.stringify(unexpected)}`,
  );
}

// ============================================================
// 1. 固定合同常量
// ============================================================

same("code constant matches frozen producer contract", BACKGROUND_MODEL_UNAVAILABLE_CODE, "background_model_unavailable");
same("i18n key is the shared aiErrors key", MODEL_UNAVAILABLE_I18N_KEY, "aiErrors.modelUnavailable");

// 纯函数：不得引入运行时依赖，也不得使用文案匹配。
record(!/^\s*import\b/m.test(source), "helper has no runtime imports (pure module)");
record(!source.includes(".includes("), "helper never uses substring inference (.includes)");
record(!/new RegExp|\.match\(|\.test\(/.test(source), "helper never uses pattern matching for classification");

// ============================================================
// 2. readHttpErrorDetail：安全读取 string / object.message
// ============================================================

const structured = (status, detail, extra = {}) => ({
  response: { status, data: { detail }, ...extra },
});

same(
  "reads string detail verbatim",
  readHttpErrorDetail(structured(400, "Synthetic ordinary failure 模型 400")),
  "Synthetic ordinary failure 模型 400",
);
same(
  "reads structured detail.message",
  readHttpErrorDetail(structured(400, { code: "background_model_unavailable", message: "safe backend text" })),
  "safe backend text",
);
same(
  "reads structured message with extra detail keys",
  readHttpErrorDetail(structured(400, { code: "other", message: "extra", trace_id: "t-1" })),
  "extra",
);
same("empty string detail falls back to null", readHttpErrorDetail(structured(400, "")), null);
same("empty object detail falls back to null", readHttpErrorDetail(structured(400, {})), null);
same(
  "empty structured message falls back to null",
  readHttpErrorDetail(structured(400, { code: "background_model_unavailable", message: "" })),
  null,
);
same(
  "non-string structured message falls back to null",
  readHttpErrorDetail(structured(400, { code: "background_model_unavailable", message: 500 })),
  null,
);
same("array detail is not a message", readHttpErrorDetail(structured(400, ["模型"])), null);
same("boolean detail is not a message", readHttpErrorDetail(structured(400, true)), null);
same("null detail falls back to null", readHttpErrorDetail(structured(400, null)), null);
same("missing detail falls back to null", readHttpErrorDetail({ response: { status: 400, data: {} } }), null);
same("null data falls back to null", readHttpErrorDetail({ response: { status: 400, data: null } }), null);
same("missing response falls back to null", readHttpErrorDetail({ message: "boom" }), null);

/**
 * 标注为 [string, unknown] 元组数组：label 是 string，被测输入保持 unknown。
 * @type {Array<[string, unknown]>}
 */
const unknownInputs = [
  ["null", null],
  ["undefined", undefined],
  ["string", "boom"],
  ["number", 42],
  ["boolean", false],
  ["array", []],
  ["plain object", {}],
  ["null response", { response: null }],
  ["empty response", { response: {} }],
  ["status only", { response: { status: 400 } }],
  ["Error instance", new Error("boom")],
  ["response array", { response: [] }],
];
for (const [label, value] of unknownInputs) {
  same(`unknown input (${label}) is safe for the detail reader`, readHttpErrorDetail(value), null);
}

// ============================================================
// 3. isBackgroundModelUnavailableError：精确 code + HTTP 400
// ============================================================

const exact = structured(400, {
  code: "background_model_unavailable",
  message: "safe backend text",
});
same("exact code + 400 is unavailable", isBackgroundModelUnavailableError(exact), true);
same(
  "exact code + 400 without message still matches the code contract",
  isBackgroundModelUnavailableError(structured(400, { code: "background_model_unavailable" })),
  true,
);
same(
  "exact code + 400 with extra fields matches",
  isBackgroundModelUnavailableError(
    structured(400, { code: "background_model_unavailable", message: "safe", trace_id: "t-2" }),
  ),
  true,
);
same("code + 400 nested under a second detail level does not match", isBackgroundModelUnavailableError(structured(400, { detail: { code: "background_model_unavailable" } })), false);
same("code + 201 does not match", isBackgroundModelUnavailableError(structured(201, { code: "background_model_unavailable" })), false);
same("wrong code + 400 does not match", isBackgroundModelUnavailableError(structured(400, { code: "provider_unavailable", message: "safe" })), false);
same("case-changed code + 400 does not match", isBackgroundModelUnavailableError(structured(400, { code: "Background_Model_Unavailable" })), false);
same("code with whitespace + 400 does not match", isBackgroundModelUnavailableError(structured(400, { code: "background_model_unavailable " })), false);
same("numeric code + 400 does not match", isBackgroundModelUnavailableError(structured(400, { code: 400 })), false);
same("string detail equal to the code does not match", isBackgroundModelUnavailableError(structured(400, "background_model_unavailable")), false);
same("ordinary 400 string detail containing 模型 does not match", isBackgroundModelUnavailableError(structured(400, "普通 400：模型配置无效")), false);
same("string detail with the exact token in prose does not match", isBackgroundModelUnavailableError(structured(400, "background_model_unavailable: no model")), false);
same("message-only payload does not match", isBackgroundModelUnavailableError(structured(400, { message: "background_model_unavailable" })), false);
same("provider 502 keeps its safe failure semantics", isBackgroundModelUnavailableError(structured(502, { code: "background_model_unavailable", message: "safe" })), false);
same("status 500 with the same code does not match", isBackgroundModelUnavailableError(structured(500, { code: "background_model_unavailable" })), false);
same("string status '400' does not match", isBackgroundModelUnavailableError({ response: { status: "400", data: { detail: { code: "background_model_unavailable" } } } }), false);
same("network error without response does not match", isBackgroundModelUnavailableError({ request: {}, message: "Network Error" }), false);
same("null data with status 400 does not match", isBackgroundModelUnavailableError({ response: { status: 400, data: null } }), false);
same("null detail with status 400 does not match", isBackgroundModelUnavailableError(structured(400, null)), false);
for (const [label, value] of unknownInputs) {
  same(`unknown input (${label}) is not unavailable`, isBackgroundModelUnavailableError(value), false);
}

// ============================================================
// 4. resolveAiErrorMessage：本地化优先，否则安全 detail / fallback
// ============================================================

let translatorCalls = 0;
const translator = (key) => {
  translatorCalls += 1;
  return `t:${key}`;
};

translatorCalls = 0;
const unavailableText = resolveAiErrorMessage(exact, translator, "fallback-text");
same("unavailable resolves to the localized guidance", unavailableText, "t:aiErrors.modelUnavailable");
same("translator is used exactly once for unavailable", translatorCalls, 1);
different("unavailable never shows the backend message", unavailableText, "safe backend text");

translatorCalls = 0;
same(
  "ordinary string detail is shown as-is",
  resolveAiErrorMessage(structured(400, "普通 400：模型配置无效"), translator, "fallback-text"),
  "普通 400：模型配置无效",
);
same("translator is not used for ordinary string detail", translatorCalls, 0);

translatorCalls = 0;
same(
  "ordinary structured message is shown as-is",
  resolveAiErrorMessage(structured(502, { code: "provider_error", message: "upstream failed" }), translator, "fallback-text"),
  "upstream failed",
);
same("translator is not used for ordinary structured detail", translatorCalls, 0);

translatorCalls = 0;
same(
  "missing detail resolves to the fallback",
  resolveAiErrorMessage({ response: { status: 500, data: {} } }, translator, "fallback-text"),
  "fallback-text",
);
same("translator is not used for the fallback path", translatorCalls, 0);

same(
  "empty string detail resolves to the fallback",
  resolveAiErrorMessage(structured(400, ""), translator, "fallback-text"),
  "fallback-text",
);

console.log(`ai-error suite: ${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`ai-error suite: ${failures} check(s) failed`);
  process.exitCode = 1;
}
