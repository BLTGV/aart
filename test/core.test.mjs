import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { internals } from "../lib/cli.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function withXdgConfigHome(configHome, fn) {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previous;
    }
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("createToken creates unguessable URL-safe tokens", () => {
  const token = internals.createToken(24);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.ok(token.length >= 32);
});

test("CLI help describes the multi-artifact project model", () => {
  const result = spawnSync(process.execPath, ["bin/aart.mjs", "--help"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /many independent artifact directories/);
  assert.match(result.stdout, /Each publish\s+creates its own unguessable share token and URL/);
  assert.match(result.stdout, /\.aart\/config\.json\s+stores project publishing configuration only, not artifact state/);
  assert.match(result.stdout, /Use setup --user to write user defaults/);
  assert.match(result.stdout, /aart setup --bucket <bucket> --base-url <url> \[--domain <domain>\] \[--user\]/);
  assert.match(result.stdout, /aart publish <artifact-dir> \[--json\] \[--token <token>\] \[--save\]/);
  assert.match(result.stdout, /npx github:BLTGV\/aart setup --bucket aart --base-url https:\/\/aart\.example\.com/);
  assert.doesNotMatch(result.stdout, /npx @bltgv\/aart/);
});

test("injectNoindex inserts robots meta into HTML head", () => {
  const html = "<!doctype html><html><head><title>x</title></head><body></body></html>";
  const result = internals.injectNoindex(html);
  assert.match(result, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(result, /<head>\s+<meta/);
});

test("injectNoindex preserves existing robots meta", () => {
  const html = '<html><head><meta name="robots" content="noindex"></head></html>';
  assert.equal(internals.injectNoindex(html), html);
});

test("normalizeConfig supplies defaults", () => {
  const config = internals.normalizeConfig({
    bucket: "aart",
    publicBaseUrl: "https://aart.example.com"
  });
  assert.equal(config.prefix, "shares");
  assert.equal(config.tokenBytes, 24);
  assert.equal(config.cache.html, "public, max-age=60, must-revalidate");
});

test("shareUrlFor returns the token prefix URL without index.html", () => {
  const config = internals.normalizeConfig({
    bucket: "aart",
    publicBaseUrl: "https://aart.example.com",
    prefix: "shares"
  });

  assert.equal(internals.shareUrlFor(config, "abc123XYZ_abc123XYZ_abc123XYZ"), "https://aart.example.com/shares/abc123XYZ_abc123XYZ_abc123XYZ/");
});

test("objectKeysForFile aliases root index.html to the token prefix", () => {
  const config = internals.normalizeConfig({
    bucket: "aart",
    publicBaseUrl: "https://aart.example.com",
    prefix: "shares"
  });

  assert.deepEqual(internals.objectKeysForFile(config, "abc123XYZ_abc123XYZ_abc123XYZ", "index.html"), [
    "shares/abc123XYZ_abc123XYZ_abc123XYZ/index.html",
    "shares/abc123XYZ_abc123XYZ_abc123XYZ/"
  ]);
  assert.deepEqual(internals.objectKeysForFile(config, "abc123XYZ_abc123XYZ_abc123XYZ", "assets/style.css"), [
    "shares/abc123XYZ_abc123XYZ_abc123XYZ/assets/style.css"
  ]);
});

test("r2ObjectArgs uses remote storage for Wrangler object commands", () => {
  assert.deepEqual(internals.r2ObjectArgs("put", "aart/shares/token/index.html", ["--file", "index.html"]), [
    "r2",
    "object",
    "put",
    "aart/shares/token/index.html",
    "--remote",
    "--file",
    "index.html"
  ]);
});

test("loadConfig uses user config when project config is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aart-config-"));
  try {
    const configHome = path.join(dir, "config-home");
    const projectDir = path.join(dir, "project");
    fs.mkdirSync(projectDir, { recursive: true });

    withXdgConfigHome(configHome, () => {
      const userConfigPath = internals.getUserConfigPath();
      writeJson(userConfigPath, {
        bucket: "aartglobal",
        publicBaseUrl: "https://global.example.com",
        prefix: "global-shares"
      });

      const result = internals.loadConfig(projectDir);
      assert.equal(result.configSource, "user");
      assert.equal(result.configPath, userConfigPath);
      assert.equal(result.projectConfigPath, null);
      assert.equal(result.userConfigPath, userConfigPath);
      assert.equal(result.projectRoot, projectDir);
      assert.equal(result.config.bucket, "aartglobal");
      assert.equal(result.config.publicBaseUrl, "https://global.example.com");
      assert.equal(result.config.prefix, "global-shares");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig lets project config override user config field by field", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aart-config-"));
  try {
    const configHome = path.join(dir, "config-home");
    const projectDir = path.join(dir, "project");
    const nestedDir = path.join(projectDir, "nested");
    const projectConfigPath = path.join(projectDir, ".aart", "config.json");
    fs.mkdirSync(nestedDir, { recursive: true });

    withXdgConfigHome(configHome, () => {
      const userConfigPath = internals.getUserConfigPath();
      writeJson(userConfigPath, {
        bucket: "aartglobal",
        publicBaseUrl: "https://global.example.com",
        prefix: "global-shares",
        tokenBytes: 24,
        cache: {
          html: "global-html",
          assets: "global-assets"
        }
      });
      writeJson(projectConfigPath, {
        publicBaseUrl: "https://project.example.com",
        prefix: "project-shares",
        cache: {
          html: "project-html"
        }
      });

      const result = internals.loadConfig(nestedDir);
      assert.equal(result.configSource, "project+user");
      assert.equal(result.configPath, projectConfigPath);
      assert.equal(result.projectConfigPath, projectConfigPath);
      assert.equal(result.userConfigPath, userConfigPath);
      assert.equal(result.projectRoot, projectDir);
      assert.equal(result.config.bucket, "aartglobal");
      assert.equal(result.config.publicBaseUrl, "https://project.example.com");
      assert.equal(result.config.prefix, "project-shares");
      assert.equal(result.config.tokenBytes, 24);
      assert.equal(result.config.cache.html, "project-html");
      assert.equal(result.config.cache.assets, "global-assets");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveShareRecord appends project-local share history without changing config", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "aart-project-"));
  try {
    const configDir = path.join(projectDir, ".aart");
    const configPath = path.join(configDir, "config.json");
    const artifactDir = path.join(projectDir, "artifacts", "one");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, "{}\n");

    const savedTo = internals.saveShareRecord({
      configPath,
      artifactDir,
      record: {
        url: "https://aart.example.com/shares/token-one/",
        token: "token-one",
        publishedAt: "2026-07-03T00:00:00.000Z",
        bucket: "aart",
        prefix: "shares/token-one",
        manifestKey: "shares/token-one/manifest.json"
      }
    });

    internals.saveShareRecord({
      configPath,
      artifactDir,
      record: {
        url: "https://aart.example.com/shares/token-two/",
        token: "token-two",
        publishedAt: "2026-07-03T00:01:00.000Z",
        bucket: "aart",
        prefix: "shares/token-two",
        manifestKey: "shares/token-two/manifest.json"
      }
    });

    const history = JSON.parse(fs.readFileSync(savedTo, "utf8"));
    assert.equal(savedTo, path.join(configDir, "shares.json"));
    assert.equal(fs.readFileSync(configPath, "utf8"), "{}\n");
    assert.equal(history.version, 1);
    assert.deepEqual(history.shares.map((share) => share.token), ["token-one", "token-two"]);
    assert.equal(history.shares[0].artifactDir, "artifacts/one");
    assert.equal(history.shares[0].url, "https://aart.example.com/shares/token-one/");
    assert.equal(history.shares[0].manifestKey, "shares/token-one/manifest.json");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("tokenFromTarget extracts token from share URL", () => {
  const token = internals.tokenFromTarget("https://aart.example.com/shares/abc123XYZ_abc123XYZ_abc123XYZ/index.html", "shares");
  assert.equal(token, "abc123XYZ_abc123XYZ_abc123XYZ");
});

test("tokenFromTarget extracts token from no-index share URL", () => {
  const token = internals.tokenFromTarget("https://aart.example.com/shares/abc123XYZ_abc123XYZ_abc123XYZ/", "shares");
  assert.equal(token, "abc123XYZ_abc123XYZ_abc123XYZ");
});

test("validateArtifact requires root index.html", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aart-test-"));
  try {
    const result = internals.validateArtifact(dir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("index.html")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateArtifact accepts basic artifact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aart-test-"));
  try {
    fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head><body>Hello</body></html>");
    const result = internals.validateArtifact(dir);
    assert.equal(result.ok, true);
    assert.equal(result.fileCount, 1);
    assert.ok(result.warnings.some((warning) => warning.includes("robots meta")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
