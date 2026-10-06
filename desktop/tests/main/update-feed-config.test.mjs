// resources/app-update.yml is never packaged from the repo: electron-builder writes
// that file itself in its afterPack hook, which runs after extraResources have been
// copied. The update feed therefore has to be configured through electron-builder.yml's
// publish block, and the "no multiple range requests" guarantee has to come from
// electron-updater's own provider rather than from a copied yml. These tests pin that:
// a GitHub feed never uses multiple range requests (with or without the key), a generic
// feed only does when the key is absent, and the repo copy stays a non-packaged reference.
// Run after build:main with node --experimental-vm-modules --test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const require = createRequire(import.meta.url);
const { createClient } = require("electron-updater/out/providerFactory.js");

// Flat `key: value` reader, enough for the update feed blocks under test.
function readYamlScalars(content, blockKey = null) {
  const scalars = new Map();
  let collecting = blockKey === null;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indented = /^[ \t]/.test(line);
    if (blockKey !== null && !collecting) {
      if (trimmed === `${blockKey}:`) collecting = true;
      continue;
    }
    if (blockKey !== null && !indented) break;
    if (blockKey === null && indented) continue;
    const match = line.match(/^[ \t]*([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (match) {
      const value = match[2].trim();
      scalars.set(match[1], /^".*"$|^'.*'$/.test(value) ? value.slice(1, -1) : value);
    }
  }
  return scalars;
}

function readFile(relativePath) {
  return readFileSync(path.join(desktopDir, relativePath), "utf8");
}

// AppUpdater.createProviderRuntimeOptions() asks for multiple range requests; the
// provider is what decides whether that is honoured.
function createProvider(data) {
  return createClient(data, {}, { isUseMultipleRangeRequest: true, platform: "win32" });
}

const publishConfig = readYamlScalars(readFile("electron-builder.yml"), "publish");

test("a GitHub update feed never uses multiple range requests", () => {
  const feed = { provider: "github", owner: publishConfig.get("owner"), repo: publishConfig.get("repo") };

  assert.equal(createProvider(feed).isUseMultipleRangeRequest, false);
  assert.equal(createProvider({ ...feed, useMultipleRangeRequest: true }).isUseMultipleRangeRequest, false);
});

test("the GitHub publish block must not declare useMultipleRangeRequest", () => {
  // electron-builder validates publish against GithubOptions, which forbids unknown
  // properties: declaring the option here aborts packaging instead of configuring the
  // updater, and the GitHub provider already forces single range requests.
  assert.equal(publishConfig.get("provider"), "github");
  assert.equal(publishConfig.has("useMultipleRangeRequest"), false);
});

test("the generic local update feed declares single range requests and gets them", () => {
  const localPublishConfig = readYamlScalars(readFile("electron-builder.local-update.yml"), "publish");
  const feed = {
    provider: localPublishConfig.get("provider"),
    url: localPublishConfig.get("url"),
  };

  assert.equal(feed.provider, "generic");
  assert.equal(localPublishConfig.get("useMultipleRangeRequest"), "false");
  assert.equal(createProvider({ ...feed, useMultipleRangeRequest: false }).isUseMultipleRangeRequest, false);
  assert.equal(createProvider(feed).isUseMultipleRangeRequest, true);
});

test("no repo copy of the update feed is wired into the package", () => {
  assert.doesNotMatch(
    readFile("electron-builder.yml"),
    /from:\s*resources\/app-update\.yml/,
    "electron-builder regenerates resources/app-update.yml after extraResources are copied",
  );
});

test("the reference update feed still matches the publish block", () => {
  const reference = readYamlScalars(readFile("resources/app-update.yml"));

  for (const key of ["provider", "owner", "repo", "releaseType"]) {
    assert.equal(reference.get(key), publishConfig.get(key), key);
  }
});

test("the pull-request config gate does not require a release tag version", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(desktopDir, "scripts", "verify-release.mjs"), "--config-only"],
    {
      cwd: path.resolve(desktopDir, ".."),
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "true", OPENFIX_RELEASE_VERSION: "" },
    },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ALL CHECKS PASSED/);
});
