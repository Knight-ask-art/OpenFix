/**
 * AI 请求错误的稳定判定与安全展示读取。
 *
 * 后端对「后台轻量模型不可用」使用固定的结构化 detail（HTTP 400）：
 * `{ code: "background_model_unavailable", message: <已脱敏文案> }`。
 *
 * 只有「HTTP 400 + 完全相同的 code」才判定为模型不可用；其余错误
 * （含普通 400 的字符串 detail）一律沿用调用方原有的字符串处理，
 * 绝不根据文案内容、关键字或前缀推断，也不做模型回退或自动配置。
 */

/** 后端 BackgroundModelUnavailableError 的固定错误码。 */
export const BACKGROUND_MODEL_UNAVAILABLE_CODE = "background_model_unavailable";

/** 模型不可用时的共享 i18n key。 */
export const MODEL_UNAVAILABLE_I18N_KEY = "aiErrors.modelUnavailable";

const BACKGROUND_MODEL_UNAVAILABLE_STATUS = 400;

/** 仅需「按 key 取文案」的最小翻译函数签名。 */
export type AiErrorTranslator = (key: string) => string;

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * 读取 HTTP 错误中可安全展示的 detail。
 *
 * 支持字符串 detail，以及结构化 detail 的 message 字段；空字符串、
 * 缺失字段、非字符串值都返回 null，交由调用方回退到原来的默认文案。
 */
export function readHttpErrorDetail(error: unknown): string | null {
  const response = toRecord(toRecord(error)?.["response"]);
  const detail = toRecord(response?.["data"])?.["detail"];
  if (typeof detail === "string") return detail.length > 0 ? detail : null;
  const message = toRecord(detail)?.["message"];
  return typeof message === "string" && message.length > 0 ? message : null;
}

/** 精确判定：状态码为 400，且 detail.code 恰好等于后台模型不可用错误码。 */
export function isBackgroundModelUnavailableError(error: unknown): boolean {
  const response = toRecord(toRecord(error)?.["response"]);
  if (!response || response["status"] !== BACKGROUND_MODEL_UNAVAILABLE_STATUS) return false;
  const detail = toRecord(toRecord(response["data"])?.["detail"]);
  return detail?.["code"] === BACKGROUND_MODEL_UNAVAILABLE_CODE;
}

/**
 * 统一的错误展示文案：
 * 命中固定错误码时返回本地化引导，否则返回安全 detail，再否则返回调用方默认文案。
 */
export function resolveAiErrorMessage(
  error: unknown,
  t: AiErrorTranslator,
  fallback: string,
): string {
  if (isBackgroundModelUnavailableError(error)) return t(MODEL_UNAVAILABLE_I18N_KEY);
  return readHttpErrorDetail(error) ?? fallback;
}
