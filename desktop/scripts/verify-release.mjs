/**
 * 发布产物静态校验。
 *
 * 打包完成后运行，逐项检查「装出来能不能用」的关键不变量：
 *   - 产物齐全且文件名架构后缀已规范化
 *   - latest.yml 指向的文件真实存在、sha512 与实际一致（否则自动更新 404）
 *   - 内置后端 wheel 与桌面版本号匹配（否则运行时不会安装我们的后端）
 *   - app-update.yml 未回退到上游 OpenFic 更新源
 *   - 前端产物确实含 V1 新页面（防止打进旧 frontend/dist）
 *
 * 用法：node scripts/verify-release.mjs [dist-electron 目录]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.resolve(process.argv[2] ?? path.join(desktopDir, "dist-electron"));
const desktopPackage = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const version = desktopPackage.version;

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

console.log(`verify-release: ${outputDir} (version ${version})\n`);

// 1. 产物齐全 + 架构后缀已规范化
const artifacts = listFiles(outputDir);
const setupExe = artifacts.find((name) => /^.+-win-x86_64-setup\.exe$/.test(name));
const portableZip = artifacts.find((name) => /^.+-win-x86_64\.zip$/.test(name));
const blockmap = artifacts.find((name) => /^.+-win-x86_64-setup\.exe\.blockmap$/.test(name));

check("setup 安装包存在且架构后缀为 x86_64", Boolean(setupExe), artifacts.join(", "));
check("便携 zip 存在且架构后缀为 x86_64", Boolean(portableZip));
check("setup blockmap 存在", Boolean(blockmap));
check(
  "产物名不含未规范化的 x64 后缀",
  !artifacts.some((name) => /-win-x64(-|\.)/.test(name)),
  artifacts.filter((name) => /-win-x64(-|\.)/.test(name)).join(", "),
);

// 2. latest.yml 与实际产物一致
const latestYmlPath = path.join(outputDir, "latest.yml");
if (existsSync(latestYmlPath)) {
  const latestYml = readFileSync(latestYmlPath, "utf8");
  const referencedNames = [...latestYml.matchAll(/^\s*-?\s*url:\s*(.+)$/gm)].map((m) => m[1].trim());
  const pathMatch = latestYml.match(/^path:\s*(.+)$/m);
  if (pathMatch) referencedNames.push(pathMatch[1].trim());
  const missing = referencedNames.filter((name) => !existsSync(path.join(outputDir, name)));
  check("latest.yml 引用的文件均存在", missing.length === 0, `缺失: ${missing.join(", ")}`);
  check(
    "latest.yml 指向 setup 安装包",
    referencedNames.some((name) => name.endsWith("-win-x86_64-setup.exe")),
    referencedNames.join(", "),
  );
  for (const match of latestYml.matchAll(/url:\s*(.+)\n\s*sha512:\s*(\S+)/g)) {
    const [, name, sha512] = match;
    const target = path.join(outputDir, name.trim());
    if (!existsSync(target)) continue;
    check(`latest.yml sha512 与 ${name.trim()} 一致`, sha512Base64(target) === sha512.trim());
  }
  const sizeMatch = latestYml.match(/url:\s*(.+)\n\s*sha512:\s*\S+\n\s*size:\s*(\d+)/);
  if (sizeMatch) {
    const [, name, size] = sizeMatch;
    const target = path.join(outputDir, name.trim());
    if (existsSync(target)) {
      check(`latest.yml size 与 ${name.trim()} 一致`, statSync(target).size === Number(size));
    }
  }
} else {
  check("latest.yml 存在（自动更新元数据）", false, "缺失 latest.yml");
}

// 3. 内置后端 wheel 与版本匹配
const wheelDir = path.join(outputDir, "win-unpacked", "resources", "backend-wheel");
if (existsSync(wheelDir)) {
  const wheels = listFiles(wheelDir).filter((name) => name.endsWith(".whl"));
  check(
    `内置后端 wheel 与版本 ${version} 匹配`,
    wheels.some((name) => name.startsWith(`openfic-${version}-`)),
    wheels.join(", ") || "无 wheel",
  );
} else {
  check("win-unpacked 内含 backend-wheel 资源", false, "缺失 backend-wheel 目录");
}

// 4. 更新源不得回退到上游
const appUpdateYml = path.join(outputDir, "win-unpacked", "resources", "app-update.yml");
if (existsSync(appUpdateYml)) {
  const content = readFileSync(appUpdateYml, "utf8");
  check(
    "app-update.yml 未指向上游 OpenFic",
    !/syrizelink|OpenFic/i.test(content),
    content.replace(/\n/g, " | "),
  );
}

// 5. 前端产物包含 V1 新页面
const frontendIndex = path.join(outputDir, "win-unpacked", "resources", "frontend-dist", "index.html");
if (existsSync(frontendIndex)) {
  const assetsDir = path.join(outputDir, "win-unpacked", "resources", "frontend-dist", "assets");
  const bundleName = readFileSync(frontendIndex, "utf8").match(/assets\/(index-[^"']+\.js)/)?.[1];
  if (bundleName && existsSync(path.join(assetsDir, bundleName))) {
    const bundle = readFileSync(path.join(assetsDir, bundleName), "utf8");
    for (const marker of ["/story-memory", "/consistency", "/inline-ai/transform", "openfix.onboarding.completed"]) {
      check(`前端产物含 ${marker}`, bundle.includes(marker));
    }
  } else {
    check("前端 index 引用的主 bundle 可读", false, bundleName ?? "未找到 bundle 引用");
  }
} else {
  check("win-unpacked 内含 frontend-dist", false, "缺失 frontend-dist");
}

for (const { name, ok, detail } of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? `  (${detail})` : ""}`);
}

console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
