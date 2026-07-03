import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = ".aart";
const CONFIG_FILE = "config.json";
const DEFAULT_PREFIX = "shares";
const DEFAULT_TOKEN_BYTES = 24;
const DEFAULT_CACHE = {
  html: "public, max-age=60, must-revalidate",
  assets: "public, max-age=31536000, immutable"
};

const MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"]
]);

export async function main(argv) {
  const [command, ...rest] = argv;

  switch (command) {
    case "setup":
      await setup(rest);
      return;
    case "doctor":
      await doctor(rest);
      return;
    case "publish":
      await publish(rest);
      return;
    case "revoke":
      await revoke(rest);
      return;
    case "validate":
      await validateCommand(rest);
      return;
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\nRun "aart --help" for usage.`);
  }
}

async function setup(argv) {
  const { positional, flags } = parseArgs(argv);
  if (positional.length > 0) {
    throw new Error(`setup does not accept positional arguments: ${positional.join(" ")}`);
  }

  const existing = findConfig(process.cwd());
  const existingConfig = existing ? readJson(existing) : {};
  const config = normalizeConfig({
    ...existingConfig,
    bucket: flags.bucket ?? flags.b ?? existingConfig.bucket,
    publicBaseUrl: flags["base-url"] ?? flags.url ?? existingConfig.publicBaseUrl,
    prefix: flags.prefix ?? existingConfig.prefix ?? DEFAULT_PREFIX,
    tokenBytes: flags["token-bytes"] ? Number(flags["token-bytes"]) : existingConfig.tokenBytes ?? DEFAULT_TOKEN_BYTES
  });

  const configPath = path.join(process.cwd(), CONFIG_DIR, CONFIG_FILE);
  ensureDir(path.dirname(configPath));
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const steps = [];
  steps.push(checkWranglerVersion());
  steps.push(checkWranglerAuth());
  steps.push(ensureBucket(config.bucket));

  if (flags.domain) {
    steps.push(ensureDomain(config.bucket, flags.domain));
  }

  steps.push(uploadRobotsTxt(config));

  if (!flags["skip-smoke"]) {
    steps.push(await runSmokeTest(config));
  }

  output(flags, {
    ok: steps.every((step) => step.ok),
    configPath,
    config,
    steps
  }, `AART publishing configured at ${configPath}. This project config can publish many independent artifacts.`);
}

async function doctor(argv) {
  const { flags } = parseArgs(argv);
  const checks = [];
  let config = null;
  let configPath = null;

  checks.push(checkNodeVersion());
  checks.push(checkWranglerVersion());
  checks.push(checkWranglerAuth());

  try {
    ({ config, configPath } = loadConfig(process.cwd()));
    checks.push({ name: "config", ok: true, detail: configPath });
  } catch (error) {
    checks.push({ name: "config", ok: false, detail: error.message });
  }

  if (config) {
    checks.push(checkBucket(config.bucket));
    if (!flags["skip-smoke"]) {
      checks.push(await runSmokeTest(config));
    }
  }

  const result = {
    ok: checks.every((check) => check.ok),
    configPath,
    config,
    checks
  };

  output(flags, result, result.ok ? "AART doctor passed." : "AART doctor found problems.");

  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function publish(argv) {
  const { positional, flags } = parseArgs(argv);
  const artifactDir = positional[0];
  if (!artifactDir) {
    throw new Error("Usage: aart publish <artifact-dir> [--token <token>] [--json]");
  }

  const { config } = loadConfig(process.cwd());
  const validation = validateArtifact(artifactDir);
  if (!validation.ok) {
    throw new Error(formatValidationFailure(validation));
  }

  const token = flags.token ?? createToken(config.tokenBytes);
  validateToken(token);

  const files = listFiles(artifactDir);
  const uploaded = [];
  const tempFiles = [];

  try {
    for (const filePath of files) {
      const relativePath = toObjectPath(path.relative(artifactDir, filePath));
      const key = `${config.prefix}/${token}/${relativePath}`;
      const isHtml = path.extname(filePath).toLowerCase() === ".html";
      const uploadPath = isHtml ? createTempHtml(filePath, tempFiles) : filePath;
      const cacheControl = isHtml ? config.cache.html : config.cache.assets;

      putObject({
        bucket: config.bucket,
        key,
        filePath: uploadPath,
        contentType: contentTypeFor(filePath),
        cacheControl
      });

      uploaded.push({ key, source: relativePath, contentType: contentTypeFor(filePath) });
    }

    const url = joinUrl(config.publicBaseUrl, `${config.prefix}/${token}/index.html`);
    const manifest = {
      version: 1,
      token,
      url,
      publishedAt: new Date().toISOString(),
      files: uploaded.map((file) => file.key)
    };

    const manifestPath = createTempJson(manifest, tempFiles);
    const manifestKey = `${config.prefix}/${token}/manifest.json`;
    putObject({
      bucket: config.bucket,
      key: manifestKey,
      filePath: manifestPath,
      contentType: "application/json; charset=utf-8",
      cacheControl: config.cache.html
    });

    const result = {
      ok: true,
      url,
      token,
      bucket: config.bucket,
      prefix: `${config.prefix}/${token}`,
      files: [...uploaded.map((file) => file.key), manifestKey]
    };

    output(flags, result, url);
  } finally {
    for (const filePath of tempFiles) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

async function revoke(argv) {
  const { positional, flags } = parseArgs(argv);
  const target = positional[0];
  if (!target) {
    throw new Error("Usage: aart revoke <share-url-or-token> [--json]");
  }

  const { config } = loadConfig(process.cwd());
  const token = tokenFromTarget(target, config.prefix);
  validateToken(token);

  const tempPath = path.join(os.tmpdir(), `aart-manifest-${process.pid}-${Date.now()}.json`);
  const manifestKey = `${config.prefix}/${token}/manifest.json`;

  const get = runWrangler(["r2", "object", "get", `${config.bucket}/${manifestKey}`, "--file", tempPath], {
    capture: true
  });

  if (!get.ok) {
    throw new Error(`Could not fetch manifest for ${token}. Revoke needs ${manifestKey} to know which objects to delete.`);
  }

  const manifest = readJson(tempPath);
  fs.rmSync(tempPath, { force: true });

  const keys = Array.from(new Set([...(manifest.files ?? []), manifestKey]));
  for (const key of keys) {
    runWrangler(["r2", "object", "delete", `${config.bucket}/${key}`, "--force"], { capture: true });
  }

  output(flags, {
    ok: true,
    token,
    deleted: keys
  }, `Revoked ${token}.`);
}

async function validateCommand(argv) {
  const { positional, flags } = parseArgs(argv);
  const artifactDir = positional[0];
  if (!artifactDir) {
    throw new Error("Usage: aart validate <artifact-dir> [--json]");
  }

  const result = validateArtifact(artifactDir);
  output(flags, result, result.ok ? "Artifact is valid." : formatValidationFailure(result));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    name: "node",
    ok: major >= 18,
    detail: process.version
  };
}

function checkWranglerVersion() {
  const result = runWrangler(["--version"], { capture: true });
  return {
    name: "wrangler-version",
    ok: result.ok,
    detail: result.ok ? clean(result.stdout || result.stderr) : clean(result.stderr || result.stdout)
  };
}

function checkWranglerAuth() {
  const result = runWrangler(["whoami", "--json"], { capture: true });
  return {
    name: "wrangler-auth",
    ok: result.ok,
    detail: result.ok ? "authenticated" : "Run: npx wrangler login, or set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN."
  };
}

function checkBucket(bucket) {
  const result = runWrangler(["r2", "bucket", "info", bucket, "--json"], { capture: true });
  return {
    name: "r2-bucket",
    ok: result.ok,
    detail: result.ok ? bucket : clean(result.stderr || result.stdout)
  };
}

function ensureBucket(bucket) {
  const existing = checkBucket(bucket);
  if (existing.ok) {
    return { name: "r2-bucket", ok: true, detail: `${bucket} exists` };
  }

  const created = runWrangler(["r2", "bucket", "create", bucket], { capture: true });
  if (!created.ok) {
    return { name: "r2-bucket", ok: false, detail: clean(created.stderr || created.stdout) };
  }

  return { name: "r2-bucket", ok: true, detail: `${bucket} created` };
}

function ensureDomain(bucket, domain) {
  const existing = runWrangler(["r2", "bucket", "domain", "get", bucket, "--domain", domain], { capture: true });
  if (existing.ok) {
    return { name: "r2-domain", ok: true, detail: `${domain} already connected` };
  }

  const added = runWrangler(["r2", "bucket", "domain", "add", bucket, "--domain", domain], { capture: true });
  return {
    name: "r2-domain",
    ok: added.ok,
    detail: added.ok ? `${domain} connected` : clean(added.stderr || added.stdout)
  };
}

function uploadRobotsTxt(config) {
  const tempFiles = [];
  try {
    const robotsPath = createTempText("User-agent: *\nDisallow: /\n", tempFiles);
    putObject({
      bucket: config.bucket,
      key: "robots.txt",
      filePath: robotsPath,
      contentType: "text/plain; charset=utf-8",
      cacheControl: config.cache.html
    });
    return { name: "robots", ok: true, detail: "robots.txt uploaded" };
  } catch (error) {
    return { name: "robots", ok: false, detail: error.message };
  } finally {
    for (const filePath of tempFiles) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

async function runSmokeTest(config) {
  const token = createToken(12);
  const key = `${config.prefix}/_health/${token}.txt`;
  const body = `aart health ${token}\n`;
  const tempFiles = [];

  try {
    const healthPath = createTempText(body, tempFiles);
    putObject({
      bucket: config.bucket,
      key,
      filePath: healthPath,
      contentType: "text/plain; charset=utf-8",
      cacheControl: "public, max-age=30"
    });

    const url = joinUrl(config.publicBaseUrl, key);
    const response = await fetch(url, { cache: "no-store" });
    const text = await response.text();
    const ok = response.ok && text === body;

    runWrangler(["r2", "object", "delete", `${config.bucket}/${key}`, "--force"], { capture: true });

    return {
      name: "public-smoke",
      ok,
      detail: ok ? url : `Expected health body from ${url}; got HTTP ${response.status}.`
    };
  } catch (error) {
    return { name: "public-smoke", ok: false, detail: error.message };
  } finally {
    for (const filePath of tempFiles) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

function putObject({ bucket, key, filePath, contentType, cacheControl }) {
  const result = runWrangler([
    "r2",
    "object",
    "put",
    `${bucket}/${key}`,
    "--file",
    filePath,
    "--content-type",
    contentType,
    "--cache-control",
    cacheControl
  ], { capture: true });

  if (!result.ok) {
    throw new Error(`Failed to upload ${key}: ${clean(result.stderr || result.stdout)}`);
  }
}

function runWrangler(args, options = {}) {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(npx, ["--yes", "wrangler", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit"
  });

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function validateArtifact(artifactDir) {
  const errors = [];
  const warnings = [];
  const absoluteDir = path.resolve(artifactDir);

  if (!fs.existsSync(absoluteDir)) {
    errors.push(`Directory does not exist: ${absoluteDir}`);
    return { ok: false, artifactDir: absoluteDir, errors, warnings };
  }

  const stat = fs.statSync(absoluteDir);
  if (!stat.isDirectory()) {
    errors.push(`Artifact path is not a directory: ${absoluteDir}`);
    return { ok: false, artifactDir: absoluteDir, errors, warnings };
  }

  const indexPath = path.join(absoluteDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    errors.push("Artifact must include index.html at the artifact root.");
  } else {
    const html = fs.readFileSync(indexPath, "utf8");
    if (!/<meta\s+name=["']robots["']/i.test(html)) {
      warnings.push("index.html has no robots meta tag; publish will inject noindex,nofollow.");
    }
    if (/file:\/\//i.test(html)) {
      warnings.push("index.html references file:// URLs, which will not work after publishing.");
    }
    if (/localhost|127\.0\.0\.1/i.test(html)) {
      warnings.push("index.html references localhost, which will not work for remote reviewers.");
    }
  }

  const files = fs.existsSync(absoluteDir) && stat.isDirectory() ? listFiles(absoluteDir) : [];
  if (files.length === 0) {
    errors.push("Artifact directory is empty.");
  }

  for (const filePath of files) {
    const relativePath = path.relative(absoluteDir, filePath);
    if (relativePath.split(path.sep).some((part) => part.startsWith("."))) {
      warnings.push(`Skipping hidden-path safety review for ${relativePath}; hidden files are publishable but usually unintended.`);
    }
    const size = fs.statSync(filePath).size;
    if (size > 100 * 1024 * 1024) {
      warnings.push(`${relativePath} is larger than 100 MiB.`);
    }
  }

  return {
    ok: errors.length === 0,
    artifactDir: absoluteDir,
    fileCount: files.length,
    errors,
    warnings
  };
}

function formatValidationFailure(validation) {
  return [
    "Artifact validation failed.",
    ...validation.errors.map((error) => `- ${error}`),
    ...validation.warnings.map((warning) => `- Warning: ${warning}`)
  ].join("\n");
}

function loadConfig(startDir) {
  const configPath = findConfig(startDir);
  if (!configPath) {
    throw new Error(`No ${CONFIG_DIR}/${CONFIG_FILE} project publishing config found. Run: npx @bltgv/aart setup --bucket <bucket> --base-url <url>`);
  }
  return {
    configPath,
    config: normalizeConfig(readJson(configPath))
  };
}

function findConfig(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, CONFIG_DIR, CONFIG_FILE);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function normalizeConfig(input) {
  const config = {
    bucket: input.bucket,
    publicBaseUrl: input.publicBaseUrl,
    prefix: normalizePrefix(input.prefix ?? DEFAULT_PREFIX),
    tokenBytes: Number(input.tokenBytes ?? DEFAULT_TOKEN_BYTES),
    cache: {
      ...DEFAULT_CACHE,
      ...(input.cache ?? {})
    }
  };

  if (!config.bucket || typeof config.bucket !== "string") {
    throw new Error("AART config requires bucket.");
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) {
    throw new Error(`Invalid R2 bucket name: ${config.bucket}`);
  }
  if (!config.publicBaseUrl || typeof config.publicBaseUrl !== "string") {
    throw new Error("AART config requires publicBaseUrl.");
  }
  try {
    new URL(config.publicBaseUrl);
  } catch {
    throw new Error(`Invalid publicBaseUrl: ${config.publicBaseUrl}`);
  }
  if (!Number.isInteger(config.tokenBytes) || config.tokenBytes < 16) {
    throw new Error("tokenBytes must be an integer >= 16.");
  }

  return config;
}

function normalizePrefix(prefix) {
  return String(prefix)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim() || DEFAULT_PREFIX;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }

    const withoutPrefix = arg.replace(/^--?/, "");
    const [rawKey, inlineValue] = withoutPrefix.split("=", 2);
    const value = inlineValue ?? (argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : true);
    flags[rawKey] = value;
  }

  return { positional, flags };
}

function output(flags, jsonValue, text) {
  if (flags.json) {
    console.log(JSON.stringify(jsonValue, null, 2));
    return;
  }
  console.log(text);
}

function createToken(bytes = DEFAULT_TOKEN_BYTES) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function validateToken(token) {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error("Share token must be an unguessable base64url string of at least 20 characters.");
  }
}

function tokenFromTarget(target, prefix) {
  try {
    const url = new URL(target);
    const parts = url.pathname.split("/").filter(Boolean);
    const prefixIndex = parts.indexOf(prefix);
    if (prefixIndex >= 0 && parts[prefixIndex + 1]) {
      return parts[prefixIndex + 1];
    }
  } catch {
    // Not a URL; treat as token.
  }

  return target;
}

function listFiles(rootDir) {
  const results = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".DS_Store") {
      continue;
    }

    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results.sort();
}

function createTempHtml(filePath, tempFiles) {
  const html = fs.readFileSync(filePath, "utf8");
  return createTempText(injectNoindex(html), tempFiles, ".html");
}

function createTempJson(value, tempFiles) {
  return createTempText(`${JSON.stringify(value, null, 2)}\n`, tempFiles, ".json");
}

function createTempText(text, tempFiles, extension = ".txt") {
  const filePath = path.join(os.tmpdir(), `aart-${process.pid}-${Date.now()}-${crypto.randomUUID()}${extension}`);
  fs.writeFileSync(filePath, text);
  tempFiles.push(filePath);
  return filePath;
}

function injectNoindex(html) {
  if (/<meta\s+name=["']robots["']/i.test(html)) {
    return html;
  }

  const meta = '<meta name="robots" content="noindex,nofollow">';
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n    ${meta}`);
  }

  return `<!doctype html>\n<html><head>${meta}</head><body>\n${html}\n</body></html>\n`;
}

function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

function toObjectPath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function joinUrl(baseUrl, objectPath) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(objectPath, base).toString();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function clean(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function printHelp() {
  console.log(`AART: publish agent-authored HTML artifacts to unguessable R2 URLs.

One project can publish many independent artifact directories. Each publish
creates its own unguessable share token and URL. ${CONFIG_DIR}/${CONFIG_FILE}
stores project publishing configuration only, not artifact state.

Usage:
  aart setup --bucket <bucket> --base-url <url> [--domain <domain>]
  aart doctor [--json] [--skip-smoke]
  aart validate <artifact-dir> [--json]
  aart publish <artifact-dir> [--json] [--token <token>]
  aart revoke <share-url-or-token> [--json]

Examples:
  npx @bltgv/aart setup --bucket aart --base-url https://aart.example.com
  npx @bltgv/aart doctor
  npx @bltgv/aart publish ./artifact
`);
}

export const internals = {
  createToken,
  injectNoindex,
  joinUrl,
  normalizeConfig,
  tokenFromTarget,
  validateArtifact
};
