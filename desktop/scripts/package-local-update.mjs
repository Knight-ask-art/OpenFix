import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wheelDir = path.join(desktopDir, "backend-wheel");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const version = process.env.OPENFIX_UPDATE_VERSION ?? process.env.OPENFIC_UPDATE_VERSION;

if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Local update version is not a valid semantic version: ${version}`);
}

// 打包版运行时按 app.getVersion() 查找内置 wheel，未传 extraMetadata.version 时即 package.json 版本。
const packageVersion = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8")).version;
const effectiveVersion = version ?? packageVersion;

// 内置 wheel 的版本来自 backend/pyproject.toml 的静态 [project] version：
// hatchling 没有版本覆盖入口，改动版本必须改 project metadata。
function readBackendWheelVersion() {
  const pyproject = readFileSync(path.join(desktopDir, "..", "backend", "pyproject.toml"), "utf8");
  let insideProjectSection = false;
  for (const line of pyproject.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      insideProjectSection = section[1].trim() === "project";
      continue;
    }
    if (!insideProjectSection) continue;
    const declared = /^\s*version\s*=\s*"([^"]+)"/.exec(line);
    if (declared) return declared[1];
  }
  return null;
}

const backendVersion = readBackendWheelVersion();
if (!backendVersion) {
  throw new Error(
    "Cannot read [project] version from backend/pyproject.toml, so the bundled backend wheel version is unknown. Refusing to package a local update that may fall back to the public PyPI openfic package.",
  );
}

// 版本不一致时必须提前失败：运行时匹配不到 openfic-<version>-*.whl 就会静默回退到公共 PyPI 上的 upstream OpenFic。
// 现有工具链（uv build + hatchling 静态版本）无法在不修改 backend project metadata 的前提下产出其他版本的 wheel。
if (effectiveVersion !== backendVersion) {
  throw new Error(
    [
      `Local update version ${effectiveVersion} does not match the backend wheel version ${backendVersion}.`,
      "The packaged app resolves its bundled backend by app version, so a mismatched wheel would silently fall back to the public PyPI openfic package.",
      `Set [project] version in backend/pyproject.toml to ${effectiveVersion} and rebuild the wheel, or drop OPENFIC_UPDATE_VERSION to package ${backendVersion}.`,
    ].join("\n"),
  );
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpm, args, { shell: process.platform === "win32", stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${pnpm} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`node ${args.join(" ")} exited with code ${code}`));
    });
  });
}

const versionConfig = version ? [`--config.extraMetadata.version=${version}`] : [];

await run(["build"]);
// 与 release 打包一致：先构建并暂存版本匹配的内置后端 wheel，再交给 electron-builder 打进安装包。
await runNode(["scripts/build-backend-wheel.mjs"]);

const bundledWheels = readdirSync(wheelDir).filter(
  (name) => name.startsWith(`openfic-${effectiveVersion}-`) && name.endsWith(".whl"),
);
if (bundledWheels.length === 0) {
  throw new Error(
    `No openfic-${effectiveVersion}-*.whl staged in desktop/backend-wheel. Refusing to package a local update that would fall back to the public PyPI openfic package.`,
  );
}
console.log(`package-local-update: bundling ${bundledWheels.join(", ")}`);

await run([
  "exec",
  "electron-builder",
  "--config",
  "electron-builder.local-update.yml",
  "--win",
  "nsis",
  "--x64",
  "--publish",
  "never",
  ...versionConfig,
]);
await run([
  "exec",
  "electron-builder",
  "--config",
  "electron-builder.local-update.yml",
  "--win",
  "nsis",
  "--arm64",
  "--publish",
  "never",
  ...versionConfig,
]);
await runNode(["scripts/normalize-artifact-names.mjs"]);
await runNode(["scripts/prepare-windows-update.mjs"]);
