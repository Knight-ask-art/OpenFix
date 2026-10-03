// The actual desktop/build/installer.nsh customHeader seam plus the actual pinned app-builder-lib
// 26.15.6 template sources (installer.nsi/installSection.nsh/installUtil.nsh/multiUser.nsh) are loaded
// here and preprocessed with a bounded !ifdef/!macro expander. A bounded NSIS subset interpreter then
// executes the real openficPreparePriorUninstaller function and the real installUtil.nsh GetInQuotes
// function. Registry, plugins directory, CopyFiles destination and MessageBox are strict synthetics:
// no real registry, process, installer or filesystem is touched and nothing is deleted. Path
// existence is never assumed: the interpreter evaluates the real IfFileExists guard against an
// explicit existing-file set plus an explicit existing-directory set, so an existing parent
// directory does not imply its child file, while CopyFiles can still create a destination under an
// existing parent. The section control flow (hive selection, ordering, guarded silent elevation) is
// derived from the actual section text and cross-checked against installSection.nsh instead of
// re-declaring the policy here. The
// coordinator compiles the real templates with NSIS separately; this suite does not compile or launch.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const installerPath = path.join(repoRoot, "desktop/build/installer.nsh");
const packagePath = path.join(repoRoot, "desktop/package.json");
const builderConfigPath = path.join(repoRoot, "desktop/electron-builder.yml");

const STAGING_DIR = "C:\\synthetic\\plugins";
const STAGED_FILE = `${STAGING_DIR}\\openfic-prior-uninstaller.exe`;
const UNINSTALLER_OUT = "C:\\synthetic\\build\\OpenFix-setup__uninstaller.exe";
const KEY_PRIMARY = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenFix";
const KEY_SECONDARY = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{aegis-guid}";
const PREPARE = "openficPreparePriorUninstaller";
const ALL_USERS_GUARD = '$installMode == "all"';
// NSIS "does this path exist as a directory" probe, the same form the production uninstaller uses.
const DIR_CONTENTS_SUFFIX = "\\*.*";

// --- actual source loading -------------------------------------------------

async function findTemplateDir() {
  const pnpmDir = path.join(repoRoot, "desktop/node_modules/.pnpm");
  const entries = (await fs.readdir(pnpmDir)).filter((entry) => /^app-builder-lib@26\.15\.6/.test(entry));
  assert.ok(entries.length > 0, "the pinned app-builder-lib 26.15.6 must be installed");
  for (const entry of entries) {
    const candidate = path.join(pnpmDir, entry, "node_modules/app-builder-lib/templates/nsis");
    try {
      // installUtil.nsh lives in the template include/ directory, not next to installer.nsi.
      await fs.access(path.join(candidate, "installer.nsi"));
      await fs.access(path.join(candidate, "include", "installUtil.nsh"));
      return candidate;
    } catch {
      // Try the next peer-dependency variant of the same pinned version.
    }
  }
  throw new Error("no app-builder-lib 26.15.6 NSIS template directory found");
}

async function loadSources() {
  const templateDir = await findTemplateDir();
  const read = (target) => fs.readFile(target, "utf8");
  const [installer, packageJson, builderConfig, installerNsi, installSection, installUtil, multiUser, uninstallerNsh, assisted] =
    await Promise.all([
      read(installerPath),
      read(packagePath),
      read(builderConfigPath),
      read(path.join(templateDir, "installer.nsi")),
      read(path.join(templateDir, "installSection.nsh")),
      read(path.join(templateDir, "include", "installUtil.nsh")),
      read(path.join(templateDir, "multiUser.nsh")),
      read(path.join(templateDir, "uninstaller.nsh")),
      read(path.join(templateDir, "assistedInstaller.nsh")),
    ]);
  return {
    installDir: templateDir, installer, packageJson: JSON.parse(packageJson), builderConfig,
    installerNsi, installSection, installUtil, multiUser, uninstallerNsh, assisted,
  };
}

const sources = await loadSources();

// --- bounded NSIS preprocessor --------------------------------------------

const DIRECTIVE = /^!(ifdef|ifndef|endif|else|define|undef|macro|macroend|insertmacro)\b\s*(.*)$/i;

function expandDefines(line, defineMap) {
  let out = line;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => (defineMap.has(name) ? defineMap.get(name) : whole));
    if (next === out) return out;
    out = next;
  }
  return out;
}

function preprocess(text, defines) {
  const defineMap = new Map(Object.entries(defines));
  const frames = [];
  const macros = new Map();
  const out = [];
  let macroFrame = null;
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    const enclosingActive = frames.every((frame) => frame.active);
    const directive = DIRECTIVE.exec(trimmed);
    let handled = false;
    if (directive) {
      const kind = directive[1].toLowerCase();
      const rest = directive[2].trim();
      if (kind === "ifdef" || kind === "ifndef") {
        const name = rest.split(/\s+/)[0];
        frames.push({ active: enclosingActive && (kind === "ifdef" ? defineMap.has(name) : !defineMap.has(name)) });
        handled = true;
      } else if (kind === "endif") {
        assert.ok(frames.length > 0, "unbalanced !endif in installer.nsh");
        frames.pop();
        handled = true;
      } else if (kind === "else") {
        const top = frames[frames.length - 1];
        assert.ok(top, "!else without a conditional");
        top.active = frames.slice(0, -1).every((frame) => frame.active) && !top.active;
        handled = true;
      } else if (kind === "define") {
        if (enclosingActive) {
          const match = /^(\/ifndef\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/.exec(rest);
          if (match && (!match[1] || !defineMap.has(match[2]))) defineMap.set(match[2], match[3]);
        }
        handled = true;
      } else if (kind === "undef") {
        if (enclosingActive) defineMap.delete(rest.split(/\s+/)[0]);
        handled = true;
      } else if (kind === "macro") {
        macroFrame = enclosingActive ? { name: rest.split(/\s+/)[0], lines: [] } : { name: null, lines: [] };
        handled = true;
      } else if (kind === "macroend") {
        if (macroFrame?.name) macros.set(macroFrame.name, macroFrame.lines.join("\n"));
        macroFrame = null;
        handled = true;
      } else if (kind === "insertmacro") {
        const name = rest.split(/\s+/)[0];
        if (enclosingActive && macros.has(name)) {
          const expanded = macros.get(name);
          if (macroFrame?.name) macroFrame.lines.push(expanded);
          else out.push(expanded);
          handled = true;
        }
      }
    }
    if (handled) continue;
    if (macroFrame) {
      if (enclosingActive && macroFrame.name) macroFrame.lines.push(expandDefines(raw, defineMap));
      continue;
    }
    if (!enclosingActive) continue;
    out.push(expandDefines(raw, defineMap));
  }
  return { text: out.join("\n"), macros };
}

function sliceMacroBody(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^!macro\\s+${name}\\s*$`, "i").test(line.trim()));
  assert.ok(start >= 0, `missing !macro ${name}`);
  let depth = 0;
  const out = [];
  for (let index = start; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^!macro\b/i.test(trimmed)) depth += 1;
    else if (/^!macroend\b/i.test(trimmed)) depth -= 1;
    out.push(lines[index]);
    if (depth === 0) return out.join("\n");
  }
  throw new Error(`unterminated !macro ${name}`);
}

function slicePreprocBlock(text, pattern) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => pattern.test(line.trim()));
  assert.ok(start >= 0, `missing preprocessor block ${pattern}`);
  let depth = 0;
  const out = [];
  for (let index = start; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^!(ifdef|ifndef)\b/i.test(trimmed)) depth += 1;
    else if (/^!endif\b/i.test(trimmed)) depth -= 1;
    out.push(lines[index]);
    if (depth === 0) return out.join("\n");
  }
  throw new Error(`unterminated preprocessor block ${pattern}`);
}

function sliceSection(text) {
  const start = text.indexOf('Section ""');
  assert.ok(start >= 0, 'missing preflight Section ""');
  const end = text.indexOf("SectionEnd", start);
  assert.ok(end > start, "missing SectionEnd");
  return text.slice(start, end);
}

function sliceFunction(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s*Function\\s+${name.replace(".", "\\.")}\\s*$`, "i").test(line));
  assert.ok(start >= 0, `missing Function ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^\s*FunctionEnd\s*$/i.test(line));
  assert.ok(end > start, `missing FunctionEnd for ${name}`);
  return lines.slice(start + 1, end);
}

function normalizeNsis(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/;.*$/, "").replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function deriveCallSites(sectionText) {
  const lines = sectionText.split(/\r?\n/);
  const sites = [];
  let guard = null;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    if (/^\$\{if\}\s+\$installMode\s*==\s*"all"\s*$/i.test(trimmed)) {
      assert.equal(guard, null, "unexpected nested all-users guard");
      guard = ALL_USERS_GUARD;
      continue;
    }
    if (/^\$\{endif\}$/i.test(trimmed)) {
      guard = null;
      continue;
    }
    const push = /^Push\s+"([A-Z_]+)"$/.exec(trimmed);
    if (push) {
      assert.equal(lines[index + 1]?.trim(), `Call ${PREPARE}`, `unexpected Push ${trimmed} before ${lines[index + 1]?.trim()}`);
      sites.push({ root: push[1], guard });
      index += 1;
    }
  }
  for (const line of lines) {
    const call = /^Call\s+(\S+)/.exec(line.trim());
    if (call) assert.equal(call[1], PREPARE, `unexpected Call target ${call[1]}`);
  }
  return sites;
}

function deriveFrameworkSites(installSectionText) {
  const sites = [];
  let guard = null;
  for (const raw of installSectionText.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (new RegExp(`^\\$\\{if\\}\\s+\\$installMode\\s*==\\s*"all"\\s*$`, "i").test(trimmed)) guard = ALL_USERS_GUARD;
    else if (/^\$\{endif\}$/i.test(trimmed)) guard = null;
    const call = /^!insertmacro\s+uninstallOldVersion\s+(\S+)/i.exec(trimmed);
    if (call) sites.push({ root: call[1], guard });
  }
  return sites;
}

// --- bounded NSIS subset interpreter --------------------------------------

class NsisAborted extends Error {}
class NsisQuit extends Error {}

function tokenize(line) {
  const tokens = [];
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === " " || char === "\t") { index += 1; continue; }
    if (char === ";" || char === "#") break;
    if (char === '"' || char === "'" || char === "`") {
      let cursor = index + 1;
      let value = "";
      while (cursor < line.length && line[cursor] !== char) { value += line[cursor]; cursor += 1; }
      assert.ok(cursor < line.length, `unterminated quote in ${line}`);
      tokens.push({ value, literal: char === "'" });
      index = cursor + 1;
      continue;
    }
    let cursor = index;
    while (cursor < line.length && line[cursor] !== " " && line[cursor] !== "\t") cursor += 1;
    tokens.push({ value: line.slice(index, cursor), literal: false });
    index = cursor;
  }
  return tokens;
}

function compileFunction(lines) {
  const instructions = [];
  const labels = new Map();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[A-Za-z_][A-Za-z0-9_.]*:$/.test(line)) { labels.set(line.slice(0, -1), instructions.length); continue; }
    const tokens = tokenize(line);
    if (!tokens.length) continue;
    instructions.push({ op: tokens[0].value.toUpperCase(), tokens, line });
  }
  return { instructions, labels };
}

class NsisVm {
  constructor({ registry, files = new Set(), directories = new Set(), copyDenied = false, shellContextRoot, pluginsDir }) {
    this.registers = {};
    for (let index = 0; index < 10; index += 1) { this.registers[`$${index}`] = ""; this.registers[`$R${index}`] = ""; }
    // The section runs InitPluginsDir before staging and before the preparations; this interpreter
    // drives the preparation function directly, so the plugins directory is supplied up front.
    this.vars = { $PLUGINSDIR: pluginsDir ?? "", $INSTDIR: "C:\\synthetic\\install", $HWNDPARENT: "0" };
    this.stack = [];
    this.error = false;
    this.errorLevel = 0;
    this.registry = registry;
    this.files = files;
    this.directories = directories;
    this.copyDenied = copyDenied;
    this.shellContextRoot = shellContextRoot;
    this.pluginsDir = pluginsDir;
    this.functions = new Map();
    this.copies = [];
    this.messages = [];
  }

  define(name, compiled) { this.functions.set(name, compiled); }

  read(name) { return this.registers[name] ?? this.vars[name] ?? ""; }

  write(name, value) {
    if (name in this.registers) { this.registers[name] = String(value); return; }
    assert.ok(name in this.vars, `unknown variable ${name}`);
    this.vars[name] = String(value);
  }

  expand(token) {
    if (token.literal) return token.value;
    return token.value.replace(/\$[A-Za-z_0-9]+/g, (name) => this.read(name));
  }

  resolveRoot(root) { return root === "SHELL_CONTEXT" ? this.shellContextRoot : ({ HKEY_CURRENT_USER: "HKCU", HKEY_LOCAL_MACHINE: "HKLM" }[root] ?? root); }

  // Only the explicit sets count: nothing exists by default, and a listed parent directory does not
  // make its child path exist. A "<dir>\*.*" probe matches a directory, as NSIS does.
  pathExists(target) {
    if (target.endsWith(DIR_CONTENTS_SUFFIX)) return this.directories.has(target.slice(0, -DIR_CONTENTS_SUFFIX.length));
    return this.files.has(target) || this.directories.has(target);
  }

  jump(token, frame, pc) {
    if (!token) return null;
    const value = token.value;
    if (value === "0") return null;
    if (/^[+-]?\d+$/.test(value)) return pc + Number(value);
    assert.ok(frame.labels.has(value), `unknown jump target ${value}`);
    return frame.labels.get(value);
  }

  run(name, args = []) {
    for (const arg of args) this.stack.push(String(arg));
    const frame = this.functions.get(name);
    assert.ok(frame, `unknown function ${name}`);
    this.execute(frame, name);
    assert.equal(this.stack.length, 0, `${name} must balance the stack`);
  }

  execute(frame, name) {
    let pc = 0;
    while (pc < frame.instructions.length) {
      const target = this.step(frame, pc, name);
      if (target === "return") return;
      pc = target === null || target === undefined ? pc + 1 : target;
    }
  }

  step(frame, pc, name) {
    const instruction = frame.instructions[pc];
    const tokens = instruction.tokens;
    switch (instruction.op) {
      case "EXCH": {
        assert.ok(this.stack.length > 0, `EXCH underflow in ${name}`);
        const top = this.stack.pop();
        this.stack.push(this.read(tokens[1].value));
        this.write(tokens[1].value, top);
        return null;
      }
      case "PUSH": this.stack.push(this.expand(tokens[1])); return null;
      case "POP": {
        assert.ok(this.stack.length > 0, `POP underflow in ${name}`);
        this.write(tokens[1].value, this.stack.pop());
        return null;
      }
      case "STRCPY": {
        const source = this.expand(tokens[2]);
        const maxLen = tokens[3] === undefined ? null : this.expand(tokens[3]);
        const offset = Number((tokens[4] === undefined ? "0" : this.expand(tokens[4])) || "0");
        const start = offset >= 0 ? offset : Math.max(0, source.length + offset);
        const value = maxLen === null || maxLen === "" ? source.slice(start) : source.slice(start, start + Number(maxLen));
        this.write(tokens[1].value, value);
        return null;
      }
      case "STRCMP": {
        const equal = this.expand(tokens[1]) === this.expand(tokens[2]);
        if (equal) return this.jump(tokens[3], frame, pc);
        return tokens[4] ? this.jump(tokens[4], frame, pc) : null;
      }
      case "INTOP": {
        const operator = tokens[3].value;
        const left = Number(this.expand(tokens[2]) || "0");
        const right = Number(this.expand(tokens[4]) || "0");
        const results = { "+": left + right, "-": left - right, "*": left * right, "/": Math.trunc(left / right), "%": left % right };
        assert.ok(operator in results, `unsupported IntOp ${operator}`);
        this.write(tokens[1].value, String(results[operator]));
        return null;
      }
      case "GOTO": return this.jump(tokens[1], frame, pc);
      case "READREGSTR": {
        const root = this.resolveRoot(this.expand(tokens[2]));
        const key = this.expand(tokens[3]);
        const value = this.expand(tokens[4]);
        this.write(tokens[1].value, this.registry.get(`${root}\u0000${key}\u0000${value}`) ?? "");
        return null;
      }
      case "CLEARERRORS": this.error = false; return null;
      case "IFFILEEXISTS": {
        const exists = this.pathExists(this.expand(tokens[1]));
        if (exists) return tokens[2] ? this.jump(tokens[2], frame, pc) : null;
        return tokens[3] ? this.jump(tokens[3], frame, pc) : null;
      }
      case "IFERRORS": {
        if (this.error) return tokens[1] ? this.jump(tokens[1], frame, pc) : null;
        return tokens[2] ? this.jump(tokens[2], frame, pc) : null;
      }
      case "COPYFILES": {
        const source = this.expand(tokens[tokens.length - 2]);
        const destination = this.expand(tokens[tokens.length - 1]);
        const directory = destination.slice(0, destination.lastIndexOf("\\"));
        // A missing destination is created as long as its parent directory exists, so a successful
        // copy here proves nothing about the old executable; only the source guard does.
        const ok = !this.copyDenied && this.directories.has(directory);
        this.error = !ok;
        this.copies.push({ source, destination, ok });
        return null;
      }
      case "SETERRORLEVEL": this.errorLevel = Number(this.expand(tokens[1])); return null;
      case "MESSAGEBOX": {
        this.messages.push({ flags: tokens[1].value, text: this.expand(tokens[2]), silent: tokens[3]?.value.toLowerCase() === "/sd" ? tokens[4].value : null });
        return null;
      }
      case "ABORT": throw new NsisAborted();
      case "QUIT": throw new NsisQuit();
      case "INITPLUGINSDIR": this.vars.$PLUGINSDIR = this.pluginsDir; return null;
      case "CALL": {
        const target = tokens[1].value;
        assert.ok(this.functions.has(target), `unknown Call ${target}`);
        this.execute(this.functions.get(target), target);
        return null;
      }
      case "RETURN": return "return";
      default: throw new Error(`unsupported NSIS instruction: ${instruction.line}`);
    }
  }
}

// --- preflight model, derived from the actual sources ---------------------

const DEFINES = { UNINSTALL_REGISTRY_KEY: KEY_PRIMARY, UNINSTALL_REGISTRY_KEY_2: KEY_SECONDARY, UNINSTALLER_OUT_FILE: UNINSTALLER_OUT };
const installExpansion = preprocess(`${sources.installer}\n!insertmacro customHeader\n`, DEFINES);
const uninstallerExpansion = preprocess(`${sources.installer}\n!insertmacro customHeader\n`, { BUILD_UNINSTALLER: "" });
const customHeaderBody = sliceMacroBody(sources.installer, "customHeader");
const preflightSection = sliceSection(installExpansion.text);
const installFrame = compileFunction(sliceFunction(installExpansion.text, PREPARE));
const getInQuotesFrame = compileFunction(sliceFunction(sources.installUtil, "GetInQuotes"));
const sectionCallSites = deriveCallSites(preflightSection);
const frameworkCallSites = deriveFrameworkSites(sources.installSection);

function makeRegistry(entries) {
  const registry = new Map();
  for (const entry of entries) registry.set(`${entry.root}\u0000${entry.key}\u0000${entry.name}`, entry.value);
  return registry;
}

function registryEntry(root, value, key = KEY_PRIMARY) {
  return { root, key, name: "UninstallString", value };
}

function runPreflight({ installMode, registry, files = new Set(), directories = new Set(), copyDenied = false, silent = false, admin = true, hasPerMachineInstallation = "0" }) {
  const events = [];
  if (hasPerMachineInstallation === "1" && silent && !admin) return { events: ["elevate-and-quit"], frameworkUninstall: false };
  let finalMode = installMode;
  if (hasPerMachineInstallation === "1" && silent && admin) { events.push("set-all-users"); finalMode = "all"; }
  const shellContextRoot = finalMode === "all" ? "HKLM" : "HKCU";
  const vm = new NsisVm({ registry, files, directories, copyDenied, shellContextRoot, pluginsDir: STAGING_DIR });
  vm.define(PREPARE, installFrame);
  vm.define("GetInQuotes", getInQuotesFrame);
  let frameworkUninstall = true;
  try {
    for (const site of sectionCallSites) {
      if (site.guard === ALL_USERS_GUARD && finalMode !== "all") continue;
      const copiedBefore = vm.copies.length;
      vm.run(PREPARE, [site.root]);
      events.push(vm.copies.length > copiedBefore ? `prepare:${site.root}` : `skip:${site.root}`);
    }
  } catch (error) {
    assert.ok(error instanceof NsisAborted, `unexpected error: ${error.message}`);
    frameworkUninstall = false;
    events.push(`aborted:errorLevel=${vm.errorLevel}`);
  }
  return { events, frameworkUninstall, messages: vm.messages, copies: vm.copies };
}

const PROGRAMS_DIR = "C:\\Program Files\\OpenFix";
const USER_DIR = "C:\\Users\\tester\\AppData\\Local\\Programs\\OpenFix";
const oldUninstallerPath = (dir, name = "Uninstall OpenFix.exe") => `${dir}\\${name}`;
const oldUninstaller = (dir, name = "Uninstall OpenFix.exe") => `"${oldUninstallerPath(dir, name)}" /currentuser`;

// --- template owner / include-order contract ------------------------------

test("pinned app-builder-lib 26.15.6 still owns the customHeader seam before the uninstall calls", () => {
  assert.equal(sources.packageJson.devDependencies["electron-builder"], "26.15.6");
  assert.match(sources.installDir, /app-builder-lib@26\.15\.6/);

  const installerNsi = sources.installerNsi;
  const indexOf = (needle) => installerNsi.indexOf(needle);
  const insert = indexOf("!ifmacrodef customHeader");
  const insertCall = indexOf("!insertmacro customHeader", insert);
  const onInit = indexOf("Function .onInit");
  const installUtil = indexOf('!include "installUtil.nsh"');
  const installSection = indexOf('Section "install" INSTALL_SECTION_ID');
  assert.ok(insert !== -1 && insertCall !== -1, "installer.nsi must still inject customHeader");
  assert.ok(insertCall < onInit, "customHeader must be injected before Function .onInit");
  assert.ok(insert < installUtil, "customHeader must be declared before installUtil.nsh is included");
  assert.ok(installUtil < installSection, "installUtil.nsh must be included before Section install");
  // The template relies on forward Call resolution, which is what lets the seam call GetInQuotes.
  assert.ok(indexOf("Call setInstallSectionSpaceRequired") < indexOf("Function setInstallSectionSpaceRequired"));

  assert.match(sources.installSection, /!insertmacro uninstallOldVersion SHELL_CONTEXT[\s\S]*!insertmacro handleUninstallResult SHELL_CONTEXT/);
  assert.match(sources.installUtil, /Function GetInQuotes[\s\S]*FunctionEnd/);
  assert.match(sources.installUtil, /!insertmacro readReg \$uninstallString "\$rootKey" "\$\{UNINSTALL_REGISTRY_KEY\}" UninstallString/);
  assert.match(sources.installUtil, /!ifdef UNINSTALL_REGISTRY_KEY_2[\s\S]*!insertmacro readReg \$uninstallString "\$rootKey" "\$\{UNINSTALL_REGISTRY_KEY_2\}" UninstallString/);
  assert.match(sources.multiUser, /!define \/ifndef UNINSTALL_REGISTRY_KEY/);
  assert.match(sources.installUtil, /!macro readReg VAR ROOT_KEY SUB_KEY NAME[\s\S]*ReadRegStr "\$\{VAR\}" SHELL_CONTEXT/);

  assert.match(sources.builderConfig, /include: build\/installer\.nsh/);
  assert.match(sources.builderConfig, /oneClick: false/);
  assert.doesNotMatch(sources.builderConfig, /perMachine:/, "the guarded silent elevation mirror must stay active for this config");
});

test("the preflight section prepares the same hives, in the same order, as installSection.nsh", () => {
  assert.deepEqual(sectionCallSites, [
    { root: "SHELL_CONTEXT", guard: null },
    { root: "HKEY_CURRENT_USER", guard: ALL_USERS_GUARD },
  ]);
  assert.deepEqual(sectionCallSites, frameworkCallSites, "the seam must mirror installSection's uninstall calls");
  const shell = preflightSection.indexOf('Push "SHELL_CONTEXT"');
  const current = preflightSection.indexOf('Push "HKEY_CURRENT_USER"');
  const guard = preflightSection.indexOf(`\${if} ${ALL_USERS_GUARD}`);
  assert.ok(shell !== -1 && current !== -1 && guard !== -1);
  assert.ok(shell < current, "SHELL_CONTEXT must be prepared before HKEY_CURRENT_USER");
  assert.ok(guard < current, "the HKEY_CURRENT_USER preparation must stay inside the all-users guard");
});

test("the elevation mirror matches installer.nsi and precedes staging and both preparations", () => {
  const frameworkRegion = slicePreprocBlock(
    sources.installerNsi.slice(sources.installerNsi.indexOf('Section "install" INSTALL_SECTION_ID')),
    /^!ifndef INSTALL_MODE_PER_ALL_USERS$/,
  );
  const mirrorRegion = slicePreprocBlock(sliceSection(customHeaderBody), /^!ifndef INSTALL_MODE_PER_ALL_USERS$/);
  assert.equal(normalizeNsis(mirrorRegion), normalizeNsis(frameworkRegion), "the silent per-machine elevation must mirror the framework");
  assert.match(preflightSection, /\$\{Silent\}/);
  assert.doesNotMatch(customHeaderBody, /isUpdated/, "the preflight must run for manual, updated and silent installs alike");

  const elevation = preflightSection.indexOf("UAC_RunElevated");
  const fileDirective = preflightSection.indexOf("File /oname=");
  const firstPrepare = preflightSection.indexOf(`Call ${PREPARE}`);
  assert.ok(elevation !== -1 && elevation < fileDirective, "elevation must happen before the uninstaller is staged");
  assert.ok(fileDirective < firstPrepare, "the uninstaller must be staged before the preparations");
  const fileDirectives = preflightSection.split(/\r?\n/).filter((line) => /^\s*File\b/.test(line));
  assert.deepEqual(fileDirectives.map((line) => line.trim()), [`File /oname=$PLUGINSDIR\\openfic-prior-uninstaller.exe "${UNINSTALLER_OUT}"`]);
});

// --- actual GetInQuotes and actual preparation function -------------------

test("the real installUtil.nsh GetInQuotes derives the exact previous uninstaller path", () => {
  const parsed = (input) => {
    const vm = new NsisVm({ registry: new Map(), directories: new Set(), shellContextRoot: "HKCU", pluginsDir: STAGING_DIR });
    vm.define("GetInQuotes", getInQuotesFrame);
    vm.stack.push(input);
    vm.execute(vm.functions.get("GetInQuotes"), "GetInQuotes");
    assert.equal(vm.stack.length, 1, "GetInQuotes must leave exactly one result on the stack");
    return vm.stack.pop();
  };
  assert.equal(parsed('"C:\\Program Files\\OpenFix\\Uninstall OpenFix.exe" /currentuser'), "C:\\Program Files\\OpenFix\\Uninstall OpenFix.exe");
  assert.equal(parsed('"D:\\Apps\\Old Name\\Uninstall Old Name.exe" /allusers'), "D:\\Apps\\Old Name\\Uninstall Old Name.exe");
  assert.equal(parsed("no quotes at all"), "");
  assert.equal(parsed(""), "");
  assert.equal(parsed('"unterminated'), "");
});

test("a missing registration is a fresh-install no-op", () => {
  const cases = [
    { installMode: "CurrentUser", events: ["skip:SHELL_CONTEXT"] },
    { installMode: "all", events: ["skip:SHELL_CONTEXT", "skip:HKEY_CURRENT_USER"] },
  ];
  for (const expected of cases) {
    const result = runPreflight({ installMode: expected.installMode, registry: new Map(), directories: new Set() });
    assert.equal(result.frameworkUninstall, true);
    assert.deepEqual(result.copies, []);
    assert.deepEqual(result.events, expected.events);
    assert.deepEqual(result.messages, []);
  }
});

test("a per-user registration prepares only SHELL_CONTEXT", () => {
  const registry = makeRegistry([registryEntry("HKCU", oldUninstaller(USER_DIR))]);
  const result = runPreflight({
    installMode: "CurrentUser",
    registry,
    files: new Set([oldUninstallerPath(USER_DIR)]),
    directories: new Set([USER_DIR]),
  });
  assert.deepEqual(result.events, ["prepare:SHELL_CONTEXT"]);
  assert.equal(result.frameworkUninstall, true);
  assert.deepEqual(result.copies, [{ source: STAGED_FILE, destination: oldUninstallerPath(USER_DIR), ok: true }]);
});

test("an all-users registration prepares both hives before the framework uninstall, honouring differing paths", () => {
  const legacyPath = oldUninstallerPath(USER_DIR, "Uninstall Legacy Name.exe");
  const registry = makeRegistry([
    registryEntry("HKLM", `"${PROGRAMS_DIR}\\Uninstall OpenFix.exe" /allusers`),
    registryEntry("HKCU", `"${legacyPath}" /currentuser`, KEY_SECONDARY),
  ]);
  const result = runPreflight({
    installMode: "all",
    registry,
    files: new Set([oldUninstallerPath(PROGRAMS_DIR), legacyPath]),
    directories: new Set([PROGRAMS_DIR, USER_DIR]),
  });
  assert.deepEqual(result.events, ["prepare:SHELL_CONTEXT", "prepare:HKEY_CURRENT_USER"]);
  assert.equal(result.frameworkUninstall, true);
  assert.deepEqual(result.copies, [
    { source: STAGED_FILE, destination: oldUninstallerPath(PROGRAMS_DIR), ok: true },
    { source: STAGED_FILE, destination: legacyPath, ok: true },
  ]);
});

test("the secondary registry key is only consulted when the primary is empty", () => {
  const fallbackOnly = makeRegistry([registryEntry("HKCU", oldUninstaller(USER_DIR), KEY_SECONDARY)]);
  const result = runPreflight({
    installMode: "CurrentUser",
    registry: fallbackOnly,
    files: new Set([oldUninstallerPath(USER_DIR)]),
    directories: new Set([USER_DIR]),
  });
  assert.deepEqual(result.copies.map((copy) => copy.destination), [oldUninstallerPath(USER_DIR)]);

  const primaryWins = makeRegistry([
    registryEntry("HKCU", oldUninstaller(USER_DIR, "Primary.exe")),
    registryEntry("HKCU", oldUninstaller("C:\\Other", "Secondary.exe"), KEY_SECONDARY),
  ]);
  const chosen = runPreflight({
    installMode: "CurrentUser",
    registry: primaryWins,
    files: new Set([oldUninstallerPath(USER_DIR, "Primary.exe")]),
    directories: new Set([USER_DIR, "C:\\Other"]),
  });
  assert.deepEqual(chosen.copies.map((copy) => copy.destination), [oldUninstallerPath(USER_DIR, "Primary.exe")]);
});

test("a silent per-machine install elevates before preparing; the elevated pass then prepares both hives", () => {
  const first = runPreflight({
    installMode: "all", registry: new Map(), directories: new Set(),
    silent: true, admin: false, hasPerMachineInstallation: "1",
  });
  assert.deepEqual(first.events, ["elevate-and-quit"]);
  assert.equal(first.frameworkUninstall, false, "the unelevated pass must not reach any uninstall or preparation");

  const registry = makeRegistry([
    registryEntry("HKLM", `"${PROGRAMS_DIR}\\Uninstall OpenFix.exe" /allusers`),
    // An absent registration is a fresh-install no-op, so a fixture that expects the second hive to
    // be prepared must register its own previous uninstaller instead of relying on a default entry.
    registryEntry("HKCU", oldUninstaller(USER_DIR)),
  ]);
  const second = runPreflight({
    installMode: "all",
    registry,
    files: new Set([oldUninstallerPath(PROGRAMS_DIR), oldUninstallerPath(USER_DIR)]),
    directories: new Set([PROGRAMS_DIR, USER_DIR]),
    silent: true,
    admin: true,
    hasPerMachineInstallation: "1",
  });
  assert.deepEqual(second.events, ["set-all-users", "prepare:SHELL_CONTEXT", "prepare:HKEY_CURRENT_USER"]);
  assert.equal(second.frameworkUninstall, true);
  assert.deepEqual(second.copies, [
    // SHELL_CONTEXT resolves to HKLM after the elevated all-users switch.
    { source: STAGED_FILE, destination: oldUninstallerPath(PROGRAMS_DIR), ok: true },
    { source: STAGED_FILE, destination: oldUninstallerPath(USER_DIR), ok: true },
  ]);
});

test("a malformed registration is fail-closed before the framework uninstall", () => {
  const registry = makeRegistry([registryEntry("HKCU", "C:\\Broken\\Uninstall.exe")]);
  const result = runPreflight({ installMode: "CurrentUser", registry, directories: new Set(["C:\\Broken"]) });
  assert.equal(result.frameworkUninstall, false);
  assert.deepEqual(result.copies, []);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].silent, "IDOK");
  assert.match(result.messages[0].text, /cannot prepare the previous uninstaller/);
  assert.deepEqual(result.events, ["aborted:errorLevel=2"]);
});

test("a registered previous uninstaller missing beside its existing parent directory is fail-closed without a copy", () => {
  const registry = makeRegistry([registryEntry("HKCU", oldUninstaller(USER_DIR))]);
  // The parent directory exists and is the copy destination's parent, so CopyFiles would have
  // created the missing file; only the explicit existence guard can stop this case, and files
  // proves the registered executable itself does not exist.
  const result = runPreflight({
    installMode: "CurrentUser",
    registry,
    files: new Set(),
    directories: new Set([USER_DIR]),
  });
  assert.equal(result.frameworkUninstall, false, "the framework uninstall must not run");
  assert.deepEqual(result.copies, []);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].silent, "IDOK");
  assert.match(result.messages[0].text, /cannot prepare the previous uninstaller/);
  assert.deepEqual(result.events, ["aborted:errorLevel=2"]);

  // Single-variable contrast: same registration, same existing parent directory, only the
  // executable's existence changed. The copy model accepts this destination, so the empty copies
  // list above is caused by the source guard and not by a copy that could not have succeeded.
  const present = runPreflight({
    installMode: "CurrentUser",
    registry,
    files: new Set([oldUninstallerPath(USER_DIR)]),
    directories: new Set([USER_DIR]),
  });
  assert.deepEqual(present.copies, [{ source: STAGED_FILE, destination: oldUninstallerPath(USER_DIR), ok: true }]);
});

test("a registered path that is a directory or cannot be replaced is fail-closed", () => {
  const registered = oldUninstaller(USER_DIR);
  const registeredPath = oldUninstallerPath(USER_DIR);

  const directory = runPreflight({
    installMode: "CurrentUser",
    registry: makeRegistry([registryEntry("HKCU", registered)]),
    files: new Set(),
    directories: new Set([USER_DIR, registeredPath]),
  });
  assert.equal(directory.frameworkUninstall, false);
  assert.deepEqual(directory.copies, []);
  assert.equal(directory.messages.length, 1);
  assert.equal(directory.messages[0].silent, "IDOK");
  assert.match(directory.messages[0].text, /cannot prepare the previous uninstaller/);
  assert.deepEqual(directory.events, ["aborted:errorLevel=2"]);

  // The registered executable exists, so the guard passes and the copy is genuinely attempted.
  const denied = runPreflight({
    installMode: "CurrentUser",
    registry: makeRegistry([registryEntry("HKCU", registered)]),
    files: new Set([registeredPath]),
    directories: new Set([USER_DIR]),
    copyDenied: true,
  });
  assert.equal(denied.frameworkUninstall, false);
  assert.deepEqual(denied.copies, [{ source: STAGED_FILE, destination: registeredPath, ok: false }]);
  assert.equal(denied.messages[0].silent, "IDOK");
  assert.match(denied.messages[0].text, /cannot prepare the previous uninstaller/);
  assert.deepEqual(denied.events, ["aborted:errorLevel=2"]);
});

test("BUILD_UNINSTALLER defines no customHeader and the runtime-preserving uninstaller stays intact", () => {
  assert.ok(installExpansion.macros.has("customHeader"));
  assert.equal(uninstallerExpansion.macros.has("customHeader"), false);
  assert.match(installExpansion.text, new RegExp(`Function ${PREPARE}`));
  assert.match(installExpansion.text, /Section ""/);
  assert.doesNotMatch(uninstallerExpansion.text, new RegExp(`Function ${PREPARE}`));
  assert.doesNotMatch(uninstallerExpansion.text, /Section ""/);

  assert.doesNotMatch(sources.installer, /!macro customInit\b/, "the previous customInit seam must be removed");
  assert.match(customHeaderBody, /^!macro customHeader/m);
  assert.match(customHeaderBody, /!macroend/);

  const runtime = sliceMacroBody(sources.installer, "customRemoveFiles");
  assert.match(runtime, /StrCpy \$openficPreserveRuntime "1"/);
  assert.match(runtime, /Call un\.openficAtomicRemove/);
  assert.match(runtime, /\$\{ifNot\} \$\{isUpdated\}/);
  assert.match(sources.installer, /Function un\.openficAtomicRemove/);
  assert.match(sources.installer, /Function un\.openficRemoveDirect/);
  assert.match(sources.uninstallerNsh, /!insertmacro customRemoveFiles/);
  assert.match(sources.installer, /!macro customInstallmode/);
  assert.match(sources.assisted, /!ifmacrodef customFinishPage/);
  assert.match(sources.installer, /!macro customFinishPage/);
  // The staging directive must exist exactly once inside the seam and nowhere else in the file.
  assert.equal(sources.installer.split("UNINSTALLER_OUT_FILE").length - 1, 1);
  assert.doesNotMatch(sources.installer, /\$\{UNINSTALL_FILENAME\}/, "no guessed destination may remain");
});
