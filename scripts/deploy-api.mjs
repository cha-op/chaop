#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const sourceConfigPath = path.join(repoRoot, "apps/worker/wrangler.jsonc");
const tempDir = path.join(repoRoot, ".codex-tmp/deploy/api");
const configPath = path.join(tempDir, "wrangler.jsonc");

const env = {
  ...process.env,
  ...(await readOptionalEnvFile(process.env.CHAOP_DEPLOY_ENV_FILE)),
  ...(await readOptionalEnvFile(process.env.CHAOP_DEPLOY_SECRET_ENV_FILE)),
  ...process.env
};

for (const key of [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CHAOP_API_DOMAIN",
  "CHAOP_GUI_DOMAIN",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
  "CHAOP_D1_DATABASE",
  "CHAOP_D1_DATABASE_ID",
  "CHAOP_R2_BUCKET"
]) {
  requireEnv(key);
}

const sourceConfig = JSON.parse(await readFile(sourceConfigPath, "utf8"));
const workerName = env.CHAOP_API_WORKER ?? sourceConfig.name ?? "chaop-api";
const config = {
  ...sourceConfig,
  $schema: path.join(repoRoot, "apps/worker/node_modules/wrangler/config-schema.json"),
  name: workerName,
  main: path.join(repoRoot, "apps/worker/src/index.ts"),
  vars: {
    ...sourceConfig.vars,
    CHAOP_DEV_ALLOW_INSECURE: "false",
    CHAOP_API_DOMAIN: env.CHAOP_API_DOMAIN,
    CHAOP_GUI_DOMAIN: env.CHAOP_GUI_DOMAIN,
    ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: env.ACCESS_AUD
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: env.CHAOP_D1_DATABASE,
      database_id: env.CHAOP_D1_DATABASE_ID,
      migrations_dir: path.join(repoRoot, "migrations/d1")
    }
  ],
  r2_buckets: [
    {
      binding: "ARTIFACTS",
      bucket_name: env.CHAOP_R2_BUCKET
    }
  ]
};

for (const key of [
  "CHAOP_DAILY_BUDGET_UNITS",
  "CHAOP_4H_SOFT_BUDGET_UNITS",
  "CHAOP_4H_HARD_BUDGET_UNITS",
  "CHAOP_BURST_EVENTS_PER_MINUTE",
  "CF_TELEMETRY_TIMEOUT_MS",
  "CF_TELEMETRY_CACHE_SECONDS"
]) {
  if (env[key]) {
    config.vars[key] = env[key];
  }
}

config.vars.CF_TELEMETRY_ACCOUNT_ID = env.CF_TELEMETRY_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID;
config.vars.CF_TELEMETRY_API_WORKER = env.CF_TELEMETRY_API_WORKER ?? workerName;
config.vars.CF_TELEMETRY_D1_DATABASE_ID = env.CF_TELEMETRY_D1_DATABASE_ID ?? env.CHAOP_D1_DATABASE_ID;
if (env.CF_TELEMETRY_WEB_WORKER) {
  config.vars.CF_TELEMETRY_WEB_WORKER = env.CF_TELEMETRY_WEB_WORKER;
}
if (env.CF_TELEMETRY_DO_NAMESPACE_NAME) {
  config.vars.CF_TELEMETRY_DO_NAMESPACE_NAME = env.CF_TELEMETRY_DO_NAMESPACE_NAME;
}

await mkdir(tempDir, { recursive: true });
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

await run("pnpm", ["--filter", "@chaop/worker", "build"]);

await run("pnpm", [
  "--filter",
  "@chaop/worker",
  "exec",
  "wrangler",
  "d1",
  "migrations",
  "apply",
  env.CHAOP_D1_DATABASE,
  "--config",
  configPath,
  "--remote"
]);

await run("pnpm", [
  "--filter",
  "@chaop/worker",
  "exec",
  "wrangler",
  "deploy",
  "--config",
  configPath
]);

async function readOptionalEnvFile(filePath) {
  if (!filePath) return {};
  return parseEnv(await readFile(filePath, "utf8"));
}

function parseEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        if (index === -1) {
          throw new Error(`Invalid env line: ${line}`);
        }
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim();
        return [key, unquote(value)];
      })
  );
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function requireEnv(key) {
  if (!env[key]) {
    console.error(`${key} is required. Set it in the environment or a CHAOP_DEPLOY_ENV_FILE.`);
    process.exit(1);
  }
}

async function run(command, args) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: repoRoot,
    env,
    maxBuffer: 1024 * 1024 * 8
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}
