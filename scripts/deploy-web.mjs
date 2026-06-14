#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const webDist = path.join(repoRoot, "apps/web/dist");
const tempDir = path.join(repoRoot, ".codex-tmp/deploy/web");
const configPath = path.join(tempDir, "wrangler-web.jsonc");

const apiBaseUrl = process.env.VITE_CHAOP_API_BASE_URL;
if (!apiBaseUrl) {
  console.error("VITE_CHAOP_API_BASE_URL is required, for example https://api.example.com");
  process.exit(1);
}

const workerName = process.env.CHAOP_WEB_WORKER_NAME ?? "chaop-web";
const compatibilityDate = process.env.CHAOP_WEB_COMPATIBILITY_DATE ?? "2026-06-09";

await mkdir(tempDir, { recursive: true });
await writeFile(
  configPath,
  `${JSON.stringify(
    {
      name: workerName,
      compatibility_date: compatibilityDate,
      workers_dev: false,
      preview_urls: false,
      assets: {
        directory: webDist,
        not_found_handling: "single-page-application"
      }
    },
    null,
    2
  )}\n`,
  { mode: 0o600 }
);

await run("pnpm", ["--filter", "@chaop/web", "build"], {
  VITE_CHAOP_API_BASE_URL: apiBaseUrl
});
await run("pnpm", ["--filter", "@chaop/worker", "exec", "wrangler", "deploy", "--config", configPath], {});

async function run(command, args, extraEnv) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...extraEnv
    },
    maxBuffer: 1024 * 1024 * 8
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}
