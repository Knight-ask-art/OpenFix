import { existsSync, lstatSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(desktopDir, "dist-electron");

if (path.dirname(outputDir) !== desktopDir || path.basename(outputDir) !== "dist-electron") {
  throw new Error(`Refusing to clean unexpected packaging output path: ${outputDir}`);
}
if (existsSync(outputDir) && lstatSync(outputDir).isSymbolicLink()) {
  throw new Error(`Refusing to clean linked packaging output path: ${outputDir}`);
}

rmSync(outputDir, { recursive: true, force: true });
