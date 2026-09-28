/**
 * 安装包冒烟验收（零依赖，直连 Electron CDP）。
 *
 * 覆盖手工验收最容易漏的「装出来能不能用」：
 *   1. 静默安装 → 2. 带调试端口启动 → 3. CDP 驱动首启向导完成运行时安装
 *   4. 进入主界面 → 5. 后端 openapi 含 V1 新接口 → 6. 关键 API 冒烟
 *   7. 关停并清理（--keep 保留环境供人工复查）
 *
 * 依赖：Node >= 22（内置 WebSocket）、已打好的 setup.exe。
 * 用法：node scripts/packaged-smoke.mjs [--keep] [--port=9224]
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(desktopDir, "dist-electron");
const argv = new Set(process.argv.slice(2));
const keepProfile = argv.has("--keep");
const debugPort = Number([...argv].find((a) => a.startsWith("--port="))?.slice("--port=".length) ?? 9224);
const workspace = mkdtempSync(path.join(tmpdir(), "openfix-smoke-"));
const userDataDir = path.join(workspace, "user-data");

if (typeof WebSocket !== "function") {
  console.error("packaged-smoke: 需要 Node >= 22（内置 WebSocket）");
  process.exit(1);
}

const setupName = readdirSync(distDir).find((name) => /^.+-win-x86_64-setup\.exe$/.test(name));
if (!setupName) {
  console.error(`packaged-smoke: 在 ${distDir} 未找到 setup 安装包`);
  process.exit(1);
}
const setupPath = path.join(distDir, setupName);

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

function stopProcesses() {
  for (const name of ["OpenFix", "openfic"]) {
    spawnSync("taskkill", ["/F", "/IM", `${name}.exe`], { stdio: "ignore" });
  }
}

async function waitFor(fn, { timeoutMs = 600_000, intervalMs = 2500, label = "" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.log(`  等待超时: ${label}`);
  return null;
}

async function httpJson(url, timeoutMs = 8000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

const cdpTargets = async () => (await httpJson(`http://127.0.0.1:${debugPort}/json`, 5000)) ?? [];

function connectCdp(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    socket.onerror = () => reject(new Error("CDP 连接失败"));
    socket.onopen = () => {
      let nextId = 1;
      const pending = new Map();
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const settle = message.id != null ? pending.get(message.id) : null;
        if (settle) {
          pending.delete(message.id);
          settle(message);
        }
      };
      const evaluate = (expression) =>
        new Promise((done) => {
          const id = nextId++;
          pending.set(id, (message) => done(message?.result?.result?.value));
          socket.send(
            JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }),
          );
        });
      resolve({
        evaluate,
        clickButton: (predicate) =>
          evaluate(
            `(() => { const b = [...document.querySelectorAll('button')].find(x => ${predicate}); if (b) b.click(); return !!b; })()`,
          ),
        text: () => evaluate("document.body.innerText"),
        close: () => socket.close(),
      });
    };
  });
}

const postJson = async (url, payload) => {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: response.ok ? await response.json() : null };
  } catch {
    return { status: 0, body: null };
  }
};

async function main() {
  console.log(`packaged-smoke: ${setupPath}\n  隔离 profile: ${userDataDir}\n`);

  stopProcesses();
  console.log("1/7 静默安装…");
  const installer = spawn(setupPath, ["/S", `/D=${userDataDir}`], { stdio: "ignore" });
  await new Promise((resolve) => installer.on("exit", resolve));
  const installedExe = path.join(userDataDir, "OpenFix.exe");
  check("安装后存在 OpenFix.exe", existsSync(installedExe), installedExe);

  console.log("\n2/7 带调试端口启动…");
  const appProcess = spawn(
    installedExe,
    [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`],
    { stdio: "ignore", detached: true },
  );
  appProcess.unref();
  await waitFor(async () => (await cdpTargets()).length > 0, {
    timeoutMs: 60_000,
    intervalMs: 1000,
    label: "CDP 就绪",
  });
  check("CDP 调试端口可用", (await cdpTargets()).length > 0, `127.0.0.1:${debugPort}`);

  console.log("\n3/7 CDP 驱动首启向导（下载运行时，需要几分钟）…");
  const setupTarget = await waitFor(async () => (await cdpTargets()).find((t) => t.url.includes("/setup")), {
    timeoutMs: 60_000,
    label: "setup 页面",
  });
  if (!setupTarget) {
    check("出现首启向导", false);
    return;
  }
  const page = await connectCdp(setupTarget.webSocketDebuggerUrl);

  if (await waitFor(async () => (await page.text())?.includes("前往设置"), { timeoutMs: 90_000, label: "开始页" })) {
    await page.clickButton("b.textContent.includes('前往设置')");
  }
  // 注意：起始页也有一个「开始使用 OpenFix」按钮，只有「运行环境已就绪」
  // 才代表运行时安装真正完成，不能用「开始使用」做完成判定。
  const completedMarker = "运行环境已就绪";
  let clickedContinue = false;
  let clickedStart = false;
  let lastStep = "";
  const installed = await waitFor(
    async () => {
      const current = (await page.text()) ?? "";
      if (!clickedContinue && current.includes("继续")) {
        await page.clickButton("b.textContent.trim() === '继续'");
        clickedContinue = true;
        return false;
      }
      if (!clickedStart && current.includes("开始安装")) {
        await page.clickButton("b.textContent.includes('开始安装')");
        clickedStart = true;
        return false;
      }
      for (const step of ["下载 Python", "解压 Python", "创建运行环境", "安装 OpenFix"]) {
        if (current.includes(step) && step !== lastStep) {
          lastStep = step;
          console.log(`    … ${step}`);
        }
      }
      return current.includes(completedMarker);
    },
    { timeoutMs: 15 * 60_000, label: "运行环境安装完成" },
  );
  check("首启向导完成运行时安装", Boolean(installed));
  if (!installed) {
    console.log(`  向导停留在: ${(await page.text())?.replace(/\n+/g, " | ").slice(0, 200)}`);
  }

  console.log("\n4/7 进入主界面并等待后端就绪…");
  if (installed) {
    await page.clickButton("b.textContent.includes('开始使用')");
  }
  const frontendTarget = await waitFor(
    async () => (await cdpTargets()).find((t) => t.url.includes("app://openfic")),
    { timeoutMs: 120_000, label: "前端 webview" },
  );
  check("前端主界面 webview 加载", Boolean(frontendTarget));

  const connectLog = path.join(userDataDir, "logs", "connect.log");
  const backendUrl = await waitFor(
    async () => {
      if (!existsSync(connectLog)) return null;
      const urls = [...readFileSync(connectLog, "utf8").matchAll(/url=(http:\/\/127\.0\.0\.1:\d+)/g)];
      return urls.at(-1)?.[1] ?? null;
    },
    { timeoutMs: 120_000, label: "后端端口" },
  );
  check("后端已连接", Boolean(backendUrl), backendUrl ?? "connect.log 无记录");

  console.log("\n5/7 校验后端包含 V1 新接口…");
  const openapi = await httpJson(`${backendUrl}/openapi.json`);
  const paths = openapi ? Object.keys(openapi.paths ?? {}) : [];
  check("后端 openapi 可读", paths.length > 0, `${paths.length} 条路由`);
  for (const marker of ["/outlines", "/story-memory/status", "/consistency/check", "/inline-ai/transform"]) {
    check(`后端含 ${marker}`, paths.some((p) => p.includes(marker)));
  }

  console.log("\n6/7 关键 API 冒烟…");
  if (backendUrl) {
    const base = `${backendUrl}/api/v1`;
    let project = null;
    try {
      const response = await fetch(`${base}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ title: "打包冒烟项目" }),
        signal: AbortSignal.timeout(15_000),
      });
      project = response.ok ? await response.json() : null;
    } catch {
      project = null;
    }
    check("创建项目", Boolean(project?.id), project?.id ?? "请求失败");

    if (project?.id) {
      const outline = await postJson(`${base}/projects/${project.id}/outlines`, {
        level: "book",
        title: "主线",
        content: "冒烟",
      });
      check("创建大纲节点（TASK-007 新接口）", Boolean(outline.body?.id), `status=${outline.status}`);

      const memory = await httpJson(`${base}/projects/${project.id}/story-memory/status`);
      check(
        "故事记忆状态接口（TASK-011 新接口）",
        memory !== null,
        memory ? memory.index_status : "无响应",
      );

      const consistency = await postJson(`${base}/projects/${project.id}/consistency/check`, {
        chapter_id: "missing",
      });
      check("一致性检查路由可达（TASK-012 新接口）", consistency.status === 404, `status=${consistency.status}`);

      await fetch(`${base}/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
      check("清理冒烟项目", true);
    }
  }

  console.log("\n7/7 关停与清理…");
  page.close();
  stopProcesses();
  if (keepProfile) {
    console.log(`  保留环境: ${workspace}`);
  } else {
    rmSync(workspace, { recursive: true, force: true });
    console.log(`  已清理 ${workspace}`);
  }

  console.log(`\n${failures.length === 0 ? "SMOKE PASSED" : `SMOKE FAILED: ${failures.join("; ")}`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("packaged-smoke 异常:", error.message);
  stopProcesses();
  process.exit(1);
});
