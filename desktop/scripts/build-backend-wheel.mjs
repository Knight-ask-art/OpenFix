import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendDir = path.resolve(desktopDir, "..", "backend");
const targetDir = path.join(desktopDir, "backend-wheel");

mkdirSync(targetDir, { recursive: true });
for (const stale of readdirSync(targetDir)) {
  if (stale.endsWith(".whl")) rmSync(path.join(targetDir, stale), { force: true });
}

execFileSync("uv", ["build", "--wheel", "--out-dir", "dist", "."], {
  cwd: backendDir,
  stdio: "inherit",
  env: {
    ...process.env,
    UV_DEFAULT_INDEX: process.env.UV_DEFAULT_INDEX ?? "https://pypi.tuna.tsinghua.edu.cn/simple",
  },
});

const distDir = path.join(backendDir, "dist");
const wheels = readdirSync(distDir)
  .filter((name) => name.startsWith("openfic-") && name.endsWith(".whl"))
  .sort();

if (wheels.length === 0) {
  console.error("build-backend-wheel: no openfic wheel found in backend/dist");
  process.exit(1);
}

for (const wheel of wheels) {
  copyFileSync(path.join(distDir, wheel), path.join(targetDir, wheel));
}

console.log(`build-backend-wheel: staged ${wheels[wheels.length - 1]} -> desktop/backend-wheel`);
