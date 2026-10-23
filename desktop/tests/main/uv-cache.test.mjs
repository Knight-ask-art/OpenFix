import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  createFreshAppUvCacheDir, isUvCacheFailure, isUvCacheTempFileErrorOutput,
  resolveAppUvCacheDir, resolveExplicitUvCacheDir, runUvInstallWithCacheRecovery, withUvCacheDir,
} from "../../dist/main/runtime/uv-cache.js";

const roots = [];
async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "openfix-uv-cache-test-"));
  roots.push(root);
  const runtimeDir = path.join(root, "runtime");
  return {
    environment: { UV_INDEX_URL: "https://example.invalid/simple/", HTTPS_PROXY: "http://127.0.0.1:1" },
    processEnvironment: {}, runtimeDir, isFailure: isUvCacheFailure,
    createFreshCacheDir: (cache) => createFreshAppUvCacheDir(runtimeDir, cache),
    onRecover: () => {}, log: () => {}, ...overrides,
  };
}
after(async () => {
  for (const root of roots) {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("openfix-uv-cache-test-"));
    await rm(root, { recursive: true, force: true });
  }
});
const cacheError = new Error("Failed to inspect Python: too many temporary files exist at /uv/cache");

test("defaults to an application cache and preserves proxy/index environment", async () => {
  const options = await fixture();
  let calls = 0;
  await runUvInstallWithCacheRecovery(async (env) => {
    calls += 1;
    assert.equal(env.UV_CACHE_DIR, resolveAppUvCacheDir(options.runtimeDir));
    assert.equal(env.HTTPS_PROXY, options.environment.HTTPS_PROXY);
    assert.equal(env.UV_INDEX_URL, options.environment.UV_INDEX_URL);
  }, options);
  assert.equal(calls, 1);
});

test("explicit caller and inherited cache variables are respected and canonicalized", async () => {
  assert.equal(resolveExplicitUvCacheDir({}), null);
  assert.equal(resolveExplicitUvCacheDir({ UV_CACHE_DIR: " " }), null);
  assert.equal(resolveExplicitUvCacheDir({ uv_cache_dir: "relative-cache" }), "relative-cache");
  assert.deepEqual(withUvCacheDir({ uv_cache_dir: "old", FLAG: "1" }, "new"), { FLAG: "1", UV_CACHE_DIR: "new" });
  const options = await fixture({ processEnvironment: { uv_cache_dir: "inherited" } });
  await runUvInstallWithCacheRecovery(async (env) => {
    assert.equal(env.UV_CACHE_DIR, "inherited");
    assert.equal(env.uv_cache_dir, undefined);
  }, options);
  options.environment.UV_CACHE_DIR = "caller";
  await runUvInstallWithCacheRecovery(async (env) => assert.equal(env.UV_CACHE_DIR, "caller"), options);
});

test("cache recovery uses a unique new directory and never clears either old cache", async () => {
  const options = await fixture();
  const appCache = resolveAppUvCacheDir(options.runtimeDir);
  const shared = path.join(path.dirname(options.runtimeDir), "shared");
  await mkdir(appCache, { recursive: true });
  await mkdir(shared);
  await writeFile(path.join(appCache, "old"), "keep-app");
  await writeFile(path.join(shared, "old"), "keep-shared");
  options.processEnvironment = { uv_cache_dir: shared };
  let calls = 0;
  let recovery = 0;
  options.onRecover = () => { recovery += 1; };
  await runUvInstallWithCacheRecovery(async (env, output) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(env.UV_CACHE_DIR, shared);
      output(cacheError.message);
      throw cacheError;
    }
    assert.equal(path.dirname(env.UV_CACHE_DIR), options.runtimeDir);
    assert.match(path.basename(env.UV_CACHE_DIR), /^uv-cache-recovery-/);
    assert.equal(env.uv_cache_dir, undefined);
    assert.equal(env.UV_INDEX_URL, options.environment.UV_INDEX_URL);
    await writeFile(path.join(env.UV_CACHE_DIR, "new"), "new-cache");
  }, options);
  assert.equal(calls, 2);
  assert.equal(recovery, 1);
  assert.equal(await readFile(path.join(appCache, "old"), "utf8"), "keep-app");
  assert.equal(await readFile(path.join(shared, "old"), "utf8"), "keep-shared");
});

test("second failure is propagated with no further retries", async () => {
  const options = await fixture();
  let calls = 0;
  const second = new Error("recovery failed");
  await assert.rejects(runUvInstallWithCacheRecovery(async () => {
    calls += 1;
    throw calls === 1 ? cacheError : second;
  }, options), (error) => error === second);
  assert.equal(calls, 2);
});

test("network, TLS, executable permission and unrelated temp errors do not trigger cache recovery", async () => {
  for (const message of [
    "Failed to download https://example.invalid/cache/package.whl",
    "invalid peer certificate; Consider enabling use of system TLS certificates",
    "spawn uv EACCES", "No module named ensurepip", "too many temporary files exist at /other/path",
  ]) {
    const options = await fixture();
    let calls = 0;
    const error = new Error(message);
    await assert.rejects(runUvInstallWithCacheRecovery(async (_env, output) => {
      calls += 1; output(message); throw error;
    }, options), (value) => value === error);
    assert.equal(calls, 1, message);
  }
  assert.equal(isUvCacheTempFileErrorOutput(cacheError.message), true);
  assert.equal(await isUvCacheFailure(new Error("Failed to initialize the cache"), ""), true);
});

test("fresh cache helper rejects an arbitrary directory argument without touching it", async () => {
  const options = await fixture();
  await assert.rejects(createFreshAppUvCacheDir(options.runtimeDir, path.dirname(options.runtimeDir)));
});
