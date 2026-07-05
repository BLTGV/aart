import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = ".aart";
const CONFIG_FILE = "config.json";
const SHARE_HISTORY_FILE = "shares.json";
const NPX_RUNNER = "npx github:BLTGV/aart";
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

  const useUserConfig = Boolean(flags.user || flags.global);
  const targetConfigPath = useUserConfig ? getUserConfigPath() : path.join(process.cwd(), CONFIG_DIR, CONFIG_FILE);
  const existingTargetConfig = fs.existsSync(targetConfigPath) ? readJson(targetConfigPath) : {};
  const existingUserConfig = useUserConfig ? {} : readOptionalJson(getUserConfigPath());
  const baseConfig = mergeConfigInputs(existingUserConfig, existingTargetConfig);
  const config = normalizeConfig({
    ...baseConfig,
    bucket: flags.bucket ?? flags.b ?? baseConfig.bucket,
    publicBaseUrl: flags["base-url"] ?? flags.url ?? baseConfig.publicBaseUrl,
    prefix: flags.prefix ?? baseConfig.prefix ?? DEFAULT_PREFIX,
    tokenBytes: flags["token-bytes"] ? Number(flags["token-bytes"]) : baseConfig.tokenBytes ?? DEFAULT_TOKEN_BYTES
  });

  ensureDir(path.dirname(targetConfigPath));
  writeJson(targetConfigPath, config);

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
    configPath: targetConfigPath,
    scope: useUserConfig ? "user" : "project",
    config,
    steps
  }, useUserConfig
    ? `AART user publishing configured at ${targetConfigPath}. Local project config can override it.`
    : `AART project publishing configured at ${targetConfigPath}. This project config can publish many independent artifacts.`);
}

async function doctor(argv) {
  const { flags } = parseArgs(argv);
  const checks = [];
  let config = null;
  let configPath = null;
  let configSource = null;
  let projectConfigPath = null;
  let userConfigPath = null;

  checks.push(checkNodeVersion());
  checks.push(checkWranglerVersion());
  checks.push(checkWranglerAuth());

  try {
    ({ config, configPath, configSource, projectConfigPath, userConfigPath } = loadConfig(process.cwd()));
    checks.push({ name: "config", ok: true, detail: describeConfigSource({ configSource, projectConfigPath, userConfigPath }) });
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
    configSource,
    projectConfigPath,
    userConfigPath,
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
    throw new Error("Usage: aart publish <artifact-dir> [--json] [--token <token>] [--save]");
  }

  const { config, projectRoot } = loadConfig(process.cwd());
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
      const isHtml = path.extname(filePath).toLowerCase() === ".html";
      const uploadPath = isHtml ? createTempHtml(filePath, tempFiles) : filePath;
      const cacheControl = isHtml ? config.cache.html : config.cache.assets;

      for (const key of objectKeysForFile(config, token, relativePath)) {
        putObject({
          bucket: config.bucket,
          key,
          filePath: uploadPath,
          contentType: contentTypeFor(filePath),
          cacheControl
        });

        uploaded.push({ key, source: relativePath, contentType: contentTypeFor(filePath) });
      }
    }

    const url = shareUrlFor(config, token);
    const publishedAt = new Date().toISOString();
    const manifest = {
      version: 1,
      token,
      url,
      publishedAt,
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
      publishedAt,
      bucket: config.bucket,
      prefix: `${config.prefix}/${token}`,
      files: [...uploaded.map((file) => file.key), manifestKey]
    };

    if (flags.save) {
      result.savedTo = saveShareRecord({
        projectRoot,
        artifactDir,
        record: {
          url,
          token,
          publishedAt,
          bucket: config.bucket,
          prefix: `${config.prefix}/${token}`,
          manifestKey
        }
      });
    }

    output(flags, result, result.savedTo ? `${url}\nSaved share record to ${result.savedTo}` : url);
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

  const get = runWrangler(r2ObjectArgs("get", `${config.bucket}/${manifestKey}`, ["--file", tempPath]), {
    capture: true
  });

  if (!get.ok) {
    throw new Error(`Could not fetch manifest for ${token}. Revoke needs ${manifestKey} to know which objects to delete.`);
  }

  const manifest = readJson(tempPath);
  fs.rmSync(tempPath, { force: true });

  const keys = Array.from(new Set([...(manifest.files ?? []), manifestKey]));
  for (const key of keys) {
    runWrangler(r2ObjectArgs("delete", `${config.bucket}/${key}`, ["--force"]), { capture: true });
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

    runWrangler(r2ObjectArgs("delete", `${config.bucket}/${key}`, ["--force"]), { capture: true });

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
  const result = runWrangler(r2ObjectArgs("put", `${bucket}/${key}`, [
    "--file",
    filePath,
    "--content-type",
    contentType,
    "--cache-control",
    cacheControl
  ]), { capture: true });

  if (!result.ok) {
    throw new Error(`Failed to upload ${key}: ${clean(result.stderr || result.stdout)}`);
  }
}

function r2ObjectArgs(command, objectPath, extraArgs = []) {
  return ["r2", "object", command, objectPath, "--remote", ...extraArgs];
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

function objectKeysForFile(config, token, relativePath) {
  const prefix = `${config.prefix}/${token}`;
  const primaryKey = `${prefix}/${relativePath}`;
  if (relativePath === "index.html") {
    return [primaryKey, `${prefix}/`];
  }
  return [primaryKey];
}

function shareUrlFor(config, token) {
  return joinUrl(config.publicBaseUrl, `${config.prefix}/${token}/`);
}

function saveShareRecord({ configPath, projectRoot, artifactDir, record }) {
  const root = projectRoot ?? path.dirname(path.dirname(configPath));
  const historyPath = path.join(root, CONFIG_DIR, SHARE_HISTORY_FILE);
  const history = readShareHistory(historyPath);
  const artifactRelativePath = toObjectPath(path.relative(root, path.resolve(artifactDir))) || ".";

  history.shares.push({
    ...record,
    artifactDir: artifactRelativePath
  });

  writeJson(historyPath, history);
  return historyPath;
}

function readShareHistory(historyPath) {
  if (!fs.existsSync(historyPath)) {
    return { version: 1, shares: [] };
  }

  const history = readJson(historyPath);
  if (Array.isArray(history)) {
    return { version: 1, shares: history };
  }
  if (history && history.version === 1 && Array.isArray(history.shares)) {
    return history;
  }

  throw new Error(`${historyPath} must contain an object with version: 1 and a shares array.`);
}

function formatValidationFailure(validation) {
  return [
    "Artifact validation failed.",
    ...validation.errors.map((error) => `- ${error}`),
    ...validation.warnings.map((warning) => `- Warning: ${warning}`)
  ].join("\n");
}

function loadConfig(startDir) {
  const projectConfigPath = findProjectConfig(startDir);
  const userConfigPath = getUserConfigPath();
  const projectConfig = readOptionalJson(projectConfigPath);
  const userConfig = readOptionalJson(userConfigPath);

  if (!projectConfig && !userConfig) {
    throw new Error(`No AART publishing config found. Run: ${NPX_RUNNER} setup --bucket <bucket> --base-url <url>, or ${NPX_RUNNER} setup --user --bucket <bucket> --base-url <url> for user defaults.`);
  }

  const configSource = projectConfig && userConfig ? "project+user" : projectConfig ? "project" : "user";
  const configPath = projectConfigPath ?? userConfigPath;
  return {
    configPath,
    projectConfigPath,
    userConfigPath: userConfig ? userConfigPath : null,
    configSource,
    projectRoot: resolveProjectRoot(startDir, projectConfigPath),
    config: normalizeConfig(mergeConfigInputs(userConfig, projectConfig))
  };
}

function findProjectConfig(startDir) {
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

function getUserConfigPath(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME && String(env.XDG_CONFIG_HOME).trim()
    ? env.XDG_CONFIG_HOME
    : path.join(os.homedir(), ".config");
  return path.join(configHome, "aart", CONFIG_FILE);
}

function resolveProjectRoot(startDir, projectConfigPath) {
  if (projectConfigPath) {
    return path.dirname(path.dirname(projectConfigPath));
  }
  return findGitRoot(startDir) ?? path.resolve(startDir);
}

function findGitRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function mergeConfigInputs(baseConfig = {}, overrideConfig = {}) {
  const base = baseConfig ?? {};
  const override = overrideConfig ?? {};
  return {
    ...base,
    ...override,
    cache: {
      ...(base.cache ?? {}),
      ...(override.cache ?? {})
    }
  };
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

function readOptionalJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return readJson(filePath);
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function clean(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function describeConfigSource({ configSource, projectConfigPath, userConfigPath }) {
  if (configSource === "project+user") {
    return `project ${projectConfigPath} overriding user ${userConfigPath}`;
  }
  if (configSource === "project") {
    return `project ${projectConfigPath}`;
  }
  return `user ${userConfigPath}`;
}

function printHelp() {
  console.log(`AART: publish agent-authored HTML artifacts to unguessable R2 URLs.

One project can publish many independent artifact directories. Each publish
creates its own unguessable share token and URL. ${CONFIG_DIR}/${CONFIG_FILE}
stores project publishing configuration only, not artifact state.
Use setup --user to write user defaults to ${getUserConfigPath()}; project
config overrides user config field by field.

Usage:
  aart setup --bucket <bucket> --base-url <url> [--domain <domain>] [--user]
  aart doctor [--json] [--skip-smoke]
  aart validate <artifact-dir> [--json]
  aart publish <artifact-dir> [--json] [--token <token>] [--save]
  aart revoke <share-url-or-token> [--json]

Examples:
  ${NPX_RUNNER} setup --bucket aart --base-url https://aart.example.com
  ${NPX_RUNNER} setup --user --bucket aart --base-url https://aart.example.com
  ${NPX_RUNNER} doctor
  ${NPX_RUNNER} publish ./artifact
`);
}

export const internals = {
  createToken,
  getUserConfigPath,
  injectNoindex,
  joinUrl,
  loadConfig,
  normalizeConfig,
  objectKeysForFile,
  r2ObjectArgs,
  saveShareRecord,
  shareUrlFor,
  tokenFromTarget,
  validateArtifact
};
