/**
 * 发布产物静态校验。
 *
 * 打包完成后运行，逐项检查「装出来能不能用」的关键不变量：
 *   - 发布关键配置：四处版本号一致、更新源身份只有一个来源、分段下载开关放在能生效的位置
 *   - 产物齐全且文件名架构后缀已规范化
 *   - latest.yml 指向的文件真实存在、sha512 与实际一致（否则自动更新 404）
 *   - 内置后端 wheel 与桌面版本号匹配（否则运行时不会安装我们的后端）
 *   - app-update.yml 指向 OpenFix 自有 GitHub 更新源
 *   - Release-prepared x86_64 / aarch64 channel 清单与安装包一致
 *   - 前端产物确实含 V1 新页面（防止打进旧 frontend/dist）
 *
 * 用法：node scripts/verify-release.mjs [dist-electron 目录]
 *       node scripts/verify-release.mjs --config-only       只跑配置项（PR 门禁，不需要产物）
 *       node scripts/verify-release.mjs --prepared-update-assets
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliArgs = process.argv.slice(2);
const verifyPreparedUpdateAssets = cliArgs.includes("--prepared-update-assets");
const verifyConfigurationOnly = cliArgs.includes("--config-only");
const outputDirectoryArgument = cliArgs.find((argument) => !argument.startsWith("--"));
const outputDir = path.resolve(outputDirectoryArgument ?? path.join(desktopDir, "dist-electron"));
const desktopPackage = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const version = desktopPackage.version;
const expectedReleaseVersion = process.env.OPENFIX_RELEASE_VERSION?.trim() || null;
const isGitHubActions = process.env.GITHUB_ACTIONS === "true";
const updateRepository = { owner: "Knight-ask-art", repo: "OpenFix" };

const failures = [];
const checks = [];

function check(name, condition, detail = "") {
  checks.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

function sha512Base64(filePath) {
  return createHash("sha512").update(readFileSync(filePath)).digest("base64");
}

function getAssetFileName(reference) {
  const withoutQueryOrHash = reference.trim().split(/[?#]/, 1)[0];
  return path.posix.basename(decodeURIComponent(withoutQueryOrHash));
}

function verifyUpdateManifest(name, content, expectedArchitecture = null) {
  const manifestVersion = content.match(/^version:\s*(\S+)/m)?.[1];
  check(`${name} version matches desktop package`, manifestVersion === version, manifestVersion ?? "缺少 version");

  const files = [...content.matchAll(/^[ \t]*-[ \t]+url:[ \t]*(.+)\r?\n[ \t]+sha512:[ \t]*(\S+)\r?\n[ \t]+size:[ \t]*(\d+)/gm)]
    .map((match) => ({ name: getAssetFileName(match[1]), sha512: match[2], size: Number(match[3]) }));
  check(`${name} includes update assets`, files.length > 0);

  if (expectedArchitecture) {
    const expectedInstaller = `OpenFix-${version}-win-${expectedArchitecture}-setup.exe`;
    check(`${name} references ${expectedArchitecture} installer`, files.some((file) => file.name === expectedInstaller), files.map((file) => file.name).join(", "));
    const manifestPath = content.match(/^path:\s*(.+)$/m)?.[1];
    check(`${name} path matches ${expectedArchitecture} installer`, getAssetFileName(manifestPath ?? "") === expectedInstaller, manifestPath ?? "缺少 path");
  }

  for (const file of files) {
    const assetPath = path.join(outputDir, file.name);
    if (!existsSync(assetPath)) {
      check(`${name} asset exists: ${file.name}`, false);
      continue;
    }
    check(`${name} sha512 matches ${file.name}`, sha512Base64(assetPath) === file.sha512);
    check(`${name} size matches ${file.name}`, statSync(assetPath).size === file.size);
  }

  const pathValue = content.match(/^path:\s*(.+)$/m)?.[1];
  if (pathValue) {
    const pathName = getAssetFileName(pathValue);
    check(`${name} path asset exists: ${pathName}`, existsSync(path.join(outputDir, pathName)));
  }
}

function printResultsAndExit() {
  for (const { name, ok, detail } of checks) {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? `  (${detail})` : ""}`);
  }

  console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

if (expectedReleaseVersion || (isGitHubActions && !verifyConfigurationOnly)) {
  // CI release guard: the v* tag that triggered the workflow must match the
  // desktop package version, otherwise installers and manifests would be
  // published under a version the release tag does not describe. GitHub Actions
  // always passes OPENFIX_RELEASE_VERSION, so an absent or blank value there is a
  // workflow wiring bug and must fail instead of silently skipping the assertion.
  check(
    "release tag version matches desktop package version",
    expectedReleaseVersion === version,
    expectedReleaseVersion
      ? `release tag ${expectedReleaseVersion}, desktop package ${version}`
      : "OPENFIX_RELEASE_VERSION is unset or blank in GitHub Actions",
  );
}

// 发布关键配置：这些偏差不会让构建失败，只会让界面版本号或更新源静默错位。
// 只读取扁平的 `键: 值` 行，足够覆盖下面这几个配置文件（不引入 YAML 依赖）。
function readYamlScalars(content, blockKey = null) {
  const scalars = new Map();
  let collecting = blockKey === null;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indented = /^[ \t]/.test(line);
    if (blockKey !== null && !collecting) {
      if (trimmed === `${blockKey}:`) collecting = true;
      continue;
    }
    if (blockKey !== null && !indented) break;
    if (blockKey === null && indented) continue;
    const match = line.match(/^[ \t]*([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (match) {
      const value = match[2].trim();
      scalars.set(match[1], /^".*"$|^'.*'$/.test(value) ? value.slice(1, -1) : value);
    }
  }
  return scalars;
}

const repositoryRoot = path.resolve(desktopDir, "..");
const frontendPackage = JSON.parse(readFileSync(path.join(repositoryRoot, "frontend", "package.json"), "utf8"));
const backendPyproject = readFileSync(path.join(repositoryRoot, "backend", "pyproject.toml"), "utf8");
const backendLock = readFileSync(path.join(repositoryRoot, "backend", "uv.lock"), "utf8");
const releasePleaseManifest = JSON.parse(readFileSync(path.join(repositoryRoot, ".release-please-manifest.json"), "utf8"));
const builderConfig = readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf8");
const publishConfig = readYamlScalars(builderConfig, "publish");
const updaterSource = readFileSync(path.join(desktopDir, "src", "main", "updater.ts"), "utf8");

// 版本号散落在四处（前端界面、桌面包、后端 wheel、依赖锁），漏改一处不会被既有门禁全部拦住。
check("frontend/package.json version matches desktop package", frontendPackage.version === version, `${frontendPackage.version} vs ${version}`);
const pyprojectVersion = backendPyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
check("backend/pyproject.toml version matches desktop package", pyprojectVersion === version, `${pyprojectVersion ?? "缺少 version"} vs ${version}`);
const lockedVersion = backendLock.match(/\[\[package\]\]\r?\nname = "openfic"\r?\nversion = "([^"]+)"/)?.[1];
check("backend/uv.lock editable openfic version matches desktop package", lockedVersion === version, `${lockedVersion ?? "缺少 openfic 版本"} vs ${version}`);
check(".release-please-manifest.json version matches desktop package", releasePleaseManifest["."] === version, `${releasePleaseManifest["."] ?? "缺失"} vs ${version}`);

// 更新源身份：桌面代码里的常量、electron-builder publish、仓库内参照文件必须说同一件事。
const updaterOwner = updaterSource.match(/UPDATE_GITHUB_OWNER\s*=\s*"([^"]+)"/)?.[1];
const updaterRepo = updaterSource.match(/UPDATE_GITHUB_REPO\s*=\s*"([^"]+)"/)?.[1];
check("electron-builder publish provider is github", publishConfig.get("provider") === "github", publishConfig.get("provider") ?? "缺失");
check("electron-builder publish owner matches updater.ts", publishConfig.get("owner") === updaterOwner, `${publishConfig.get("owner") ?? "缺失"} vs ${updaterOwner ?? "缺失"}`);
check("electron-builder publish repo matches updater.ts", publishConfig.get("repo") === updaterRepo, `${publishConfig.get("repo") ?? "缺失"} vs ${updaterRepo ?? "缺失"}`);

const referenceUpdateConfigPath = path.join(desktopDir, "resources", "app-update.yml");
const referenceUpdateConfig = readYamlScalars(readFileSync(referenceUpdateConfigPath, "utf8"));
const identityKeys = ["provider", "owner", "repo", "releaseType"];
const identityMismatches = identityKeys.filter((key) => referenceUpdateConfig.get(key) !== publishConfig.get(key));
check(
  "resources/app-update.yml 与 electron-builder publish 身份一致",
  identityMismatches.length === 0,
  identityMismatches.map((key) => `${key}: ${referenceUpdateConfig.get(key) ?? "缺失"} vs ${publishConfig.get(key) ?? "缺失"}`).join(", "),
);

// 分段下载开关：GitHub provider 的 publish 不允许该字段（electron-builder 会以
// Invalid configuration object 中断打包），而 electron-updater 对 GitHub 源本来就强制单段下载；
// 只有 generic 源自读该开关，所以它必须声明在 generic 通道上。
check(
  "GitHub publish 不含 useMultipleRangeRequest（该位置会让打包失败）",
  !publishConfig.has("useMultipleRangeRequest"),
  "electron-builder 拒绝 GitHub publish 上的未知字段",
);
const localUpdateConfigPath = path.join(desktopDir, "electron-builder.local-update.yml");
if (existsSync(localUpdateConfigPath)) {
  const localUpdatePublish = readYamlScalars(readFileSync(localUpdateConfigPath, "utf8"), "publish");
  check(
    "本地更新通道（generic）声明 useMultipleRangeRequest: false",
    localUpdatePublish.get("provider") === "generic" && localUpdatePublish.get("useMultipleRangeRequest") === "false",
    `${localUpdatePublish.get("provider") ?? "缺失"}, useMultipleRangeRequest=${localUpdatePublish.get("useMultipleRangeRequest") ?? "缺失"}`,
  );
} else {
  check("本地更新通道配置存在", false, "缺失 electron-builder.local-update.yml");
}

if (verifyConfigurationOnly) {
  console.log(`verify-release: 配置项 (版本 ${version})\n`);
  printResultsAndExit();
}

console.log(
  `verify-release: ${outputDir} (version ${version}, ${verifyPreparedUpdateAssets ? "prepared update assets" : "package"})\n`,
);

if (verifyPreparedUpdateAssets) {
  // This mode runs after both Windows architecture artifacts are downloaded and
  // prepare-windows-update has generated the release manifests. The ordinary
  // package verifier runs earlier, before these cross-architecture files exist.
  const compatibilityManifestPath = path.join(outputDir, "latest.yml");
  if (existsSync(compatibilityManifestPath)) {
    const compatibilityManifest = readFileSync(compatibilityManifestPath, "utf8");
    verifyUpdateManifest("latest.yml", compatibilityManifest);
    const compatibilityUrls = [
      ...compatibilityManifest.matchAll(/^[ \t]*-[ \t]+url:[ \t]*(.+)$/gm),
    ].map((match) => match[1].trim());
    for (const { architecture, legacyArchitecture } of [
      { architecture: "x86_64", legacyArchitecture: "x64" },
      { architecture: "aarch64", legacyArchitecture: "arm64" },
    ]) {
      const installer = `OpenFix-${version}-win-${architecture}-setup.exe`;
      check(
        `latest.yml references ${architecture} installer`,
        compatibilityUrls.some((reference) => getAssetFileName(reference) === installer),
        compatibilityUrls.join(", "),
      );
      check(
        `latest.yml retains ${legacyArchitecture} compatibility alias`,
        compatibilityUrls.some((reference) => {
          const [assetReference, query = ""] = reference.split("?", 2);
          return (
            getAssetFileName(assetReference) === installer &&
            new URLSearchParams(query).get("arch") === legacyArchitecture
          );
        }),
        compatibilityUrls.join(", "),
      );
    }
    const compatibilityPath = compatibilityManifest.match(/^path:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const compatibilityPathQuery = compatibilityPath.split("?", 2)[1] ?? "";
    check(
      "latest.yml default path targets the x86_64 installer",
      getAssetFileName(compatibilityPath) === `OpenFix-${version}-win-x86_64-setup.exe` &&
        new URLSearchParams(compatibilityPathQuery).get("arch") === "x64",
      compatibilityPath,
    );
  } else {
    check("latest.yml exists after Windows update preparation", false);
  }

  for (const architecture of ["x86_64", "aarch64"]) {
    const manifestPath = path.join(outputDir, `latest-win-${architecture}.yml`);
    if (!existsSync(manifestPath)) {
      check(`latest-win-${architecture}.yml exists`, false);
      continue;
    }
    verifyUpdateManifest(
      `latest-win-${architecture}.yml`,
      readFileSync(manifestPath, "utf8"),
      architecture,
    );
  }
  printResultsAndExit();
}

// 1. 产物齐全 + 架构后缀已规范化
const artifacts = listFiles(outputDir);
const setupExe = artifacts.find((name) => /^.+-win-x86_64-setup\.exe$/.test(name));
const portableZip = artifacts.find((name) => /^.+-win-x86_64\.zip$/.test(name));
const blockmap = artifacts.find((name) => /^.+-win-x86_64-setup\.exe\.blockmap$/.test(name));

check("setup 安装包存在且架构后缀为 x86_64", Boolean(setupExe), artifacts.join(", "));
check("setup 安装包使用 OpenFix 产品名", Boolean(setupExe?.startsWith(`OpenFix-${version}-`)), setupExe ?? "缺少 setup");
check("便携 zip 存在且架构后缀为 x86_64", Boolean(portableZip));
check("便携 zip 使用 OpenFix 产品名", Boolean(portableZip?.startsWith(`OpenFix-${version}-`)), portableZip ?? "缺少 zip");
check("setup blockmap 存在", Boolean(blockmap));
check("setup blockmap 使用 OpenFix 产品名", Boolean(blockmap?.startsWith(`OpenFix-${version}-`)), blockmap ?? "缺少 blockmap");
check(
  "产物名不含未规范化的 x64 后缀",
  !artifacts.some((name) => /-win-x64(-|\.)/.test(name)),
  artifacts.filter((name) => /-win-x64(-|\.)/.test(name)).join(", "),
);

// 2. latest.yml 与实际产物一致；兼容 URL 可带 ?arch=x64 / ?arch=arm64。
const latestYmlPath = path.join(outputDir, "latest.yml");
if (existsSync(latestYmlPath)) {
  const latestYml = readFileSync(latestYmlPath, "utf8");
  const referencedNames = [...latestYml.matchAll(/^[ \t]*-[ \t]+url:[ \t]*(.+)$/gm)].map((match) => getAssetFileName(match[1]));
  const pathMatch = latestYml.match(/^path:\s*(.+)$/m);
  if (pathMatch) referencedNames.push(getAssetFileName(pathMatch[1]));
  const missing = referencedNames.filter((name) => !existsSync(path.join(outputDir, name)));
  check("latest.yml 引用的文件均存在", missing.length === 0, `缺失: ${missing.join(", ")}`);
  check(
    "latest.yml 指向 setup 安装包",
    referencedNames.some((name) => name.endsWith("-win-x86_64-setup.exe")),
    referencedNames.join(", "),
  );
  verifyUpdateManifest("latest.yml", latestYml);
} else {
  check("latest.yml 存在（自动更新元数据）", false, "缺失 latest.yml");
}

// 3. 内置后端 wheel 与版本匹配
const wheelDir = path.join(outputDir, "win-unpacked", "resources", "backend-wheel");
if (existsSync(wheelDir)) {
  const wheels = listFiles(wheelDir).filter((name) => name.endsWith(".whl"));
  const matchingWheels = wheels.filter((name) => name.startsWith(`openfic-${version}-`));
  check(
    `内置后端只包含版本 ${version} 的 wheel`,
    wheels.length === 1 && matchingWheels.length === 1,
    wheels.join(", ") || "无 wheel",
  );
  const bundledUvPath = path.join(wheelDir, "uv.exe.gz");
  check("压缩内置 uv 安装器可用于 Windows 首次安装", existsSync(bundledUvPath), "缺少 backend-wheel/uv.exe.gz");
} else {
  check("win-unpacked 内含 backend-wheel 资源", false, "缺失 backend-wheel 目录");
}

// 4. 更新源必须精确指向 OpenFix 自有 GitHub Releases。
const appUpdateYml = path.join(outputDir, "win-unpacked", "resources", "app-update.yml");
if (existsSync(appUpdateYml)) {
  const content = readFileSync(appUpdateYml, "utf8");
  check("app-update.yml uses the GitHub provider", /^provider:\s*github\s*$/m.test(content));
  check("app-update.yml owner is OpenFix owner", new RegExp(`^owner:\\s*${updateRepository.owner}\\s*$`, "m").test(content));
  check("app-update.yml repo is OpenFix", new RegExp(`^repo:\\s*${updateRepository.repo}\\s*$`, "m").test(content));
  check("app-update.yml does not use an upstream or disabled feed", !/syrizelink|OpenFic|disabled-openfix-updates|127\.0\.0\.1/i.test(content));
} else {
  check("win-unpacked 内含 app-update.yml", false, "缺失 app-update.yml");
}

// 5. Release-prepared metadata must provide both Windows architecture channels.
const architectureManifests = [
  ["x86_64", path.join(outputDir, "latest-win-x86_64.yml")],
  ["aarch64", path.join(outputDir, "latest-win-aarch64.yml")],
];
const hasArchitectureManifest = architectureManifests.some(([, manifestPath]) => existsSync(manifestPath));
if (hasArchitectureManifest) {
  for (const [architecture, manifestPath] of architectureManifests) {
    if (!existsSync(manifestPath)) {
      check(`latest-win-${architecture}.yml exists`, false);
      continue;
    }
    verifyUpdateManifest(`latest-win-${architecture}.yml`, readFileSync(manifestPath, "utf8"), architecture);
  }
}

// 6. 前端产物包含 V1 新页面
const frontendIndex = path.join(outputDir, "win-unpacked", "resources", "frontend-dist", "index.html");
if (existsSync(frontendIndex)) {
  const assetsDir = path.join(outputDir, "win-unpacked", "resources", "frontend-dist", "assets");
  const bundleName = readFileSync(frontendIndex, "utf8").match(/assets\/(index-[^"']+\.js)/)?.[1];
  if (bundleName && existsSync(path.join(assetsDir, bundleName))) {
    const bundle = readFileSync(path.join(assetsDir, bundleName), "utf8");
    for (const marker of [
      "/story-memory",
      "/consistency",
      "/inline-ai/transform",
      "openfix.onboarding.completed",
      "openfix.ai.projectId",
      "chapter-meta",
      "/profile",
    ]) {
      check(`前端产物含 ${marker}`, bundle.includes(marker));
    }
  } else {
    check("前端 index 引用的主 bundle 可读", false, bundleName ?? "未找到 bundle 引用");
  }
} else {
  check("win-unpacked 内含 frontend-dist", false, "缺失 frontend-dist");
}

printResultsAndExit();
