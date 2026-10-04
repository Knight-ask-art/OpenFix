// Synthetic wheel bytes and subprocess boundaries verify identity decisions only.
// Run after build:main with node --experimental-vm-modules --test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { gunzipSync, gzipSync } from "node:zlib";

const VERSION = "0.11.1";
const WHEEL_A = Buffer.from("Synthetic wheel A; not an installable Python package.\n");
const WHEEL_B = Buffer.from("Synthetic wheel B; same filename and version, different bytes.\n");
const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const tmpDir = path.join(repoRoot, "tmp");
const distPath = path.join(repoRoot, "desktop/dist/main/runtime/openfic.js");
const commandDistPath = path.join(repoRoot, "desktop/dist/main/runtime/openfic-commands.js");
const indexes = ["https://pypi.org/simple/", "https://pypi.tuna.tsinghua.edu.cn/simple/"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const markerFor = (bytes) => `${VERSION}:sha256:${digest(bytes)}\n`;
const samePath = (a, b) => process.platform === "win32"
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b);
const unexpected = (label) => { throw new Error(`Forbidden runtime test boundary: ${label}`); };

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !path.isAbsolute(relative)
    && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

async function requireUnlinked(target) {
  const info = await fs.lstat(target);
  assert.equal(info.isSymbolicLink(), false, `Refuse linked path: ${target}`);
  assert.ok(samePath(await fs.realpath(target), target), `Refuse aliased path: ${target}`);
  return info;
}

async function requireUnlinkedTree(target) {
  const info = await requireUnlinked(target);
  if (info.isDirectory()) {
    for (const name of await fs.readdir(target)) await requireUnlinkedTree(path.join(target, name));
  } else {
    assert.ok(info.isFile(), `Refuse special file: ${target}`);
  }
}

async function withRuntimeFixture(
  runCase,
  { bundled = true, packaged = true, bundledUv = true, bundledUvCorrupt = false } = {},
) {
  assert.equal(typeof vm.SourceTextModule, "function", "Use --experimental-vm-modules");
  const [runtimeCode, commandCode] = await Promise.all([
    fs.readFile(distPath, "utf8"), fs.readFile(commandDistPath, "utf8"),
  ]);
  assert.ok((await requireUnlinked(repoRoot)).isDirectory());
  try {
    await fs.mkdir(tmpDir);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  assert.ok((await requireUnlinked(tmpDir)).isDirectory());
  const scratch = await fs.mkdtemp(path.join(tmpDir, "bundled-backend-test-"));
  let created;
  try {
    created = await requireUnlinked(scratch);
    assert.ok(within(tmpDir, scratch));
    const resourcesDirs = ["resources-a", "resources-b"].map((name) => path.join(scratch, name));
    const wheelDirs = resourcesDirs.map((dir) => path.join(dir, "backend-wheel"));
    const wheelPaths = wheelDirs.map((dir) => path.join(dir, `openfic-${VERSION}-py3-none-any.whl`));
    const bundledUvPaths = wheelDirs.map((dir) => path.join(dir, process.platform === "win32" ? "uv.exe.gz" : "uv.gz"));
    let resourceIndex = 0;
    const runtimeDir = path.join(scratch, "runtime");
    const markerPath = path.join(runtimeDir, ".openfix-bundled-backend");
    const binDir = path.join(runtimeDir, "venv", process.platform === "win32" ? "Scripts" : "bin");
    const pythonPath = path.join(binDir, process.platform === "win32" ? "python.exe" : "python");
    const cliPath = path.join(binDir, process.platform === "win32" ? "openfic.exe" : "openfic");
    const uvPath = path.join(binDir, process.platform === "win32" ? "uv.exe" : "uv");
    await fs.mkdir(wheelDirs[0], { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(pythonPath, "Synthetic Python path; never executed.\n");
    await fs.writeFile(cliPath, "Synthetic CLI path; never executed.\n");
    await fs.writeFile(markerPath, `${VERSION}\n`);
    if (bundled) await fs.writeFile(wheelPaths[0], WHEEL_A);
    if (bundled && packaged && bundledUv) {
      const archive = bundledUvCorrupt
        ? Buffer.from("Synthetic invalid gzip archive.\n")
        : gzipSync(Buffer.from("Synthetic bundled uv; never executed.\n"));
      await fs.writeFile(bundledUvPaths[0], archive);
    }
    if (!bundled || !packaged) await fs.writeFile(uvPath, "Synthetic uv path; never executed.\n");

    const state = {
      installedVersion: VERSION, cliUsable: true,
      wheelReadFails: false, installFails: false, markerWriteFails: false,
    };
    const installs = [];
    const spawns = [];
    const fetches = [];
    const progress = [];
    const logs = [];
    const markerWrites = [];
    const temporaryUvPaths = [];
    const removedTemporaryUvPaths = [];
    const boundaryErrors = [];
    function checked(operation) {
      const record = (error) => { boundaryErrors.push(error.message); throw error; };
      try {
        const result = operation();
        return result && typeof result.then === "function" ? result.catch(record) : result;
      } catch (error) {
        return record(error);
      }
    }
    function deny(label) {
      boundaryErrors.push(label);
      return unexpected(label);
    }
    async function allowPath(target, allowed) {
      await checked(async () => {
        assert.equal(typeof target, "string");
        assert.ok(within(scratch, target), `I/O outside synthetic root: ${target}`);
        assert.ok(allowed.some((entry) => samePath(entry, target)), `Unknown I/O path: ${target}`);
        await requireUnlinked(scratch);
      });
    }
    const safeFs = {
      access: async (target) => {
        await allowPath(target, [pythonPath, cliPath, uvPath, ...bundledUvPaths]);
        if (!samePath(target, uvPath)) await requireUnlinked(target);
        return fs.access(target);
      },
      mkdir: async (target, options) => {
        await allowPath(target, [runtimeDir]);
        await requireUnlinked(target);
        assert.equal(options?.recursive, true);
        return fs.mkdir(target, options);
      },
      readdir: async (target) => {
        await allowPath(target, wheelDirs);
        await requireUnlinked(target);
        return fs.readdir(target);
      },
      readFile: async (target, options) => {
        await allowPath(target, [markerPath, ...wheelPaths, ...bundledUvPaths]);
        await requireUnlinked(target);
        if (wheelPaths.some((wheelPath) => samePath(target, wheelPath)) && state.wheelReadFails) {
          throw new Error("Synthetic wheel read denied");
        }
        return fs.readFile(target, options);
      },
      writeFile: async (target, data, options) => {
        const isMarker = samePath(target, markerPath);
        if (isMarker) {
          await allowPath(target, [markerPath]);
          await requireUnlinked(target);
          if (state.markerWriteFails) throw new Error("Synthetic marker write denied");
        } else {
          assert.ok(within(runtimeDir, target), `Temporary uv escaped runtime directory: ${target}`);
          assert.match(path.basename(target), /^\.openfix-uv-[A-Za-z0-9-]+(?:\.exe)?$/);
          assert.equal(options?.flag, "wx");
          temporaryUvPaths.push(target);
          await allowPath(target, temporaryUvPaths);
        }
        await fs.writeFile(target, data, options);
        if (isMarker) markerWrites.push(data);
      },
      rm: async (target, options) => {
        await allowPath(target, temporaryUvPaths);
        assert.equal(options?.force, true);
        await fs.rm(target, options);
        removedTemporaryUvPaths.push(target);
      },
    };

    function fakeSpawn(command, args, options) {
      return checked(() => {
        assert.ok(samePath(options?.cwd, runtimeDir), "Unknown spawn working directory");
        assert.equal(options?.windowsHide, true);
        assert.equal(JSON.stringify(Array.from(options?.stdio ?? [])), '["ignore","pipe","pipe"]');
        const argv = Array.from(args);
        const query = 'from importlib.metadata import version; print(version("openfic"))';
        let output;
        let exitCode = 0;
        let kind;
        if (samePath(command, pythonPath) && JSON.stringify(argv) === '["--version"]') {
          output = "Python 3.13.14\n";
        } else if (samePath(command, pythonPath) && argv.length === 2 && argv[0] === "-c" && argv[1] === query) {
          output = `${state.installedVersion}\n`;
        } else if (samePath(command, cliPath) && JSON.stringify(argv) === '["--help"]') {
          output = "Synthetic OpenFic CLI help\n";
          exitCode = state.cliUsable ? 0 : 1;
        } else if (samePath(command, uvPath) && JSON.stringify(argv) === '["--version"]') {
          output = "uv 0.9.0\n";
        } else if (temporaryUvPaths.some((target) => samePath(command, target)) && JSON.stringify(argv) === '["--version"]') {
          assert.ok(bundled && packaged && bundledUv, "Bundled uv reached without a staged executable");
          output = "uv 0.9.0\n";
        } else if (temporaryUvPaths.some((target) => samePath(command, target))
          && argv.slice(0, 5).join("|") === `--verbose|pip|install|--python|${pythonPath}`
          && argv.at(-1) === wheelPaths[resourceIndex]
          && (argv.length === 6 || (argv.length === 7 && argv[5] === "--reinstall"))) {
          assert.ok(bundled && packaged && bundledUv, "Bundled uv install reached without staged wheel and executable");
          kind = "bundled-uv";
        } else if (samePath(command, pythonPath) && argv.slice(0, 3).join("|") === "-m|pip|install"
          && (argv.length === 4 || (argv.length === 5 && argv[3] === "--force-reinstall"))
          && samePath(argv.at(-1), wheelPaths[resourceIndex])) {
          assert.ok(bundled && packaged, "Bundled install reached without selected wheel");
          kind = "bundled-pip";
        } else if (samePath(command, uvPath) && argv.slice(0, 3).join("|") === "pip|install|--python"
          && samePath(argv[3], pythonPath) && argv.at(-1) === `openfic==${VERSION}`
          && (argv.length === 5 || (argv.length === 6 && argv[4] === "--reinstall"))) {
          assert.ok(!bundled || !packaged, "Online install reached with selected wheel");
          kind = "online-uv";
        } else {
          deny(`spawn ${command} ${argv.join(" ")}`);
        }
        const expectedEnv = { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
        if (kind) {
          assert.ok(indexes.includes(options.env.PIP_INDEX_URL), "Unknown installation index");
          const indexUrl = options.env.PIP_INDEX_URL;
          Object.assign(expectedEnv, {
            PIP_INDEX_URL: indexUrl, UV_INDEX_URL: indexUrl,
            pip_index_url: indexUrl, uv_index_url: indexUrl,
          });
          installs.push({ command, args: argv, kind });
          exitCode = state.installFails ? 1 : 0;
          if (exitCode === 0) {
            state.installedVersion = VERSION;
            state.cliUsable = true;
          }
          output = exitCode === 0 ? "Synthetic install succeeded\n" : "Synthetic install failed\n";
        }
        assert.equal(JSON.stringify(options.env), JSON.stringify(expectedEnv));
        spawns.push({ command, args: argv });
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        queueMicrotask(() => {
          child.stdout.end(output);
          child.stderr.end();
          child.emit("exit", exitCode);
        });
        return child;
      });
    }

    const context = vm.createContext({
      process: Object.freeze({
        platform: process.platform, arch: process.arch, env: Object.freeze({}),
        get resourcesPath() { return resourcesDirs[resourceIndex]; },
      }),
      Buffer, AbortController, setTimeout, clearTimeout, performance,
      fetch: () => deny("global fetch"),
    });
    const fakeExports = new Map([
      ["electron", { app: Object.freeze({ isPackaged: packaged }), net: { fetch: async (url, options) => {
        checked(() => {
          assert.ok(indexes.some((index) => url === `${index}openfic/`), `Unknown fetch URL: ${url}`);
          assert.equal(options?.cache, "no-store");
          assert.ok(options?.signal instanceof AbortSignal);
        });
        fetches.push(url);
        return { ok: true, status: 200, text: async () => `openfic-${VERSION}` };
      } } }],
      ["node:child_process", { spawn: fakeSpawn }],
      ["node:crypto", { createHash, randomUUID: (() => { let value = 0; return () => `synthetic-${value++}`; })() }],
      ["node:fs/promises", safeFs],
      ["node:path", { default: path }],
      ["node:zlib", { gunzip: (compressed, callback) => {
        try { callback(null, gunzipSync(compressed)); } catch (error) { callback(error); }
      } }],
      ["../ports.js", { findFreePort: () => deny("findFreePort") }],
      ["../process.js", { abortStartingBackendProcess: () => deny("abortStartingBackendProcess"),
        startBackendProcess: () => deny("startBackendProcess") }],
      ["../proxy.js", { configureDefaultSystemProxy: async () => {}, getSystemProxyEnvironment: async (url) => {
        checked(() => assert.ok(indexes.includes(url), `Unknown proxy URL: ${url}`));
        return {};
      } }],
      ["../health.js", { throwIfAborted: () => deny("throwIfAborted"),
        waitForBackend: () => deny("waitForBackend") }],
      ["../logging.js", { appendLog: (category, message) => {
        checked(() => assert.equal(category, "runtime"));
        logs.push(message);
      }, createLogStream: (category) => {
        checked(() => assert.equal(category, "runtime"));
        return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      } }],
    ]);
    const commands = new vm.SourceTextModule(commandCode, {
      context, identifier: commandDistPath, importModuleDynamically: () => deny("commands dynamic import"),
    });
    const modules = new Map();
    const runtime = new vm.SourceTextModule(runtimeCode, {
      context, identifier: distPath, importModuleDynamically: () => deny("runtime dynamic import"),
    });
    await runtime.link((specifier, referencingModule) => {
      if (referencingModule.identifier !== distPath) deny(`import from ${referencingModule.identifier}`);
      if (specifier === "./openfic-commands.js") return commands;
      if (!fakeExports.has(specifier)) deny(`import ${specifier}`);
      if (!modules.has(specifier)) {
        const exports = fakeExports.get(specifier);
        modules.set(specifier, new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context, identifier: `synthetic:${specifier}` }));
      }
      return modules.get(specifier);
    });
    await runtime.evaluate();
    const api = runtime.namespace;
    assert.equal(typeof api.inspectOpenFicRuntime, "function");
    assert.equal(typeof api.ensureOpenFicRuntime, "function");
    const python = { pythonPath, rootDir: path.join(runtimeDir, "python"), wasReplaced: false };
    await runCase({
      state, installs, spawns, fetches, progress, logs, markerWrites, temporaryUvPaths,
      removedTemporaryUvPaths, pythonPath, uvPath,
      get bundledUvPath() { return bundledUvPaths[resourceIndex]; },
      get wheelPath() { return wheelPaths[resourceIndex]; },
      inspect: () => api.inspectOpenFicRuntime(runtimeDir, VERSION),
      ensure: () => api.ensureOpenFicRuntime(python, runtimeDir, VERSION,
        (step, message) => progress.push({ step, message })),
      readMarker: () => fs.readFile(markerPath, "utf8"),
      replaceWheel: async (bytes) => {
        await allowPath(wheelPaths[resourceIndex], wheelPaths);
        await requireUnlinked(wheelPaths[resourceIndex]);
        await fs.writeFile(wheelPaths[resourceIndex], bytes);
      },
      relocateWheel: async () => {
        assert.equal(resourceIndex, 0);
        const bytes = await fs.readFile(wheelPaths[0]);
        await requireUnlinked(scratch);
        await fs.mkdir(wheelDirs[1], { recursive: true });
        await fs.writeFile(wheelPaths[1], bytes);
        if (bundled && packaged && bundledUv) {
          await fs.writeFile(bundledUvPaths[1], await fs.readFile(bundledUvPaths[0]));
        }
        resourceIndex = 1;
      },
    });
    assert.deepEqual(boundaryErrors, [], "Forbidden boundaries must fail even if runtime catches their errors");
  } finally {
    assert.ok(within(tmpDir, scratch));
    assert.ok(samePath(path.dirname(scratch), tmpDir));
    assert.match(path.basename(scratch), /^bundled-backend-test-[A-Za-z0-9]{6}$/);
    await requireUnlinked(repoRoot);
    await requireUnlinked(tmpDir);
    const current = await requireUnlinked(scratch);
    assert.ok(created, "Scratch identity missing; cleanup refused");
    assert.equal(current.dev, created.dev);
    assert.equal(current.ino, created.ino);
    await requireUnlinkedTree(scratch);
    await fs.rm(scratch, { recursive: true, force: false });
  }
}

test("legacy version marker migrates once and repeated current identity skips reinstall", async () => {
  await withRuntimeFixture(async (fixture) => {
    assert.equal((await fixture.inspect()).complete, false);
    const result = await fixture.ensure();
    assert.equal(result.venvPythonPath, fixture.pythonPath);
    assert.equal(result.uvPath, fixture.uvPath);
    assert.equal(fixture.installs.length, 1);
    assert.equal(fixture.installs[0].kind, "bundled-uv");
    assert.deepEqual(fixture.installs[0].args, ["--verbose", "pip", "install", "--python", fixture.pythonPath, "--reinstall", fixture.wheelPath]);
    assert.ok(fixture.progress.some((event) => event.step === "install-openfic" && event.message === "正在下载和安装后端依赖…"));
    assert.equal(fixture.temporaryUvPaths.length, 1);
    assert.deepEqual(fixture.removedTemporaryUvPaths, fixture.temporaryUvPaths);
    assert.equal(await fixture.readMarker(), markerFor(WHEEL_A));
    assert.equal((await fixture.inspect()).complete, true);
    await fixture.ensure();
    assert.equal(fixture.installs.length, 1);
    assert.equal(fixture.markerWrites.length, 1);
    assert.equal(await fixture.readMarker(), markerFor(WHEEL_A));
  });
});

test("same filename and version with changed wheel bytes forces reinstall and records new identity", async () => {
  await withRuntimeFixture(async (fixture) => {
    await fixture.ensure();
    const wheelPath = fixture.wheelPath;
    const previousMarker = await fixture.readMarker();
    await fixture.replaceWheel(WHEEL_B);
    assert.notEqual(digest(WHEEL_A), digest(WHEEL_B));
    assert.equal(fixture.wheelPath, wheelPath);
    assert.equal((await fixture.inspect()).complete, false);
    await fixture.ensure();
    assert.equal(fixture.installs.length, 2);
    assert.deepEqual(fixture.installs[1].args, ["--verbose", "pip", "install", "--python", fixture.pythonPath, "--reinstall", wheelPath]);
    assert.equal(await fixture.readMarker(), markerFor(WHEEL_B));
    assert.notEqual(await fixture.readMarker(), previousMarker);
    assert.equal((await fixture.inspect()).complete, true);
    await fixture.ensure();
    assert.equal(fixture.installs.length, 2);
    assert.equal(fixture.markerWrites.length, 2);
  });
});

test("relocated resources with identical wheel bytes keep the current runtime", async () => {
  await withRuntimeFixture(async (fixture) => {
    await fixture.ensure();
    const previousPath = fixture.wheelPath;
    const marker = await fixture.readMarker();
    await fixture.relocateWheel();
    assert.notEqual(fixture.wheelPath, previousPath);
    assert.equal((await fixture.inspect()).complete, true);
    await fixture.ensure();
    assert.equal(fixture.installs.length, 1);
    assert.equal(fixture.markerWrites.length, 1);
    assert.equal(await fixture.readMarker(), marker);
    assert.equal(marker.includes(previousPath), false);
    assert.equal(marker.includes(fixture.wheelPath), false);
  });
});

test("installed metadata version mismatch still reinstalls with a matching wheel identity", async () => {
  await withRuntimeFixture(async (fixture) => {
    await fixture.ensure();
    fixture.state.installedVersion = "0.11.0";
    assert.equal((await fixture.inspect()).complete, false);
    await fixture.ensure();
    assert.equal(fixture.installs.length, 2);
    assert.deepEqual(fixture.installs[1].args, ["--verbose", "pip", "install", "--python", fixture.pythonPath, fixture.wheelPath]);
    assert.equal(await fixture.readMarker(), markerFor(WHEEL_A));
    assert.equal((await fixture.inspect()).complete, true);
  });
});

test("unusable CLI still forces reinstall with a matching version and wheel identity", async () => {
  await withRuntimeFixture(async (fixture) => {
    await fixture.ensure();
    fixture.state.cliUsable = false;
    assert.equal((await fixture.inspect()).complete, false);
    await fixture.ensure();
    assert.equal(fixture.installs.length, 2);
    assert.deepEqual(fixture.installs[1].args, ["--verbose", "pip", "install", "--python", fixture.pythonPath, "--reinstall", fixture.wheelPath]);
    assert.equal((await fixture.inspect()).complete, true);
  });
});

test("unreadable selected wheel is incomplete and ensure rejects without recording or installing", async () => {
  await withRuntimeFixture(async (fixture) => {
    await fixture.ensure();
    const marker = await fixture.readMarker();
    const beforeSpawns = fixture.spawns.length;
    const beforeLogs = fixture.logs.length;
    fixture.state.wheelReadFails = true;
    assert.equal((await fixture.inspect()).complete, false);
    const inspectionSpawns = fixture.spawns.length;
    await assert.rejects(fixture.ensure(), /Synthetic wheel read denied/);
    assert.ok(inspectionSpawns > beforeSpawns, "Inspection must exercise actual Python and CLI checks");
    assert.equal(fixture.spawns.length, inspectionSpawns);
    assert.equal(fixture.installs.length, 1);
    assert.equal(fixture.markerWrites.length, 1);
    assert.equal(await fixture.readMarker(), marker);
    assert.equal(fixture.logs.slice(beforeLogs).includes("OpenFic 运行环境检查完成"), false);
  });
});

test("failed bundled uv attempts retain the old identity and a later retry can update it", async () => {
  await withRuntimeFixture(async (fixture) => {
    await fixture.ensure();
    const marker = await fixture.readMarker();
    await fixture.replaceWheel(WHEEL_B);
    fixture.state.installFails = true;
    const beforeLogs = fixture.logs.length;
    await assert.rejects(fixture.ensure(), /exited with code 1/);
    assert.equal(fixture.installs.length, 3, "Both existing index fallback attempts must fail");
    for (const install of fixture.installs.slice(1)) {
      assert.deepEqual(install.args, ["--verbose", "pip", "install", "--python", fixture.pythonPath, "--reinstall", fixture.wheelPath]);
    }
    assert.equal(await fixture.readMarker(), marker);
    assert.equal(fixture.markerWrites.length, 1);
    assert.equal((await fixture.inspect()).complete, false);
    assert.equal(fixture.logs.slice(beforeLogs).includes("OpenFic 运行环境检查完成"), false);
    fixture.state.installFails = false;
    await fixture.ensure();
    assert.equal(fixture.installs.length, 4);
    assert.equal(await fixture.readMarker(), markerFor(WHEEL_B));
    assert.equal((await fixture.inspect()).complete, true);
  });
});

test("marker write failure rejects completion and leaves migration pending", async () => {
  await withRuntimeFixture(async (fixture) => {
    fixture.state.markerWriteFails = true;
    await assert.rejects(fixture.ensure(), /Synthetic marker write denied/);
    assert.equal(fixture.installs.length, 1);
    assert.equal(fixture.markerWrites.length, 0);
    assert.equal(await fixture.readMarker(), `${VERSION}\n`);
    assert.equal((await fixture.inspect()).complete, false);
    assert.equal(fixture.logs.includes("OpenFic 运行环境检查完成"), false);
    fixture.state.markerWriteFails = false;
    await fixture.ensure();
    assert.equal(fixture.installs.length, 2);
    assert.equal(await fixture.readMarker(), markerFor(WHEEL_A));
    assert.equal((await fixture.inspect()).complete, true);
  });
});

for (const options of [{ bundled: false }, { bundled: true, packaged: false }]) {
  test(`online fallback preserves version checks and ignores the bundled marker (${JSON.stringify(options)})`, async () => {
    await withRuntimeFixture(async (fixture) => {
      assert.equal((await fixture.inspect()).complete, true);
      await fixture.ensure();
      assert.equal(fixture.installs.length, 0);
      assert.equal(fixture.fetches.length, 0);
      fixture.state.installedVersion = "0.11.0";
      assert.equal((await fixture.inspect()).complete, false);
      await fixture.ensure();
      assert.equal(fixture.installs.length, 1);
      assert.equal(fixture.installs[0].kind, "online-uv");
      assert.deepEqual(fixture.installs[0].args, ["pip", "install", "--python", fixture.pythonPath, `openfic==${VERSION}`]);
      assert.equal(fixture.markerWrites.length, 0);
      assert.equal(await fixture.readMarker(), `${VERSION}\n`);
      assert.equal((await fixture.inspect()).complete, true);
    }, options);
  });
}

test("bundled wheel falls back to venv pip when no bundled uv is present", async () => {
  await withRuntimeFixture(async (fixture) => {
    await fixture.ensure();
    assert.equal(fixture.installs.length, 1);
    assert.equal(fixture.installs[0].kind, "bundled-pip");
    assert.deepEqual(fixture.installs[0].args, ["-m", "pip", "install", "--force-reinstall", fixture.wheelPath]);
  }, { bundled: true, packaged: true, bundledUv: false });
});

test("corrupt bundled uv archive falls back to venv pip and keeps runtime setup working", async () => {
  await withRuntimeFixture(async (fixture) => {
    await fixture.ensure();
    assert.equal(fixture.installs.length, 1);
    assert.equal(fixture.installs[0].kind, "bundled-pip");
    assert.equal(fixture.temporaryUvPaths.length, 0);
    assert.ok(fixture.logs.some((line) => line.includes("安装包内置 uv 解压或校验失败")));
  }, { bundled: true, packaged: true, bundledUv: true, bundledUvCorrupt: true });
});
