interface SpawnCommand {
  command: string;
  args: string[];
}

export function resolveOpenFicCliPath(venvPythonPath: string): string {
  return process.platform === "win32"
    ? venvPythonPath.replace(/python\.exe$/i, "openfic.exe")
    : venvPythonPath.replace(/python$/i, "openfic");
}
export function createOpenFicVersionCommand(venvPythonPath: string): SpawnCommand {
  return {
    command: venvPythonPath,
    args: ["-c", 'from importlib.metadata import version; print(version("openfic"))'],
  };
}

export function createOpenFicInstallCommand(
  venvPythonPath: string,
  version: string,
  forceReinstall = false,
  bundledWheel?: string | null,
): Omit<SpawnCommand, "command"> {
  const requirement = bundledWheel ?? `openfic==${version}`;
  return {
    args: ["pip", "install", "--python", venvPythonPath, ...(forceReinstall ? ["--reinstall"] : []), requirement],
  };
}

/**
 * 用 venv 自带的 pip 安装本地 wheel。
 * 自带 wheel 时无需 uv，少一个首启联网依赖（uv 曾是首启失败的常见点）。
 */
export function createBundledWheelPipInstallCommand(
  wheelPath: string,
  forceReinstall = false,
): string[] {
  return ["-m", "pip", "install", ...(forceReinstall ? ["--force-reinstall"] : []), wheelPath];
}

export function createOpenFicServeCommand(venvPythonPath: string, port: number): SpawnCommand {
  return {
    command: resolveOpenFicCliPath(venvPythonPath),
    args: ["serve", "--host", "127.0.0.1", "--port", String(port)],
  };
}
