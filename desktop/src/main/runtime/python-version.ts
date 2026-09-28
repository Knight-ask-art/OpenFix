export function matchesPortablePythonVersion(output: string, expectedVersion: string): boolean {
  const match = output.match(/\bPython\s+(\d+\.\d+\.\d+)\b/);
  return match?.[1] === expectedVersion;
}

/** 解析 `python --version` 输出中的 x.y.z 版本号。 */
export function parsePythonVersion(output: string): string | null {
  return output.match(/\bPython\s+(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

/**
 * 判断系统 Python 是否落在后端支持的区间内。
 * 与 backend/pyproject.toml 的 requires-python 保持一致：>=3.12,<3.14。
 */
export function isSupportedSystemPythonVersion(
  output: string,
  minMinor = 12,
  maxMinor = 13,
): boolean {
  const version = parsePythonVersion(output);
  if (!version) return false;
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (major !== 3) return false;
  return minor >= minMinor && minor <= maxMinor;
}
