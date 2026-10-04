import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendDir = path.resolve(desktopDir, "..", "backend");
const targetDir = path.join(desktopDir, "backend-wheel");
const distDir = path.join(backendDir, "dist");

mkdirSync(targetDir, { recursive: true });
for (const stale of readdirSync(targetDir)) {
  if (stale.endsWith(".whl") || stale === "uv" || stale === "uv.exe" || stale === "uv.gz" || stale === "uv.exe.gz") {
    rmSync(path.join(targetDir, stale), { force: true });
  }
}
mkdirSync(distDir, { recursive: true });
for (const stale of readdirSync(distDir)) {
  if (stale.startsWith("openfic-") && stale.endsWith(".whl")) {
    rmSync(path.join(distDir, stale), { force: true });
  }
}

execFileSync("uv", ["build", "--wheel", "--out-dir", "dist", "."], {
  cwd: backendDir,
  stdio: "inherit",
  env: {
    ...process.env,
    UV_DEFAULT_INDEX: process.env.UV_DEFAULT_INDEX ?? "https://pypi.tuna.tsinghua.edu.cn/simple",
  },
});

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

function findUvExecutable() {
  const executableName = process.platform === "win32" ? "uv.exe" : "uv";
  for (const rawDirectory of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    const candidate = path.join(directory, executableName);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep searching PATH; setup-uv installs its executable in one of these entries.
    }
  }
  throw new Error(`build-backend-wheel: could not find the current platform's ${executableName} on PATH`);
}

const uvSource = findUvExecutable();
const uvName = process.platform === "win32" ? "uv.exe.gz" : "uv.gz";
const uvTarget = path.join(targetDir, uvName);
await pipeline(createReadStream(uvSource), createGzip({ level: 9 }), createWriteStream(uvTarget));

const uvBytes = statSync(uvSource).size;
const compressedUvBytes = statSync(uvTarget).size;
console.log(
  `build-backend-wheel: staged ${wheels[wheels.length - 1]} and compressed ${uvName} (${uvBytes} -> ${compressedUvBytes} bytes) -> desktop/backend-wheel`,
);
