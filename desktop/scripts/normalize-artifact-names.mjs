import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = path.resolve(process.argv[2] ?? "dist-electron");
const productName = process.env.OPENFIX_PRODUCT_NAME ?? "OpenFix";
const architectureNames = new Map([
  ["arm_aarch64", "aarch64"],
  ["x64", "x86_64"],
  ["arm64", "aarch64"],
]);

function normalizeArtifactName(fileName) {
  let normalized = fileName;
  for (const [electronArch, artifactArch] of architectureNames) {
    normalized = normalized.replaceAll(`-${electronArch}-`, `-${artifactArch}-`);
    normalized = normalized.replaceAll(`-${electronArch}.`, `-${artifactArch}.`);
  }
  return normalized;
}

for (const entry of await readdir(outputDirectory, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const normalizedName = normalizeArtifactName(entry.name);
  if (normalizedName === entry.name) continue;
  await rename(path.join(outputDirectory, entry.name), path.join(outputDirectory, normalizedName));
}

for (const entry of await readdir(outputDirectory, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const staleArtifact = new RegExp(`^${productName}-.+-win-setup\\.exe(?:\\.blockmap)?$`);
  if (!staleArtifact.test(entry.name)) continue;
  if (entry.name.includes("-win-x86_64-setup") || entry.name.includes("-win-aarch64-setup")) continue;
  await rm(path.join(outputDirectory, entry.name));
}

// electron-updater 依赖 latest.yml 里的文件名定位安装包。产物名被规范化
// 改名后必须同步更新 latest.yml，否则自动更新会 404。
const latestYmlPath = path.join(outputDirectory, "latest.yml");
try {
  const latestYml = await readFile(latestYmlPath, "utf-8");
  const updatedYml = await readdir(outputDirectory).then((names) => {
    let result = latestYml;
    for (const name of names) {
      if (!name.endsWith(".exe") || !name.includes("-win-")) continue;
      for (const arch of architectureNames.keys()) {
        const stale = `${productName}-${latestYml.match(/version:\s*(\S+)/)?.[1]}-win-${arch}-setup.exe`;
        result = result.replaceAll(stale, name);
      }
    }
    return result;
  });
  if (updatedYml !== latestYml) {
    await writeFile(latestYmlPath, updatedYml, "utf-8");
    console.log(`normalize-artifact-names: patched latest.yml for ${productName}`);
  }
} catch {
  // 没有 latest.yml（例如只打 zip）时无需处理。
}
