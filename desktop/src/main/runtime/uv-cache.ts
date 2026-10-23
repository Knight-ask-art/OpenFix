import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";

export function resolveAppUvCacheDir(runtimeDir: string): string {
  return path.join(runtimeDir, "uv-cache");
}

export function resolveExplicitUvCacheDir(environment: NodeJS.ProcessEnv): string | null {
  const entry = Object.entries(environment).find(([key, value]) =>
    key.toUpperCase() === "UV_CACHE_DIR" && Boolean(value?.trim()));
  return entry?.[1]?.trim() ?? null;
}

/** Canonicalize the Windows environment key so an inherited lowercase key cannot win. */
export function withUvCacheDir(environment: NodeJS.ProcessEnv, cacheDir: string | null): NodeJS.ProcessEnv {
  if (cacheDir === null) return { ...environment };
  const result = Object.fromEntries(Object.entries(environment).filter(([key]) => key.toUpperCase() !== "UV_CACHE_DIR"));
  return { ...result, UV_CACHE_DIR: cacheDir };
}

export function isUvCacheTempFileErrorOutput(output: string): boolean {
  return /failed to initialize (?:the )?cache/i.test(output)
    || (/\bcache\b/i.test(output) && (
      /too many temporary files exist/i.test(output)
      || /failed to (?:create|persist|write|rename)[^\n]*\bcache\b/i.test(output)
    ));
}

/** Executable permission errors and network/TLS failures do not prove cache damage. */
export async function isUvCacheFailure(error: unknown, output: string): Promise<boolean> {
  return isUvCacheTempFileErrorOutput(output || (error instanceof Error ? error.message : ""));
}

export interface UvInstallRecoveryOptions {
  environment: NodeJS.ProcessEnv;
  processEnvironment?: NodeJS.ProcessEnv;
  runtimeDir: string;
  isFailure: (error: unknown, output: string, cacheDir: string, usesAppCacheDir: boolean) => Promise<boolean>;
  createFreshCacheDir: (appCacheDir: string) => Promise<string>;
  onRecover: () => void;
  log: (message: string) => void;
}

/** One recovery attempt. Existing application and explicitly configured caches are never removed. */
export async function runUvInstallWithCacheRecovery(
  runInstall: (environment: NodeJS.ProcessEnv, onFailureOutput: (output: string) => void) => Promise<void>,
  options: UvInstallRecoveryOptions,
): Promise<void> {
  const inherited = options.processEnvironment ?? process.env;
  const explicit = resolveExplicitUvCacheDir(options.environment) ?? resolveExplicitUvCacheDir(inherited);
  const cacheDir = explicit ?? resolveAppUvCacheDir(options.runtimeDir);
  const environment = withUvCacheDir({ ...inherited, ...options.environment }, cacheDir);
  let output = "";
  try {
    await runInstall(environment, (value) => { output = value; });
    return;
  } catch (error) {
    if (!(await options.isFailure(error, output, cacheDir, explicit === null))) throw error;
    const fresh = await options.createFreshCacheDir(resolveAppUvCacheDir(options.runtimeDir));
    options.onRecover();
    options.log("uv 缓存不可用，保留旧缓存并使用新的独立目录重试一次");
    await runInstall(withUvCacheDir(environment, fresh), () => undefined);
  }
}

export async function createFreshAppUvCacheDir(
  runtimeDir: string,
  appCacheDir = resolveAppUvCacheDir(runtimeDir),
): Promise<string> {
  const runtimeRoot = path.resolve(runtimeDir);
  if (path.resolve(appCacheDir) !== path.resolve(resolveAppUvCacheDir(runtimeRoot))) {
    throw new Error("拒绝为非应用 uv 缓存创建恢复目录");
  }
  await mkdir(runtimeRoot, { recursive: true });
  return mkdtemp(path.join(runtimeRoot, "uv-cache-recovery-"));
}
