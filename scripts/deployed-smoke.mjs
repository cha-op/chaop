#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_BROWSER_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BOTTLENECK_USED_PCT = 90;
const DEFAULT_MAX_D1_ROWS_WRITTEN_USED_PCT = 80;

export class SmokeError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "SmokeError";
    this.details = details;
  }
}

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseArgs(argv) {
  const options = {
    json: false,
    skipBrowser: false,
    allowMissingTelemetry: false,
    maxBottleneckUsedPct: DEFAULT_MAX_BOTTLENECK_USED_PCT,
    maxD1RowsWrittenUsedPct: DEFAULT_MAX_D1_ROWS_WRITTEN_USED_PCT,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--") {
      continue;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--skip-browser") {
      options.skipBrowser = true;
    } else if (arg === "--allow-missing-telemetry") {
      options.allowMissingTelemetry = true;
    } else if (arg === "--max-bottleneck-used-pct") {
      options.maxBottleneckUsedPct = parsePercentageArg(arg, argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--max-bottleneck-used-pct=")) {
      options.maxBottleneckUsedPct = parsePercentageArg(
        "--max-bottleneck-used-pct",
        arg.slice("--max-bottleneck-used-pct=".length),
      );
    } else if (arg === "--max-d1-rows-written-used-pct") {
      options.maxD1RowsWrittenUsedPct = parsePercentageArg(arg, argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--max-d1-rows-written-used-pct=")) {
      options.maxD1RowsWrittenUsedPct = parsePercentageArg(
        "--max-d1-rows-written-used-pct",
        arg.slice("--max-d1-rows-written-used-pct=".length),
      );
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parsePercentageArg(name, value) {
  if (value === undefined || value.startsWith("-")) {
    throw new UsageError(`${name} requires a percentage value.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new UsageError(`${name} must be between 0 and 100.`);
  }
  return parsed;
}

export function usage() {
  return `Usage:
  pnpm smoke:deployed
  pnpm smoke:deployed -- --json
  pnpm smoke:deployed -- --skip-browser

Required environment:
  CHAOP_GUI_DOMAIN or CHAOP_GUI_URL
  VITE_CHAOP_API_BASE_URL
  CF_ACCESS_CLIENT_ID
  CF_ACCESS_CLIENT_SECRET

Options:
      --json                                  Print machine-readable JSON only.
      --skip-browser                          Skip Playwright browser verification.
      --allow-missing-telemetry               Treat missing Cloudflare telemetry as a warning.
      --max-bottleneck-used-pct <0-100>       Default: ${DEFAULT_MAX_BOTTLENECK_USED_PCT}.
      --max-d1-rows-written-used-pct <0-100>  Default: ${DEFAULT_MAX_D1_ROWS_WRITTEN_USED_PCT}.
  -h, --help                                  Show this help.
`;
}

export function readConfig(env) {
  const guiUrl = normaliseOriginUrl(env.CHAOP_GUI_URL ?? env.CHAOP_GUI_DOMAIN, "CHAOP_GUI_DOMAIN");
  const apiBaseUrl = normaliseOriginUrl(env.VITE_CHAOP_API_BASE_URL, "VITE_CHAOP_API_BASE_URL");
  const accessClientId = requiredEnv(env, "CF_ACCESS_CLIENT_ID");
  const accessClientSecret = requiredEnv(env, "CF_ACCESS_CLIENT_SECRET");
  const browserTimeoutMs = env.CHAOP_SMOKE_BROWSER_TIMEOUT_MS
    ? parsePositiveInteger(env.CHAOP_SMOKE_BROWSER_TIMEOUT_MS, "CHAOP_SMOKE_BROWSER_TIMEOUT_MS")
    : DEFAULT_BROWSER_TIMEOUT_MS;

  return {
    guiUrl,
    apiBaseUrl,
    accessHeaders: {
      "CF-Access-Client-Id": accessClientId,
      "CF-Access-Client-Secret": accessClientSecret,
    },
    browserTimeoutMs,
  };
}

function requiredEnv(env, key) {
  const value = env[key];
  if (!value) throw new UsageError(`${key} is required.`);
  return value;
}

function normaliseOriginUrl(value, key) {
  if (!value) throw new UsageError(`${key} is required.`);
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:") {
    throw new UsageError(`${key} must use https:// for deployed smoke.`);
  }
  url.pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function parsePositiveInteger(value, key) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${key} must be a positive integer.`);
  }
  return parsed;
}

export async function runDeployedSmoke({
  config,
  options,
  fetchImpl = globalThis.fetch,
  browserLauncher,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new SmokeError("global fetch is unavailable; use Node 18 or newer.");
  }
  const startedAt = new Date().toISOString();
  const directApiResult = await runDirectApiSmoke({ config, fetchImpl });
  const { usagePayload, ...directApi } = directApiResult;
  const budget = analyseBudget(usagePayload, options);
  if (!budget.ok) {
    throw new SmokeError("Budget gate failed.", {
      ok: false,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      direct: directApi,
      budget,
    });
  }
  const directAssets = await runDirectAssetSmoke({ config, fetchImpl });
  const direct = { ...directApi, ...directAssets };
  let browser = undefined;
  if (!options.skipBrowser) {
    browser = await runBrowserSmoke({ config, fetchImpl, browserLauncher });
  }

  const result = {
    ok: budget.ok,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    direct,
    browser,
    budget,
  };
  return result;
}

async function runDirectApiSmoke({ config, fetchImpl }) {
  const origin = config.guiUrl;
  const authHeaders = config.accessHeaders;
  const apiHeaders = { ...authHeaders, Origin: origin };

  const health = await fetchJson(fetchImpl, `${config.apiBaseUrl}/api/health`, {
    headers: authHeaders,
  }, config.browserTimeoutMs);
  assertStatus("API health", health.status, 200);
  assertEqual("API health ok", health.body?.ok, true);
  assertEqual("API health service", health.body?.service, "chaop-api");

  const bootstrap = await fetchJson(fetchImpl, `${config.apiBaseUrl}/api/bootstrap`, {
    headers: apiHeaders,
  }, config.browserTimeoutMs);
  assertStatus("API bootstrap", bootstrap.status, 200);
  assertBootstrapPayload("API bootstrap", bootstrap.body);

  const usage = await fetchJson(fetchImpl, `${config.apiBaseUrl}/api/usage-summary`, {
    headers: apiHeaders,
  }, config.browserTimeoutMs);
  assertStatus("API usage summary", usage.status, 200);

  return {
    health: health.status,
    bootstrap: bootstrap.status,
    usage: usage.status,
    workspace_count: bootstrap.body.workspaces.length,
    usagePayload: usage.body,
  };
}

async function runDirectAssetSmoke({ config, fetchImpl }) {
  const authHeaders = config.accessHeaders;
  const index = await fetchText(fetchImpl, config.guiUrl, { headers: authHeaders }, config.browserTimeoutMs);
  assertStatus("GUI index", index.status, 200);
  if (index.body.length === 0) {
    throw new SmokeError("GUI index returned an empty body.");
  }

  const assetUrls = extractAssetUrls(index.body, config.guiUrl);
  if (assetUrls.length === 0) {
    throw new SmokeError("GUI index did not reference any JavaScript or CSS assets.");
  }
  const assets = [];
  for (const url of assetUrls) {
    const asset = await fetchText(fetchImpl, url, { headers: authHeaders }, config.browserTimeoutMs);
    const assetPath = redactOrigin(url);
    if (asset.status < 200 || asset.status >= 300) {
      throw new SmokeError(`Asset request failed: ${assetPath}`, { status: asset.status });
    }
    if (!assetContentTypeMatches(url, asset.contentType)) {
      throw new SmokeError(`Asset returned an unexpected content type: ${assetPath}`, {
        content_type: asset.contentType || "missing",
      });
    }
    if (asset.body.length === 0) {
      throw new SmokeError(`Asset returned an empty body: ${assetPath}`);
    }
    assets.push({ url: assetPath, status: asset.status, bytes: asset.body.length, content_type: asset.contentType });
  }

  return {
    asset_count: assets.length,
    assets,
  };
}

export function extractAssetUrls(html, baseUrl) {
  const urls = new Set();
  const base = new URL(baseUrl);
  const pattern = /\b(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const url = new URL(match[1], baseUrl);
    if (url.origin !== base.origin) continue;
    urls.add(url.toString());
  }
  return [...urls];
}

async function runBrowserSmoke({ config, fetchImpl, browserLauncher }) {
  const launcher = browserLauncher ?? (await loadPlaywrightChromium());
  const cookies = await accessCookies({ config, fetchImpl });
  const failedResponses = [];
  const appBootstrapUrls = [];
  let resolveAppBootstrapResponse = () => {};
  const appBootstrapResponse = new Promise((resolve) => {
    resolveAppBootstrapResponse = resolve;
  });
  let browser;
  try {
    browser = await launcher.launch({ headless: true });
  } catch (error) {
    throw new SmokeError("Could not launch Playwright Chromium. Run `pnpm exec playwright install chromium`.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    page.on("response", (response) => {
      const status = response.status();
      const url = response.url();
      if (isBootstrapApiUrl(url)) {
        appBootstrapUrls.push(url);
        resolveAppBootstrapResponse();
      }
      if (status >= 400 && !isOptionalBrowserFailure(url)) {
        failedResponses.push({ status, url: redactOrigin(url) });
      }
    });
    try {
      await page.goto(config.guiUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.browserTimeoutMs,
      });
    } catch (error) {
      throw new SmokeError("Browser navigation failed for the GUI origin.", {
        cause: error instanceof Error ? error.name : "navigation error",
      });
    }
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText ?? "";
        return (
          text.includes("Operations Map") &&
          text.includes("Budget Board") &&
          text.includes("Host Sessions")
        );
      },
      undefined,
      { timeout: config.browserTimeoutMs },
    );
    const title = await page.title();
    if (title !== "Chaop Control Plane") {
      throw new SmokeError(`Unexpected browser title: ${title}`);
    }
    await waitForBrowserAppBootstrap(appBootstrapUrls, appBootstrapResponse, config.browserTimeoutMs);
    const observedAppBootstrapUrls = [...appBootstrapUrls];
    const bootstrap = await page.evaluate(async ({ apiBaseUrl, timeoutMs }) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
      let response;
      let contentType = "";
      let body;
      try {
        response = await fetch(`${apiBaseUrl}/api/bootstrap`, {
          credentials: "include",
          signal: controller.signal,
        });
        contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          try {
            body = await response.json();
          } catch {
            if (controller.signal.aborted) {
              return { status: 0, contentType: "", hasWorkspaces: false, timedOut: true };
            }
            body = undefined;
          }
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return { status: 0, contentType: "", hasWorkspaces: false, timedOut: true };
        }
        throw error;
      } finally {
        window.clearTimeout(timeout);
      }
      return {
        status: response.status,
        contentType,
        hasWorkspaces: Array.isArray(body?.workspaces),
        timedOut: false,
      };
    }, { apiBaseUrl: config.apiBaseUrl, timeoutMs: config.browserTimeoutMs });
    if (bootstrap.timedOut) {
      throw new SmokeError("Browser bootstrap request timed out.", { timeout_ms: config.browserTimeoutMs });
    }
    if (bootstrap.status !== 200) {
      throw new SmokeError(`Browser bootstrap request returned ${bootstrap.status}.`);
    }
    if (!bootstrap.contentType.includes("application/json") || !bootstrap.hasWorkspaces) {
      throw new SmokeError("Browser bootstrap request did not return the expected API JSON.");
    }
    assertBrowserAppBootstrapOrigin(observedAppBootstrapUrls, config.apiBaseUrl);
    if (failedResponses.length > 0) {
      throw new SmokeError("Browser observed failed deployed responses.", { failedResponses });
    }
    await context.close();
    return { title, bootstrapStatus: bootstrap.status, failedResponses };
  } finally {
    await browser.close();
  }
}

async function loadPlaywrightChromium() {
  try {
    const { chromium } = await import("playwright");
    return chromium;
  } catch (error) {
    throw new SmokeError(
      "Playwright is required for browser smoke. Run `pnpm install` first, or pass --skip-browser.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

async function accessCookies({ config, fetchImpl }) {
  const [guiCookies, apiCookies] = await Promise.all([
    exchangeAccessCookies(fetchImpl, config.guiUrl, config.accessHeaders, config.browserTimeoutMs),
    exchangeAccessCookies(fetchImpl, `${config.apiBaseUrl}/api/health`, config.accessHeaders, config.browserTimeoutMs),
  ]);
  return [...guiCookies, ...apiCookies];
}

async function exchangeAccessCookies(fetchImpl, url, headers, timeoutMs) {
  const response = await fetchWithinTimeout(fetchImpl, url, { headers }, timeoutMs, async (incoming) => incoming);
  if (response.status < 200 || response.status >= 400) {
    throw new SmokeError(`Access cookie exchange failed for ${redactOrigin(url)}.`, {
      status: response.status,
    });
  }
  const cookies = cfAccessCookies(response.headers, new URL(url).hostname);
  if (!cookies.some((cookie) => cookie.name === "CF_Authorization")) {
    throw new SmokeError(`Access cookie exchange did not return CF_Authorization for ${redactOrigin(url)}.`);
  }
  return cookies;
}

export function cfAuthorizationCookie(headers, hostname) {
  return cfAccessCookies(headers, hostname).find((cookie) => cookie.name === "CF_Authorization");
}

export function cfAccessCookies(headers, hostname) {
  const setCookies = getSetCookieHeaders(headers);
  const cookies = [];
  for (const header of setCookies) {
    const match = /^(CF_Authorization|CF_Binding)=([^;]+)/.exec(header);
    if (match) {
      cookies.push({
        name: match[1],
        value: match[2],
        domain: hostname,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "None",
      });
    }
  }
  return cookies;
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie().flatMap(splitCombinedSetCookie);
  }
  const value = headers.get?.("set-cookie");
  if (!value) return [];
  return splitCombinedSetCookie(value);
}

export function splitCombinedSetCookie(value) {
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]+)/).map((part) => part.trim());
}

async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const { response, text } = await fetchWithinTimeout(fetchImpl, url, init, timeoutMs, async (incoming) => ({
    response: incoming,
    text: await incoming.text(),
  }));
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch (error) {
    throw new SmokeError(`Expected JSON from ${redactOrigin(url)}.`, {
      status: response.status,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SmokeError(`Request failed: ${redactOrigin(url)}`, { status: response.status, body });
  }
  return { status: response.status, body };
}

async function fetchText(fetchImpl, url, init, timeoutMs) {
  const { response, body } = await fetchWithinTimeout(fetchImpl, url, init, timeoutMs, async (incoming) => ({
    response: incoming,
    body: await incoming.text(),
  }));
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status < 200 || response.status >= 300) {
    throw new SmokeError(`Request failed: ${redactOrigin(url)}`, { status: response.status });
  }
  return { status: response.status, body, contentType };
}

async function fetchWithinTimeout(fetchImpl, url, init, timeoutMs, readResponse) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...noRedirect(init), signal: controller.signal });
    return await readResponse(response);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new SmokeError(`Request timed out: ${redactOrigin(url)}`, { timeout_ms: timeoutMs });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function noRedirect(init = {}) {
  return { ...init, redirect: "manual" };
}

function assetContentTypeMatches(url, contentType) {
  const pathname = new URL(url).pathname.toLowerCase();
  const normalised = contentType.toLowerCase().split(";")[0].trim();
  if (pathname.endsWith(".css")) return normalised === "text/css";
  if (pathname.endsWith(".js")) return normalised.includes("javascript") || normalised.includes("ecmascript");
  return false;
}

function assertStatus(label, actual, expected) {
  if (actual !== expected) {
    throw new SmokeError(`${label} returned ${actual}; expected ${expected}.`);
  }
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new SmokeError(`${label} was ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`);
  }
}

function assertBootstrapPayload(label, body) {
  if (!Array.isArray(body?.workspaces)) {
    throw new SmokeError(`${label} did not return the expected API JSON.`);
  }
}

function isOptionalBrowserFailure(value) {
  try {
    const url = new URL(value);
    return url.pathname === "/favicon.ico";
  } catch {
    return false;
  }
}

function isBootstrapApiUrl(value) {
  try {
    const url = new URL(value);
    return url.pathname === "/api/bootstrap";
  } catch {
    return false;
  }
}

function assertBrowserAppBootstrapOrigin(urls, expectedApiBaseUrl) {
  const expectedOrigin = new URL(expectedApiBaseUrl).origin;
  if (urls.length === 0) {
    throw new SmokeError("Browser app did not request bootstrap before the browser smoke timeout.");
  }
  if (!urls.every((value) => new URL(value).origin === expectedOrigin)) {
    throw new SmokeError("Browser app bootstrap used an unexpected API origin.", {
      expected: redactOrigin(`${expectedApiBaseUrl}/api/bootstrap`),
      observed: urls.map(redactOrigin),
    });
  }
}

async function waitForBrowserAppBootstrap(urls, appBootstrapResponse, timeoutMs) {
  if (urls.length > 0) return;
  let timeout;
  try {
    const observed = await Promise.race([
      appBootstrapResponse.then(() => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (!observed && urls.length === 0) {
      throw new SmokeError("Browser app did not request bootstrap before the browser smoke timeout.", {
        timeout_ms: timeoutMs,
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function analyseBudget(payload, options = {}) {
  const budget = unwrapBudgetPayload(payload);
  const failures = [];
  const warnings = [];
  const constraints = Array.isArray(budget?.constraints) ? budget.constraints : [];
  const sampledHardConstraints = constraints.filter(
    (constraint) => constraint.hard && constraint.sampled && constraint.state !== "missing",
  );
  const sampledCloudflareConstraints = sampledHardConstraints.filter(
    (constraint) => constraint.source === "cloudflare_analytics",
  );
  const bottleneck = budget?.bottleneck_constraint ?? chooseBottleneck(sampledHardConstraints);
  const measuredD1RowsWritten = findMeasuredD1RowsWrittenSignal(budget);
  const dailyD1RowsWritten = findDailyD1RowsWrittenConstraint(constraints);

  if (!budget || typeof budget !== "object") {
    failures.push("Usage summary did not contain a budget object.");
  }
  if (budget?.state === "hard_limited") {
    failures.push("Budget posture is hard_limited.");
  } else if (budget?.state === "throttled") {
    failures.push("Budget posture is throttled.");
  }

  if (sampledHardConstraints.length === 0) {
    failures.push("No sampled hard budget constraints are available.");
  }
  if (!bottleneck || !bottleneck.sampled || bottleneck.state === "missing") {
    failures.push("No sampled hard budget bottleneck is available.");
  }

  if (sampledCloudflareConstraints.length === 0) {
    const message = "No sampled Cloudflare telemetry hard budget constraints are available.";
    if (options.allowMissingTelemetry) {
      warnings.push(message);
    } else {
      failures.push(message);
    }
  }
  if (!measuredD1RowsWritten) {
    const message = "Measured current-day D1 rows-written activity is missing.";
    if (options.allowMissingTelemetry) {
      warnings.push(message);
    } else {
      failures.push(message);
    }
  }

  if (typeof budget?.d1_write_model?.budgeted_rows_written_per_event !== "number") {
    failures.push("D1 write model is missing budgeted_rows_written_per_event.");
  }

  if (
    bottleneck?.used_pct !== null &&
    bottleneck?.used_pct !== undefined &&
    bottleneck.used_pct > options.maxBottleneckUsedPct
  ) {
    failures.push(
      `Budget bottleneck ${bottleneck.label} is at ${bottleneck.used_pct}%, above ${options.maxBottleneckUsedPct}%.`,
    );
  }

  if (
    dailyD1RowsWritten?.used_pct !== null &&
    dailyD1RowsWritten?.used_pct !== undefined &&
    dailyD1RowsWritten.used_pct > options.maxD1RowsWrittenUsedPct
  ) {
    failures.push(
      `D1 rows written / day is at ${dailyD1RowsWritten.used_pct}%, above ${options.maxD1RowsWrittenUsedPct}%.`,
    );
  }

  return {
    ok: failures.length === 0,
    source: budget?.source ?? "missing",
    state: budget?.state ?? "missing",
    generated_at: budget?.generated_at,
    failures,
    warnings,
    bottleneck: summariseConstraint(bottleneck),
    constraints: constraints.map(summariseConstraint),
    d1_write_model: budget?.d1_write_model
      ? {
          budgeted_rows_written_per_event: budget.d1_write_model.budgeted_rows_written_per_event,
          free_rows_written_per_day: budget.d1_write_model.free_rows_written_per_day,
        }
      : undefined,
    d1_rows_written_activity: measuredD1RowsWritten
      ? {
          id: measuredD1RowsWritten.id,
          label: measuredD1RowsWritten.label,
          rows_written_daily: measuredD1RowsWritten.rows_written_daily,
          source: measuredD1RowsWritten.source,
          sampled: measuredD1RowsWritten.sampled,
          updated_at: measuredD1RowsWritten.updated_at,
        }
      : undefined,
  };
}

function unwrapBudgetPayload(payload) {
  if (payload?.budget && typeof payload.budget === "object") return payload.budget;
  return payload;
}

function chooseBottleneck(constraints) {
  return constraints
    .filter((constraint) => constraint.remaining_ratio !== null && constraint.remaining_ratio !== undefined)
    .sort((left, right) => left.remaining_ratio - right.remaining_ratio)[0];
}

function findMeasuredD1RowsWrittenSignal(budget) {
  const signals = budget?.d1_activity?.signals;
  if (!Array.isArray(signals)) return undefined;
  return signals.find(
    (signal) =>
      signal.source === "cloudflare_analytics" &&
      signal.sampled &&
      typeof signal.rows_written_daily === "number",
  );
}

function findDailyD1RowsWrittenConstraint(constraints) {
  return constraints.find(
    (constraint) =>
      constraint.window_type === "daily" &&
      constraint.unit === "d1_row" &&
      /D1 rows written/i.test(constraint.label),
  );
}

function summariseConstraint(constraint) {
  if (!constraint) return undefined;
  return {
    id: constraint.id,
    label: constraint.label,
    state: constraint.state,
    used_pct: constraint.used_pct,
    source: constraint.source,
    sampled: constraint.sampled,
    remaining_ratio: constraint.remaining_ratio,
    remaining_event_capacity: constraint.remaining_event_capacity,
  };
}

function redactOrigin(url) {
  const parsed = new URL(url);
  return parsed.pathname;
}

function printTextSummary(result, stdout) {
  stdout.write(`direct: health ${result.direct.health}, bootstrap ${result.direct.bootstrap}, usage ${result.direct.usage}\n`);
  if (result.browser) {
    stdout.write(`browser: ${result.browser.title}, bootstrap ${result.browser.bootstrapStatus}\n`);
  } else {
    stdout.write("browser: skipped\n");
  }
  stdout.write(
    `budget: ${result.budget.state}, source ${result.budget.source}, bottleneck ${
      result.budget.bottleneck?.label ?? "missing"
    } ${result.budget.bottleneck?.used_pct ?? "missing"}%\n`,
  );
  if (result.budget.warnings.length > 0) {
    stdout.write(`warnings: ${result.budget.warnings.join("; ")}\n`);
  }
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  runSmoke = runDeployedSmoke,
} = {}) {
  let options;
  const requestedJson = argv.includes("--json");
  try {
    options = parseArgs(argv);
    if (options.help) {
      stdout.write(usage());
      return 0;
    }
    const config = readConfig(env);
    const result = await runSmoke({ config, options });
    if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printTextSummary(result, stdout);
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      if (requestedJson || options?.json) {
        stdout.write(
          `${JSON.stringify(
            {
              ok: false,
              error: error.message,
              usage: usage(),
            },
            null,
            2,
          )}\n`,
        );
        return 2;
      }
      stderr.write(`${error.message}\n\n${usage()}`);
      return 2;
    }
    const details = error instanceof SmokeError ? error.details : undefined;
    if (options?.json) {
      stdout.write(
        `${JSON.stringify(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            details,
          },
          null,
          2,
        )}\n`,
      );
      return 1;
    }
    stderr.write(`${error.message ?? String(error)}\n`);
    if (details) {
      stderr.write(`${JSON.stringify(details, null, 2)}\n`);
    }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
