import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { internals } from "../lib/cli.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

test("tokenFromTarget extracts token from share URL", () => {
  const token = internals.tokenFromTarget("https://aart.example.com/shares/abc123XYZ_abc123XYZ_abc123XYZ/index.html", "shares");
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
