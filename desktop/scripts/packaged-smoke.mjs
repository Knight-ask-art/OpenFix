/**
 * 安装包冒烟验收（零依赖，直连 Electron CDP）。
 *
 * 覆盖打包安装和 §42 的本机合成链路：
 *   1. 静默安装 → 2. 带调试端口启动 → 3. CDP 驱动首启向导完成运行时安装
 *   4. 进入主界面 → 5. 检查 V1 路由 → 6. 配置本地假模型并成功运行 Inline AI / Agent / 一致性检查
 *   7. 关闭重开并检查数据和凭据 → 8. 自动备份 → 9. 清理（--keep 保留环境供复查）
 *
 * 只使用合成数据（临时数据目录 + 本机回环假模型），不读取或输出任何真实项目内容。
 *
 * 依赖：Node >= 22（内置 WebSocket）、已打好的 setup.exe。
 * 用法：node scripts/packaged-smoke.mjs [--keep] [--port=9224]
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(desktopDir, "dist-electron");
const argv = new Set(process.argv.slice(2));
const keepProfile = argv.has("--keep");
const debugPort = Number([...argv].find((a) => a.startsWith("--port="))?.slice("--port=".length) ?? 9224);
const workspace = mkdtempSync(path.join(tmpdir(), "openfix-smoke-"));
// Keep Python package caches inside this run's disposable workspace.
const smokePackageCacheDir = path.join(workspace, "package-cache");
// 首启向导的运行时安装与重启共用同一份隔离 pip/uv 缓存；否则首启会写入
// 用户级共享缓存，冒烟运行之间互相污染、长期占用磁盘。
const smokeSpawnEnv = {
  ...process.env,
  PIP_CACHE_DIR: smokePackageCacheDir,
  UV_CACHE_DIR: smokePackageCacheDir,
};
// 安装目录与 Electron profile / 数据目录必须是两个目录。
// 若把两者指向同一路径，`app.getPath("userData")` 就等于 NSIS 安装目录，
// 于是「数据目录」里会包含 resources/app.asar 与正在运行的 OpenFix.exe：
// 自动备份会去打包整个安装体，与真实用户布局不符，且在 Windows 上无法
// 删除暂存副本（EPERM）。真实安装中应用装在 Program Files / ProgramData，
// profile 在 %APPDATA%，两者天然分离。
const installDir = path.join(workspace, "install");
const userDataDir = path.join(workspace, "profile");
const smokeData = {};
const inlineSmokeText = "OpenFix-Smoke-Inline 原文：夜风吹过城门，灯火摇曳。";
const inlineSmokeResult = "夜风轻拂城门，灯火在风中摇曳。";
const restartInlineSmokeResult = "雨停之后，青石阶上浮起一层清冷月光。";
const consistencySmokeMarker = "OpenFix-Smoke-Consistency";
const consistencyAnalysisSmokeReply = "综合原文后，现有材料不足以确认矛盾，请核实人物成长时间。";
const agentSmokeRequest = "OpenFix-Smoke-Agent-Request：请只回复你已完成合成验收。";
const agentSmokeReply = "OpenFix 合成 Agent 已完成调用。";
const chapterSourceText = "夜风吹过城门，灯火摇曳。";
const chapterCandidateText = "夜风轻拂城门，灯火在风中摇曳。";
const fakeModelApiKey = "openfix-smoke-fake-key";
const fakeModelStats = {
  requests: 0,
  invalidAuthorization: 0,
  expectedModelRequests: 0,
  inline: 0,
  consistency: 0,
  agent: 0,
  other: 0,
};

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
let appProcess;
let page;
let fakeModelServer;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

function printLogTail(name, maxLines = 80, maxChars = 12_000) {
  const logPath = path.join(userDataDir, "logs", name);
  let content;
  try {
    content = readFileSync(logPath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    const detail = error?.code === "ENOENT" ? "不存在" : error.message;
    console.log(`  ${name}：无法读取（${detail}）`);
    return;
  }

  const tail = content.split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
  console.log(`  ${name}：末尾最多 ${maxLines} 行（${logPath}）`);
  console.log(tail ? tail.slice(-maxChars) : "  （日志为空）");
}

async function cleanupSmokeWorkspace(recordChecks = true) {
  page?.close();
  page = null;
  await stopFakeModelServer();
  const appStopped = await stopTestProcess();
  if (recordChecks) check("只关闭本次冒烟启动的进程", appStopped);

  if (keepProfile || !appStopped) {
    console.log(`  保留环境: ${workspace}`);
    return;
  }

  const cleaned = await removeWorkspace();
  if (recordChecks) check("清理隔离临时目录", cleaned, workspace);
}

async function finalizeSmoke() {
  await cleanupSmokeWorkspace();
  console.log(`\n${failures.length === 0 ? "SMOKE PASSED" : `SMOKE FAILED: ${failures.join("; ")}`}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

// 只清理本脚本用 mkdtemp 创建的临时工作区。Windows 偶尔在进程退出后
// 仍短暂保留文件句柄；先做递归重试，遇到锁定错误后再额外等待重试两轮。
async function removeWorkspace() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 40, retryDelay: 500 });
      console.log(`  已清理 ${workspace}`);
      return true;
    } catch (error) {
      const errorCode = error?.code;
      if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(errorCode) || attempt === 3) {
        const reason = error instanceof Error ? error.message : String(error);
        console.log(`  清理失败，保留环境供排查: ${workspace}  (${reason})`);
        return false;
      }
      console.log(`  临时目录仍被 Windows 占用（${errorCode}），稍后重试 ${attempt}/2`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  return false;
}

async function stopTestProcess() {
  const processToStop = appProcess;
  if (!processToStop?.pid || processToStop.exitCode !== null) return true;

  spawnSync("taskkill", ["/F", "/T", "/PID", String(processToStop.pid)], {
    stdio: "ignore",
  });
  return new Promise((resolve) => {
    if (processToStop.exitCode !== null) {
      resolve(true);
      return;
    }
    const timeout = setTimeout(() => resolve(false), 15_000);
    processToStop.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
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

const readFrontendWebviewState = () =>
  page.evaluate(`(() => {
    const webview = document.querySelector("webview");
    if (!webview) return null;
    return {
      url: typeof webview.getURL === "function" ? webview.getURL() : webview.getAttribute("src"),
      loading: typeof webview.isLoading === "function" ? webview.isLoading() : null,
      webContentsId: typeof webview.getWebContentsId === "function" ? webview.getWebContentsId() : null,
    };
  })()`);

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
        new Promise((done, fail) => {
          const id = nextId++;
          pending.set(id, (message) => {
            // 被拒绝的 IPC Promise 只会出现在 exceptionDetails，不透出来就会
            // 变成「结果 undefined」，看不出真实错误。
            const details = message?.result?.exceptionDetails;
            if (details) {
              const description =
                details.exception?.description ?? details.exception?.value ?? details.text ?? "未知异常";
              const [firstLine] = String(description).split("\n");
              fail(new Error(`页面脚本异常: ${firstLine.trim().slice(0, 300)}`));
              return;
            }
            done(message?.result?.result?.value);
          });
          socket.send(
            JSON.stringify({
              id,
              method: "Runtime.evaluate",
              params: { expression, returnByValue: true, awaitPromise: true },
            }),
          );
        });
      resolve({
        evaluate,
        clickButton: (predicate) =>
          evaluate(
            `(() => { const b = [...document.querySelectorAll('button')].find(x => ${predicate}); if (b) b.click(); return !!b; })()`,
          ),
        text: () => evaluate("document.body?.innerText ?? ''"),
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

const putJson = async (url, payload) => {
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: response.ok ? await response.json() : null };
  } catch {
    return { status: 0, body: null };
  }
};

const patchJson = async (url, payload) => {
  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: response.ok ? await response.json() : null };
  } catch {
    return { status: 0, body: null };
  }
};

async function startFakeModelServer() {
  fakeModelServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);

    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid request" } }));
      return;
    }

    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method !== "POST" || !requestPath.endsWith("/chat/completions")) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    fakeModelStats.requests += 1;
    if (request.headers.authorization !== `Bearer ${fakeModelApiKey}`) {
      fakeModelStats.invalidAuthorization += 1;
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid authorization" } }));
      return;
    }

    if (payload.model === "openfix-smoke-model") fakeModelStats.expectedModelRequests += 1;
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const promptText = messages
      .map((message) => (typeof message?.content === "string" ? message.content : ""))
      .join("\n");

    let category = "other";
    let content = "OpenFix 本地合成模型响应。";
    if (promptText.includes(agentSmokeRequest)) {
      category = "agent";
      content = agentSmokeReply;
    } else if (promptText.includes(consistencySmokeMarker)) {
      category = "consistency";
      content = promptText.includes("【待复核的问题】")
        ? consistencyAnalysisSmokeReply
        : JSON.stringify([
            {
              type: "timeline",
              severity: "warning",
              message: "时间线可能需要复核",
              evidence: ["夜风轻拂城门"],
              suggestion: "结合前后章节确认时间顺序。",
            },
          ]);
    } else if (promptText.includes(inlineSmokeText)) {
      category = "inline";
      content = inlineSmokeResult;
    } else if (promptText.includes("润色") || promptText.includes("改写")) {
      category = "inline";
      content = fakeModelStats.inline === 0 ? inlineSmokeResult : restartInlineSmokeResult;
    }
    fakeModelStats[category] += 1;

    const model = typeof payload.model === "string" ? payload.model : "openfix-smoke-model";
    const responseBody = (object, choices, usage) => ({
      id: "chatcmpl-openfix-smoke",
      object,
      created: Math.floor(Date.now() / 1000),
      model,
      choices,
      ...(usage ? { usage } : {}),
    });

    if (payload.stream === true) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const writeChunk = (choices, usage) => {
        response.write(
          `data: ${JSON.stringify(responseBody("chat.completion.chunk", choices, usage))}\n\n`,
        );
      };
      writeChunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]);
      writeChunk([{ index: 0, delta: { content }, finish_reason: null }]);
      writeChunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
      if (payload.stream_options?.include_usage) {
        writeChunk([], { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 });
      }
      response.end("data: [DONE]\n\n");
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        responseBody(
          "chat.completion",
          [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 },
        ),
      ),
    );
  });

  await new Promise((resolve, reject) => {
    fakeModelServer.once("error", reject);
    fakeModelServer.listen(0, "127.0.0.1", resolve);
  });
  return fakeModelServer.address().port;
}

async function stopFakeModelServer() {
  if (!fakeModelServer?.listening) return;
  await new Promise((resolve) => fakeModelServer.close(resolve));
  fakeModelServer = null;
}

const postForm = async (url, fields) => {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: response.ok ? await response.json() : null };
  } catch {
    return { status: 0, body: null };
  }
};

async function main() {
  console.log(
    `packaged-smoke: ${setupPath}\n  隔离安装目录: ${installDir}\n  隔离 profile: ${userDataDir}\n`,
  );

  console.log("1/9 静默安装…");
  // NSIS 要求 /D 位于最后，且包含空格时也不能被自动加引号。
  const installer = spawn(setupPath, ["/S", `/D=${installDir}`], {
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  await new Promise((resolve, reject) => {
    installer.once("error", reject);
    installer.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`安装程序退出异常：code=${code}, signal=${signal ?? "none"}`));
      }
    });
  });
  const installedExe = path.join(installDir, "OpenFix.exe");
  check("安装后存在 OpenFix.exe", existsSync(installedExe), installedExe);

  console.log("\n2/9 带调试端口启动…");
  appProcess = spawn(
    installedExe,
    [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`],
    { stdio: "ignore", detached: true, env: smokeSpawnEnv },
  );
  appProcess.unref();
  await waitFor(async () => (await cdpTargets()).length > 0, {
    timeoutMs: 60_000,
    intervalMs: 1000,
    label: "CDP 就绪",
  });
  check("CDP 调试端口可用", (await cdpTargets()).length > 0, `127.0.0.1:${debugPort}`);

  console.log("\n3/9 CDP 驱动首启向导（下载运行时，需要几分钟）…");
  const setupTarget = await waitFor(async () => (await cdpTargets()).find((t) => t.url.includes("/setup")), {
    timeoutMs: 60_000,
    label: "setup 页面",
  });
  if (!setupTarget) {
    check("出现首启向导", false);
    await finalizeSmoke();
    return;
  }
  page = await connectCdp(setupTarget.webSocketDebuggerUrl);

  // 注意：起始页也有一个「开始使用 OpenFix」按钮，只有「运行环境已就绪」
  // 才代表运行时安装真正完成，不能用「开始使用」做完成判定。
  const completedMarker = "运行环境已就绪";
  // setup 向导的前进按钮统一是 .setup-actions .primary-button，用类选择器
  // 避免依赖文案（不同语言/版本文案会变）。
  const clickPrimaryAction = () =>
    page.evaluate(
      `(() => {
        const button = document.querySelector('.setup-actions .primary-button');
        if (!button || button.disabled) return false;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
        }
        return true;
      })()`,
    );
  let clickedSetup = false;
  let clickedInstallDir = false;
  let clickedStart = false;
  let lastStep = "";
  const installed = await waitFor(
    async () => {
      const current = (await page.text()) ?? "";
      if (!clickedSetup && current.includes("前往设置")) {
        const dispatched = await page.evaluate(
          `(() => {
            const label = [...document.querySelectorAll('button *')].find(
              (el) => el.textContent.trim() === '前往设置',
            );
            const button = label?.closest('button');
            if (!button) return false;
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
            }
            return true;
          })()`,
        );
        console.log(`    … 点击「前往设置」${dispatched ? "" : "（未找到）"}`);
        clickedSetup = dispatched;
        return false;
      }
      if (!clickedInstallDir && current.includes("选择安装目录")) {
        // 安装目录页主按钮 =「继续」
        if (await clickPrimaryAction()) {
          console.log("    … 继续（安装目录）");
          clickedInstallDir = true;
        }
        return false;
      }
      if (!clickedStart && current.includes("开始安装")) {
        // 数据目录页主按钮 =「开始安装」
        if (await clickPrimaryAction()) {
          console.log("    … 开始安装");
          clickedStart = true;
        }
        return false;
      }
      // 步骤列表会一次性渲染全部步骤标题，只能按 data-running / data-failed
      // 找当前步骤，否则每轮轮询都会把 4 个标题重新打印一遍。
      const progress = await page.evaluate(
        `(() => {
          const step = document.querySelector('.setup-step[data-running="true"], .setup-step[data-failed="true"]');
          if (!step) return null;
          return {
            title: step.querySelector('.setup-step-title')?.textContent?.trim() ?? '',
            failed: step.getAttribute('data-failed') === 'true',
            detail: step.querySelector('.setup-step-detail')?.textContent?.trim() ?? '',
          };
        })()`,
      );
      if (progress?.title && progress.title !== lastStep) {
        lastStep = progress.title;
        console.log(
          `    … ${progress.title}${progress.failed ? `（失败：${progress.detail}）` : ""}`,
        );
      }
      return current.includes(completedMarker);
    },
    // Fresh installs resolve a large backend dependency set; bound this phase at 30 minutes.
    { timeoutMs: 30 * 60_000, label: "运行环境安装完成" },
  );
  check("首启向导完成运行时安装", Boolean(installed));
  if (!installed) {
    console.log(`  向导停留在: ${(await page.text())?.replace(/\n+/g, " | ").slice(0, 200)}`);
    console.log("  安装诊断日志（仅输出有限尾部，随后清理隔离环境）：");
    printLogTail("runtime.log");
    printLogTail("startup.log", 40, 6_000);
    console.log("  跳过 4–8/9：首启运行环境未就绪，后续检查依赖前置步骤。");
    await finalizeSmoke();
    return;
  }

  console.log("\n4/9 进入主界面并等待后端就绪…");
  if (installed) {
    // 完成页的「开始使用」同样是主按钮。
    await clickPrimaryAction();
  }
  const frontendTarget = await waitFor(
    async () => {
      const state = await readFrontendWebviewState();
      return state?.url?.includes("app://openfic") && state.loading === false ? state : null;
    },
    { timeoutMs: 120_000, label: "前端 webview" },
  );
  check(
    "前端主界面 webview 加载",
    Boolean(frontendTarget),
    frontendTarget?.url ?? `桌面壳 webview 状态=${JSON.stringify(await readFrontendWebviewState())}`,
  );

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

  console.log("\n5/9 校验后端包含 V1 新接口…");
  // FastAPI 首次生成大型 OpenAPI schema 在 Windows 冷启动时可能超过默认的 8 秒。
  const openapi = await httpJson(`${backendUrl}/openapi.json`, 30_000);
  const paths = openapi ? Object.keys(openapi.paths ?? {}) : [];
  check("后端 openapi 可读", paths.length > 0, `${paths.length} 条路由`);
  for (const marker of [
    "/outlines",
    "/outlines/ai/improve",
    "/story-setup/draft",
    "/story-memory/status",
    "/consistency/check",
    "/consistency/analyze",
    "/inline-ai/transform",
    "/profile",
    "/chapter-meta",
    "/world-info-entries/{entry_id}/meta",
    "/characters/{character_id}/profile",
    "/characters/{character_id}/states",
  ]) {
    check(`后端含 ${marker}`, paths.some((p) => p.includes(marker)));
  }

  console.log("\n6/9 §42 链路冒烟（合成数据 + 本地模型）…");
  if (backendUrl) {
    const base = `${backendUrl}/api/v1`;
    smokeData.base = base;
    const created = await postForm(`${base}/projects`, { title: "打包冒烟项目" });
    const projectId = created.body?.id ?? null;
    smokeData.projectId = projectId;
    check("创建项目", Boolean(projectId), projectId ?? `status=${created.status}`);

    if (projectId) {
      const profile = await putJson(`${base}/projects/${projectId}/profile`, {
        genre: "mystery",
        target_word_count: 100000,
        daily_word_goal: 2000,
      });
      check("项目产品属性", profile.body?.genre === "mystery", `status=${profile.status}`);

      const outline = await postJson(`${base}/projects/${projectId}/outlines`, {
        level: "book",
        title: "主线",
        content: "冒烟",
      });
      check("创建大纲节点", Boolean(outline.body?.id), `status=${outline.status}`);

      const character = await postForm(`${base}/projects/${projectId}/characters`, {
        name: "冒烟人物",
        description: "合成数据",
      });
      const characterId = character.body?.id ?? null;
      check("创建人物", Boolean(characterId), `status=${character.status}`);

      if (characterId) {
        const characterProfile = await putJson(`${base}/characters/${characterId}/profile`, {
          identity: "记者",
          goal: "找到导师留下的资料",
        });
        check(
          "人物作者字段",
          characterProfile.body?.identity === "记者",
          `status=${characterProfile.status}`,
        );

        const characterState = await putJson(`${base}/characters/${characterId}/states`, {
          location: "北城",
          mental_state: "怀疑身边的人",
        });
        check(
          "人物当前状态",
          characterState.body?.location === "北城",
          `status=${characterState.status}`,
        );
      }

      const worldInfo = await httpJson(`${base}/projects/${projectId}/world-info`);
      let entryId = null;
      if (worldInfo?.id) {
        const entry = await postJson(`${base}/world-info/${worldInfo.id}/entries`, {
          name: "冒烟设定",
          content: "合成数据，用于验证设定扩展信息。",
        });
        entryId = entry.body?.id ?? null;
      }
      check("创建世界设定", Boolean(entryId), entryId ?? "请求失败");

      if (entryId) {
        const meta = await putJson(`${base}/world-info-entries/${entryId}/meta`, {
          entry_type: "location",
          tags: ["冒烟"],
          ai_visible: true,
        });
        check("世界设定扩展信息", meta.body?.entry_type === "location", `status=${meta.status}`);
      }

      const tree = await httpJson(`${base}/projects/${projectId}/chapters`);
      const volumeId = tree?.volumes?.[0]?.id ?? null;
      smokeData.volumeId = volumeId;
      let chapterId = null;
      let modelId = null;
      if (volumeId) {
        const chapter = await postJson(`${base}/projects/${projectId}/chapters`, {
          volume_id: volumeId,
          title: `第一章 ${consistencySmokeMarker}`,
          content: chapterSourceText,
          word_count: chapterSourceText.length,
        });
        chapterId = chapter.body?.id ?? null;
      }
      smokeData.chapterId = chapterId;
      check("创建章节", Boolean(chapterId), chapterId ?? "请求失败");

      if (chapterId) {
        const fakeModelPort = await startFakeModelServer();
        const provider = await postForm(`${base}/model-providers`, {
          name: "OpenFix 本地冒烟模型",
          url: `http://127.0.0.1:${fakeModelPort}/v1`,
          api_key: fakeModelApiKey,
          provider_type: "openai-compatible",
        });
        const providerId = provider.body?.id ?? null;
        check("配置本地 OpenAI 兼容模型服务", Boolean(providerId), `status=${provider.status}`);

        const model = providerId
          ? await postJson(`${base}/models`, {
              name: "OpenFix Smoke Model",
              provider_id: providerId,
              model_id: "openfix-smoke-model",
              task_type: "llm",
              temperature: 0,
              max_tokens: 256,
              context_length: 8192,
            })
          : { status: 0, body: null };
        modelId = model.body?.id ?? null;
        smokeData.providerId = providerId;
        smokeData.modelId = modelId;
        check("创建冒烟语言模型", Boolean(modelId), `status=${model.status}`);

        const modelSettings = modelId
          ? await patchJson(`${base}/settings`, {
              default_model: modelId,
              light_model: modelId,
            })
          : { status: 0, body: null };
        check(
          "配置默认与轻量模型",
          modelSettings.body?.default_model === modelId && modelSettings.body?.light_model === modelId,
          `status=${modelSettings.status}`,
        );

        const written = await patchJson(`${base}/chapters/${chapterId}`, {
          content: chapterSourceText,
          word_count: chapterSourceText.length,
        });
        check("写入合成正文", written.status === 200, `status=${written.status}`);

        const chapterMeta = await putJson(`${base}/chapters/${chapterId}/meta`, {
          status: "writing",
          target_word_count: 3000,
        });
        check(
          "章节状态与目标字数",
          chapterMeta.body?.target_word_count === 3000,
          `status=${chapterMeta.status}`,
        );

        const inline = modelId
          ? await postJson(`${base}/inline-ai/transform`, {
              project_id: projectId,
              chapter_id: chapterId,
              action: "polish",
              selected_text: inlineSmokeText,
              model_id: modelId,
            })
          : { status: 0, body: null };
        check(
          "Inline AI 返回候选文本",
          inline.body?.original === inlineSmokeText && inline.body?.result === inlineSmokeResult,
          `status=${inline.status}`,
        );

        const unchangedChapter = await httpJson(`${base}/chapters/${chapterId}`);
        check(
          "Inline AI 不会未经接受就改正文",
          unchangedChapter?.content === chapterSourceText,
          "候选仍待用户接受",
        );

        const acceptedChapter = await patchJson(`${base}/chapters/${chapterId}`, {
          content: chapterCandidateText,
          word_count: chapterCandidateText.length,
        });
        smokeData.acceptedChapterText = chapterCandidateText;
        check(
          "接受候选并保存章节正文",
          acceptedChapter.body?.content === chapterCandidateText,
          `status=${acceptedChapter.status}`,
        );
      }

      const memory = await httpJson(`${base}/projects/${projectId}/story-memory/status`);
      check(
        "故事记忆状态接口",
        memory !== null,
        memory ? memory.index_status : "无响应",
      );
      check(
        "故事记忆计入人物与世界设定",
        (memory?.counts?.characters ?? 0) >= 1 && (memory?.counts?.world_entries ?? 0) >= 1,
        JSON.stringify(memory?.counts ?? {}),
      );

      const consistency = chapterId
        ? await postJson(`${base}/projects/${projectId}/consistency/check`, {
            chapter_id: chapterId,
          })
        : { status: 0, body: null };
      check(
        "一致性检查成功返回结果",
        consistency.body?.model === "OpenFix Smoke Model" && Array.isArray(consistency.body?.issues),
        `status=${consistency.status}`,
      );
      const consistencyIssue = consistency.body?.issues?.[0];
      check(
        "一致性结果定位到真实章节原文",
        consistencyIssue?.sources?.some(
          (source) => source.chapter_id === chapterId && source.quote === "夜风轻拂城门",
        ),
      );
      const analysis = consistencyIssue
        ? await postJson(`${base}/projects/${projectId}/consistency/analyze`, {
            scope: consistency.body.scope,
            chapter_id: consistency.body.chapter_id,
            volume_id: consistency.body.volume_id,
            issue: {
              type: consistencyIssue.type,
              severity: consistencyIssue.severity,
              message: consistencyIssue.message,
              evidence: consistencyIssue.evidence,
              suggestion: consistencyIssue.suggestion,
            },
          })
        : { status: 0, body: null };
      check(
        "一致性问题的 AI 分析复核",
        analysis.body?.analysis === consistencyAnalysisSmokeReply,
        `status=${analysis.status}`,
      );

      const session = modelId
        ? await postJson(`${base}/agent/sessions`, {
            project_id: projectId,
            model_id: modelId,
            max_iterations: 3,
          })
        : { status: 0, body: null };
      const sessionId = session.body?.session_id ?? null;
      const taskId = session.body?.task_id ?? null;
      smokeData.taskId = taskId;
      check("创建 Agent 会话", Boolean(sessionId && taskId), `status=${session.status}`);

      const sentAgentMessage = sessionId
        ? await postJson(`${base}/agent/sessions/${sessionId}/message`, {
            message: agentSmokeRequest,
          })
        : { status: 0, body: null };
      check(
        "Agent 消息进入真实运行链路",
        sentAgentMessage.status === 200 && sentAgentMessage.body?.success === true,
        `status=${sentAgentMessage.status}`,
      );

      const finishedAgentTask = taskId
        ? await waitFor(
            async () => {
              const task = await httpJson(`${base}/tasks/${taskId}`);
              if (!task || task.is_running) return null;
              const hasReply = task.messages?.some(
                (message) => message.role === "assistant" && message.content.includes(agentSmokeReply),
              );
              if (hasReply) return task;
              const hasError = task.messages?.some((message) => message.message_status === "error");
              return hasError ? { ...task, smokeFailed: true } : null;
            },
            { timeoutMs: 120_000, intervalMs: 1000, label: "本地 Agent 模型运行完成" },
          )
        : null;
      check(
        "Agent 收到本地模型成功回复",
        Boolean(finishedAgentTask && !finishedAgentTask.smokeFailed),
        finishedAgentTask?.smokeFailed ? "任务返回错误" : "未找到成功回复",
      );

      check(
        "本地模型服务收到 Inline AI / Agent 请求",
        fakeModelStats.inline >= 1 && fakeModelStats.consistency >= 1 && fakeModelStats.agent >= 1,
        `inline=${fakeModelStats.inline}, consistency=${fakeModelStats.consistency}, agent=${fakeModelStats.agent}`,
      );

      if (volumeId) {
        const localDate = new Date().toISOString().slice(0, 10);
        const exportJob = await postJson(`${base}/projects/${projectId}/chapter-exports`, {
          selected_volume_ids: [volumeId],
          local_date: localDate,
          format: "docx",
        });
        const jobId = exportJob.body?.id ?? null;
        check("创建 DOCX 导出任务", Boolean(jobId), `status=${exportJob.status}`);

        if (jobId) {
          const finished = await waitFor(
            async () => {
              const job = await httpJson(
                `${base}/projects/${projectId}/chapter-exports/${jobId}`,
              );
              if (!job) return null;
              return job.status === "succeeded" || job.status === "failed" ? job : null;
            },
            { timeoutMs: 120_000, intervalMs: 1500, label: "DOCX 导出完成" },
          );
          check("DOCX 导出完成", finished?.status === "succeeded", finished?.status ?? "超时");

          if (finished?.status === "succeeded") {
            const download = await fetch(
              `${base}/projects/${projectId}/chapter-exports/${jobId}/download`,
              { signal: AbortSignal.timeout(30_000) },
            ).catch(() => null);
            const buffer = download?.ok ? await download.arrayBuffer() : null;
            check(
              "下载 DOCX 且非空",
              Boolean(buffer && buffer.byteLength > 0),
              buffer ? `${buffer.byteLength} 字节` : "下载失败",
            );
          }
        }
      }

    }
  }

  console.log("\n7/9 关闭并重启（校验数据保留）…");
  page.close();
  page = null;
  const firstAppStopped = await stopTestProcess();
  check("关闭本次运行的桌面进程", firstAppStopped);
  const backendStopped = backendUrl
    ? await waitFor(
        async () => !(await httpJson(`${backendUrl}/openapi.json`, 2000)),
        { timeoutMs: 30_000, intervalMs: 1000, label: "关闭旧后端" },
      )
    : false;
  check("关闭后本地后端进程退出", Boolean(backendStopped));

  const debugPortClosed = await waitFor(async () => (await cdpTargets()).length === 0, {
    timeoutMs: 30_000,
    intervalMs: 1000,
    label: "关闭旧桌面进程",
  });
  check("重启前调试端口已释放", Boolean(debugPortClosed));

  if (firstAppStopped && debugPortClosed) {
    appProcess = spawn(
      installedExe,
      [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`],
      { stdio: "ignore", detached: true, env: smokeSpawnEnv },
    );
    appProcess.unref();

    const reopenedTarget = await waitFor(
      async () => (await cdpTargets()).find((target) => target.url.includes("app://openfic")),
      { timeoutMs: 120_000, intervalMs: 1000, label: "重启后的前端主界面" },
    );
    check("重启后主界面重新加载", Boolean(reopenedTarget));
    const reopenedShellTarget = await waitFor(
      async () =>
        (await cdpTargets()).find(
          (target) => target.type === "page" && target.url.includes("app://setup/ui.html"),
        ),
      { timeoutMs: 30_000, intervalMs: 1000, label: "重启后的桌面 preload 页面" },
    );
    check("重启后桌面 preload 页面可用", Boolean(reopenedShellTarget));
    if (reopenedShellTarget) page = await connectCdp(reopenedShellTarget.webSocketDebuggerUrl);

    const restartedBackendUrl = await waitFor(
      async () => {
        if (!existsSync(connectLog)) return null;
        const urls = [...readFileSync(connectLog, "utf8").matchAll(/url=(http:\/\/127\.0\.0\.1:\d+)/g)];
        const latestUrl = urls.at(-1)?.[1];
        return latestUrl && (await httpJson(`${latestUrl}/openapi.json`)) ? latestUrl : null;
      },
      { timeoutMs: 120_000, intervalMs: 1000, label: "重启后的本地后端" },
    );
    check("重启后后端重新连接", Boolean(restartedBackendUrl));

    if (restartedBackendUrl) {
      const reopenedBase = `${restartedBackendUrl}/api/v1`;
      const persistedProject = smokeData.projectId
        ? await httpJson(`${reopenedBase}/projects/${smokeData.projectId}`)
        : null;
      check("重启后小说项目仍存在", persistedProject?.title === "打包冒烟项目");

      const persistedChapter = smokeData.chapterId
        ? await httpJson(`${reopenedBase}/chapters/${smokeData.chapterId}`)
        : null;
      check(
        "重启后已接受正文仍存在",
        persistedChapter?.content === smokeData.acceptedChapterText,
      );

      const persistedSettings = await httpJson(`${reopenedBase}/settings`);
      check(
        "重启后默认模型配置仍存在",
        persistedSettings?.default_model === smokeData.modelId &&
          persistedSettings?.light_model === smokeData.modelId,
      );

      const persistedModels = await httpJson(`${reopenedBase}/models`);
      check(
        "重启后模型记录仍存在",
        Array.isArray(persistedModels) && persistedModels.some((model) => model.id === smokeData.modelId),
      );

      const persistedTask = smokeData.taskId
        ? await httpJson(`${reopenedBase}/tasks/${smokeData.taskId}`)
        : null;
      check(
        "重启后 Agent 对话仍存在",
        Boolean(
          persistedTask &&
            !persistedTask.is_running &&
            persistedTask.messages?.some(
              (message) => message.role === "assistant" && message.content.includes(agentSmokeReply),
            ),
        ),
      );

      if (smokeData.projectId && smokeData.chapterId && smokeData.modelId) {
        const reopenedInline = await postJson(`${reopenedBase}/inline-ai/transform`, {
          project_id: smokeData.projectId,
          chapter_id: smokeData.chapterId,
          action: "polish",
          selected_text: smokeData.acceptedChapterText,
          model_id: smokeData.modelId,
        });
        check(
          "重启后加密模型凭据仍可用",
          reopenedInline.body?.result === restartInlineSmokeResult,
          `status=${reopenedInline.status}`,
        );
      }
    }
  }

  console.log("\n8/9 自动备份（桌面 Data Manager）…");
  {
    const backupDir = path.join(workspace, "auto-backup");
    mkdirSync(backupDir, { recursive: true });
    let autoBackupOk = false;
    let autoBackupDetail = "未执行";
    try {
      const config = await page.evaluate(
        "window.openficDesktop?.getConfig ? window.openficDesktop.getConfig() : null",
      );
      const instances = Array.isArray(config?.instances) ? config.instances : [];
      check("桌面 Data Manager 配置 IPC 可读", Array.isArray(config?.instances));
      const instance =
        instances.find((item) => item.id === config?.activeInstanceId && item.mode === "local") ??
        instances.find((item) => item.mode === "local");
      if (!instance) {
        autoBackupDetail = `配置实例数=${instances.length}，未找到本地实例`;
      } else {
        const nextConfig = {
          ...config,
          autoBackup: { enabled: true, dir: backupDir, keep: 2 },
        };
        await page.evaluate(
          `window.openficDesktop.saveConfig(${JSON.stringify(nextConfig)})`,
        );
        await page.evaluate(
          `window.openficDesktop.autoBackupNow(${JSON.stringify(instance.id)})`,
        );
        const backupFile = await waitFor(
          () => {
            const name = readdirSync(backupDir).find(
              (item) => item.startsWith("OpenFix-backup-") && item.endsWith(".tar.gz"),
            );
            return name ?? null;
          },
          // 默认布局下数据目录与运行环境同处 profile；打包备份必须按应用的真实
          // runtime 路径排除 Python / 后端运行环境，只等待用户数据完成归档。
          { timeoutMs: 180_000, intervalMs: 1500, label: "自动备份文件" },
        );
        if (backupFile) {
          const size = statSync(path.join(backupDir, backupFile)).size;
          autoBackupOk = size > 0;
          autoBackupDetail = `${size} 字节`;
        } else {
          autoBackupDetail = "未生成备份文件";
        }
      }
    } catch (error) {
      autoBackupDetail = error instanceof Error ? error.message : String(error);
    }
    check("自动备份生成文件（复用桌面 Data Manager）", autoBackupOk, autoBackupDetail);
  }

  console.log("\n9/9 关停与清理…");
  await finalizeSmoke();
}

main().catch(async (error) => {
  console.error("packaged-smoke 异常:", error.message);
  // 只停本次冒烟启动的进程树；进程未确认退出时不删工作区，避免误删/删不净。
  await cleanupSmokeWorkspace(false);
  process.exitCode = 1;
});
