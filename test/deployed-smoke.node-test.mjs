import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyseBudget,
  cfAccessCookies,
  cfAuthorizationCookie,
  extractAssetUrls,
  parseArgs,
  readConfig,
  runDeployedSmoke,
  runCli,
  SmokeError,
  splitCombinedSetCookie,
  usage,
} from "../scripts/deployed-smoke.mjs";

describe("deployed smoke argument parsing", () => {
  it("parses gates and browser controls", () => {
    const options = parseArgs([
      "--",
      "--json",
      "--skip-browser",
      "--allow-missing-telemetry",
      "--max-bottleneck-used-pct",
      "75",
      "--max-d1-rows-written-used-pct=55",
    ]);

    assert.equal(options.json, true);
    assert.equal(options.skipBrowser, true);
    assert.equal(options.allowMissingTelemetry, true);
    assert.equal(options.maxBottleneckUsedPct, 75);
    assert.equal(options.maxD1RowsWrittenUsedPct, 55);
  });

  it("rejects invalid percentages", () => {
    assert.throws(() => parseArgs(["--max-bottleneck-used-pct", "101"]), /between 0 and 100/);
  });
});

describe("deployed smoke config", () => {
  it("normalises domains without printing secrets", () => {
    const config = readConfig({
      CHAOP_GUI_DOMAIN: "app.example.com",
      VITE_CHAOP_API_BASE_URL: "https://api.example.com/",
      CF_ACCESS_CLIENT_ID: "client-id",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });

    assert.equal(config.guiUrl, "https://app.example.com");
    assert.equal(config.apiBaseUrl, "https://api.example.com");
    assert.equal(config.accessHeaders["CF-Access-Client-Id"], "client-id");
  });

  it("rejects non-HTTPS deployed origins", () => {
    assert.throws(
      () =>
        readConfig({
          ...smokeEnv(),
          CHAOP_GUI_DOMAIN: "http://app.example.com",
        }),
      /CHAOP_GUI_DOMAIN must use https:\/\//,
    );

    assert.throws(
      () =>
        readConfig({
          ...smokeEnv(),
          VITE_CHAOP_API_BASE_URL: "http://api.example.com/",
        }),
      /VITE_CHAOP_API_BASE_URL must use https:\/\//,
    );
  });
});

describe("deployed smoke assets and cookies", () => {
  it("extracts JavaScript and CSS assets from an index", () => {
    const assets = extractAssetUrls(
      `
      <link rel="stylesheet" href="/assets/index.css">
      <script type="module" src="/assets/index.js"></script>
      <script type="module" src="https://cdn.example.com/assets/external.js"></script>
      <img src="/assets/logo.png">
      `,
      "https://app.example.com",
    );

    assert.deepEqual(assets, [
      "https://app.example.com/assets/index.css",
      "https://app.example.com/assets/index.js",
    ]);
  });

  it("splits combined Set-Cookie headers without splitting Expires commas", () => {
    assert.deepEqual(
      splitCombinedSetCookie(
        "CF_Authorization=abc; Expires=Wed, 25 Jun 2026 12:00:00 GMT; Path=/, other=value; Path=/",
      ),
      [
        "CF_Authorization=abc; Expires=Wed, 25 Jun 2026 12:00:00 GMT; Path=/",
        "other=value; Path=/",
      ],
    );
  });

  it("extracts a browser cookie for Cloudflare Access", () => {
    const headers = new Headers({
      "set-cookie": "CF_Authorization=token-value; Path=/; Secure; HttpOnly",
    });

    assert.deepEqual(cfAuthorizationCookie(headers, "app.example.com"), {
      name: "CF_Authorization",
      value: "token-value",
      domain: "app.example.com",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "None",
    });
  });

  it("preserves Cloudflare Access binding cookies for browser smoke", () => {
    const headers = new Headers({
      "set-cookie":
        "CF_Authorization=token-value; Path=/; Secure; HttpOnly, CF_Binding=binding-value; Path=/; Secure; HttpOnly",
    });

    assert.deepEqual(cfAccessCookies(headers, "app.example.com"), [
      {
        name: "CF_Authorization",
        value: "token-value",
        domain: "app.example.com",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "None",
      },
      {
        name: "CF_Binding",
        value: "binding-value",
        domain: "app.example.com",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "None",
      },
    ]);
  });

  it("rejects API health responses from the wrong service", async () => {
    const config = readConfig(smokeEnv());
    const requested = [];
    const fetchImpl = async (url) => {
      requested.push(url);
      if (url === "https://api.example.com/api/health") {
        return jsonResponse({ ok: true, service: "wrong-api" });
      }
      throw new Error(`Unexpected request after health failure: ${url}`);
    };

    await assert.rejects(
      () =>
        runDeployedSmoke({
          config,
          fetchImpl,
          options: {
            skipBrowser: true,
            allowMissingTelemetry: false,
            maxBottleneckUsedPct: 90,
            maxD1RowsWrittenUsedPct: 80,
          },
        }),
      /API health service/,
    );
    assert.deepEqual(requested, ["https://api.example.com/api/health"]);
  });

  it("uses the GUI origin, not the full GUI URL path, for API Origin headers", async () => {
    const config = readConfig({
      ...smokeEnv(),
      CHAOP_GUI_URL: "https://app.example.com/control/",
    });
    const seenOrigins = [];
    const fetchImpl = async (url, init = {}) => {
      if (init.headers?.Origin) {
        seenOrigins.push(init.headers.Origin);
      }
      if (init.headers?.["CF-Access-Client-Secret"] && init.redirect !== "manual") {
        throw new Error("Access header fetch did not disable automatic redirects");
      }
      if (url === "https://api.example.com/api/health") {
        return jsonResponse(healthBody());
      }
      if (url === "https://api.example.com/api/bootstrap") {
        return jsonResponse({ workspaces: [] });
      }
      if (url === "https://api.example.com/api/usage-summary") {
        return jsonResponse(healthyBudget());
      }
      if (url === "https://app.example.com/control") {
        return textResponse('<script type="module" src="/assets/index.js"></script>');
      }
      if (url === "https://app.example.com/assets/index.js") {
        return textResponse("console.log('ok');", { headers: { "content-type": "text/javascript" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await runDeployedSmoke({
      config,
      fetchImpl,
      options: {
        skipBrowser: true,
        allowMissingTelemetry: false,
        maxBottleneckUsedPct: 90,
        maxD1RowsWrittenUsedPct: 80,
      },
    });

    assert.deepEqual(seenOrigins, ["https://app.example.com", "https://app.example.com"]);
  });

  it("rejects malformed bootstrap JSON in skip-browser smoke", async () => {
    const config = readConfig(smokeEnv());
    const requested = [];
    const fetchImpl = async (url) => {
      requested.push(url);
      if (url === "https://api.example.com/api/health") {
        return jsonResponse(healthBody());
      }
      if (url === "https://api.example.com/api/bootstrap") {
        return jsonResponse({ workspaces: {} });
      }
      throw new Error(`Unexpected request after bootstrap failure: ${url}`);
    };

    await assert.rejects(
      () =>
        runDeployedSmoke({
          config,
          fetchImpl,
          options: {
            skipBrowser: true,
            allowMissingTelemetry: false,
            maxBottleneckUsedPct: 90,
            maxD1RowsWrittenUsedPct: 80,
          },
        }),
      /API bootstrap did not return the expected API JSON/,
    );
    assert.deepEqual(requested, ["https://api.example.com/api/health", "https://api.example.com/api/bootstrap"]);
  });

  it("does not automatically follow asset redirects with Access headers", async () => {
    const config = readConfig(smokeEnv());
    const requested = [];
    const fetchImpl = async (url, init = {}) => {
      requested.push(url);
      if (init.headers?.["CF-Access-Client-Secret"] && init.redirect !== "manual") {
        throw new Error("Access header fetch did not disable automatic redirects");
      }
      if (url === "https://api.example.com/api/health") {
        return jsonResponse(healthBody());
      }
      if (url === "https://api.example.com/api/bootstrap") {
        return jsonResponse({ workspaces: [] });
      }
      if (url === "https://api.example.com/api/usage-summary") {
        return jsonResponse(healthyBudget());
      }
      if (url === "https://app.example.com") {
        return textResponse('<script type="module" src="/assets/index.js"></script>');
      }
      if (url === "https://app.example.com/assets/index.js") {
        return textResponse("", { status: 302, headers: { location: "https://cdn.example.com/assets/index.js" } });
      }
      if (url === "https://cdn.example.com/assets/index.js") {
        throw new Error("Off-origin asset redirect was followed");
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await assert.rejects(
      () =>
        runDeployedSmoke({
          config,
          fetchImpl,
          options: {
            skipBrowser: true,
            allowMissingTelemetry: false,
            maxBottleneckUsedPct: 90,
            maxD1RowsWrittenUsedPct: 80,
          },
        }),
      /Request failed/,
    );
    assert.equal(requested.includes("https://cdn.example.com/assets/index.js"), false);
  });

  it("rejects HTML fallback responses for JavaScript assets", async () => {
    const config = readConfig(smokeEnv());
    const fetchImpl = async (url, init = {}) => {
      if (init.headers?.["CF-Access-Client-Secret"] && init.redirect !== "manual") {
        throw new Error("Access header fetch did not disable automatic redirects");
      }
      if (url === "https://api.example.com/api/health") {
        return jsonResponse(healthBody());
      }
      if (url === "https://api.example.com/api/bootstrap") {
        return jsonResponse({ workspaces: [] });
      }
      if (url === "https://api.example.com/api/usage-summary") {
        return jsonResponse(healthyBudget());
      }
      if (url === "https://app.example.com") {
        return textResponse('<script type="module" src="/assets/missing.js"></script>');
      }
      if (url === "https://app.example.com/assets/missing.js") {
        return textResponse("<!doctype html><title>Chaop</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await assert.rejects(
      () =>
        runDeployedSmoke({
          config,
          fetchImpl,
          options: {
            skipBrowser: true,
            allowMissingTelemetry: false,
            maxBottleneckUsedPct: 90,
            maxD1RowsWrittenUsedPct: 80,
          },
        }),
      (error) => {
        assert.match(error.message, /unexpected content type/);
        assert.match(error.message, /\/assets\/missing\.js/);
        assert.doesNotMatch(error.message, /https:\/\/app\.example\.com/);
        return true;
      },
    );
  });

  it("times out stalled direct requests", async () => {
    const config = readConfig({ ...smokeEnv(), CHAOP_SMOKE_BROWSER_TIMEOUT_MS: "5" });
    const fetchImpl = async (_url, init = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    await assert.rejects(
      () =>
        runDeployedSmoke({
          config,
          fetchImpl,
          options: {
            skipBrowser: true,
            allowMissingTelemetry: false,
            maxBottleneckUsedPct: 90,
            maxD1RowsWrittenUsedPct: 80,
          },
        }),
      /Request timed out/,
    );
  });

  it("times out stalled direct response bodies", async () => {
    const config = readConfig({ ...smokeEnv(), CHAOP_SMOKE_BROWSER_TIMEOUT_MS: "5" });
    const fetchImpl = async (_url, init = {}) => ({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("body aborted")));
        }),
    });

    await assert.rejects(
      () =>
        rejectAfter(
          runDeployedSmoke({
            config,
            fetchImpl,
            options: {
              skipBrowser: true,
              allowMissingTelemetry: false,
              maxBottleneckUsedPct: 90,
              maxD1RowsWrittenUsedPct: 80,
            },
          }),
          100,
          "direct response body did not time out",
        ),
      /Request timed out/,
    );
  });

  it("fails when the browser bootstrap request times out", async () => {
    const config = readConfig({ ...smokeEnv(), CHAOP_SMOKE_BROWSER_TIMEOUT_MS: "5" });
    const fetchImpl = async (url, init = {}) => {
      if (init.headers?.["CF-Access-Client-Secret"] && init.redirect !== "manual") {
        throw new Error("Access header fetch did not disable automatic redirects");
      }
      if (url === "https://api.example.com/api/health") {
        return jsonResponse(healthBody(), { headers: { "set-cookie": "CF_Authorization=api-token; Path=/" } });
      }
      if (url === "https://api.example.com/api/bootstrap") {
        return jsonResponse({ workspaces: [] });
      }
      if (url === "https://api.example.com/api/usage-summary") {
        return jsonResponse(healthyBudget());
      }
      if (url === "https://app.example.com") {
        return textResponse('<script type="module" src="/assets/index.js"></script>', {
          headers: { "set-cookie": "CF_Authorization=gui-token; Path=/" },
        });
      }
      if (url === "https://app.example.com/assets/index.js") {
        return textResponse("console.log('ok');", { headers: { "content-type": "text/javascript" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await assert.rejects(
      () =>
        runDeployedSmoke({
          config,
          fetchImpl,
          browserLauncher: fakeBrowserLauncher({
            responses: [],
          }),
          options: {
            skipBrowser: false,
            allowMissingTelemetry: false,
            maxBottleneckUsedPct: 90,
            maxD1RowsWrittenUsedPct: 80,
          },
        }),
      /Browser app did not request bootstrap before the browser smoke timeout/,
    );
  });

  it("fails when the browser app bootstrap response is not API JSON", async () => {
    const config = readConfig(smokeEnv());
    const fetchImpl = async (url, init = {}) => {
      if (init.headers?.["CF-Access-Client-Secret"] && init.redirect !== "manual") {
        throw new Error("Access header fetch did not disable automatic redirects");
      }
      if (url === "https://api.example.com/api/health") {
        return jsonResponse(healthBody(), { headers: { "set-cookie": "CF_Authorization=api-token; Path=/" } });
      }
      if (url === "https://api.example.com/api/bootstrap") {
        return jsonResponse({ workspaces: [] });
      }
      if (url === "https://api.example.com/api/usage-summary") {
        return jsonResponse(healthyBudget());
      }
      if (url === "https://app.example.com") {
        return textResponse('<script type="module" src="/assets/index.js"></script>', {
          headers: { "set-cookie": "CF_Authorization=gui-token; Path=/" },
        });
      }
      if (url === "https://app.example.com/assets/index.js") {
        return textResponse("console.log('ok');", { headers: { "content-type": "text/javascript" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await assert.rejects(
      () =>
        rejectAfter(
          runDeployedSmoke({
            config,
            fetchImpl,
            browserLauncher: fakeBrowserLauncher({
              responses: [
                {
                  status: 200,
                  url: "https://api.example.com/api/bootstrap",
                  headers: { "content-type": "text/html" },
                  body: "<!doctype html>",
                },
              ],
            }),
            options: {
              skipBrowser: false,
              allowMissingTelemetry: false,
              maxBottleneckUsedPct: 90,
              maxD1RowsWrittenUsedPct: 80,
            },
          }),
          100,
          "browser bootstrap malformed response did not fail",
        ),
      /Browser app bootstrap request did not return the expected API JSON/,
    );
  });

  it("redacts browser navigation failures", async () => {
    const config = readConfig(smokeEnv());
    const fetchImpl = async (url, init = {}) => {
      if (init.headers?.["CF-Access-Client-Secret"] && init.redirect !== "manual") {
        throw new Error("Access header fetch did not disable automatic redirects");
      }
      if (url === "https://api.example.com/api/health") {
        return jsonResponse(healthBody(), { headers: { "set-cookie": "CF_Authorization=api-token; Path=/" } });
      }
      if (url === "https://api.example.com/api/bootstrap") {
        return jsonResponse({ workspaces: [] });
      }
      if (url === "https://api.example.com/api/usage-summary") {
        return jsonResponse(healthyBudget());
      }
      if (url === "https://app.example.com") {
        return textResponse('<script type="module" src="/assets/index.js"></script>', {
          headers: { "set-cookie": "CF_Authorization=gui-token; Path=/" },
        });
      }
      if (url === "https://app.example.com/assets/index.js") {
        return textResponse("console.log('ok');", { headers: { "content-type": "text/javascript" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const unhandledRejections = await collectUnhandledRejections(
      () =>
        assert.rejects(
          () =>
            runDeployedSmoke({
              config,
              fetchImpl,
              browserLauncher: fakeBrowserLauncher({
                responses: [],
                goto: async () => {
                  throw new Error("net::ERR_FAILED at https://app.example.com/");
                },
              }),
              options: {
                skipBrowser: false,
                allowMissingTelemetry: false,
                maxBottleneckUsedPct: 90,
                maxD1RowsWrittenUsedPct: 80,
              },
            }),
          (error) => {
            assert.match(error.message, /Browser navigation failed for the GUI origin/);
            assert.doesNotMatch(error.message, /app\.example\.com/);
            assert.doesNotMatch(JSON.stringify(error.details), /app\.example\.com/);
            return true;
          },
        ),
      20,
    );
    assert.deepEqual(unhandledRejections, []);
  });

  it("fails when the deployed app uses a stale API origin", async () => {
    const config = readConfig(smokeEnv());
    const fetchImpl = async (url, init = {}) => {
      if (init.headers?.["CF-Access-Client-Secret"] && init.redirect !== "manual") {
        throw new Error("Access header fetch did not disable automatic redirects");
      }
      if (url === "https://api.example.com/api/health") {
        return jsonResponse(healthBody(), { headers: { "set-cookie": "CF_Authorization=api-token; Path=/" } });
      }
      if (url === "https://api.example.com/api/bootstrap") {
        return jsonResponse({ workspaces: [] });
      }
      if (url === "https://api.example.com/api/usage-summary") {
        return jsonResponse(healthyBudget());
      }
      if (url === "https://app.example.com") {
        return textResponse('<script type="module" src="/assets/index.js"></script>', {
          headers: { "set-cookie": "CF_Authorization=gui-token; Path=/" },
        });
      }
      if (url === "https://app.example.com/assets/index.js") {
        return textResponse("console.log('ok');", { headers: { "content-type": "text/javascript" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await assert.rejects(
      () =>
        runDeployedSmoke({
          config,
          fetchImpl,
          browserLauncher: fakeBrowserLauncher({
            responses: [{ status: 200, url: "https://stale-api.example.com/api/bootstrap" }],
          }),
          options: {
            skipBrowser: false,
            allowMissingTelemetry: false,
            maxBottleneckUsedPct: 90,
            maxD1RowsWrittenUsedPct: 80,
          },
        }),
      (error) => {
        assert.match(error.message, /Browser app bootstrap used an unexpected API origin/);
        assert.doesNotMatch(error.message, /stale-api\.example\.com/);
        assert.doesNotMatch(JSON.stringify(error.details), /stale-api\.example\.com/);
        return true;
      },
    );
  });

  it("ignores optional browser favicon failures", async () => {
    const config = readConfig(smokeEnv());
    const fetchImpl = async (url, init = {}) => {
      if (init.headers?.["CF-Access-Client-Secret"] && init.redirect !== "manual") {
        throw new Error("Access header fetch did not disable automatic redirects");
      }
      if (url === "https://api.example.com/api/health") {
        return jsonResponse(healthBody(), { headers: { "set-cookie": "CF_Authorization=api-token; Path=/" } });
      }
      if (url === "https://api.example.com/api/bootstrap") {
        return jsonResponse({ workspaces: [] });
      }
      if (url === "https://api.example.com/api/usage-summary") {
        return jsonResponse(healthyBudget());
      }
      if (url === "https://app.example.com") {
        return textResponse('<script type="module" src="/assets/index.js"></script>', {
          headers: { "set-cookie": "CF_Authorization=gui-token; Path=/" },
        });
      }
      if (url === "https://app.example.com/assets/index.js") {
        return textResponse("console.log('ok');", { headers: { "content-type": "text/javascript" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await runDeployedSmoke({
      config,
      fetchImpl,
      browserLauncher: fakeBrowserLauncher({
        responses: [
          { status: 200, url: "https://api.example.com/api/bootstrap" },
          { status: 404, url: "https://app.example.com/favicon.ico" },
        ],
        requestFailures: [
          { url: "https://app.example.com/favicon.ico", errorText: "net::ERR_FAILED" },
        ],
      }),
      options: {
        skipBrowser: false,
        allowMissingTelemetry: false,
        maxBottleneckUsedPct: 90,
        maxD1RowsWrittenUsedPct: 80,
      },
    });

    assert.deepEqual(result.browser.failedResponses, []);
  });

  it("fails on deployed browser responses other than optional favicon requests", async () => {
    const config = readConfig(smokeEnv());
    const fetchImpl = async (url, init = {}) => {
      if (init.headers?.["CF-Access-Client-Secret"] && init.redirect !== "manual") {
        throw new Error("Access header fetch did not disable automatic redirects");
      }
      if (url === "https://api.example.com/api/health") {
        return jsonResponse(healthBody(), { headers: { "set-cookie": "CF_Authorization=api-token; Path=/" } });
      }
      if (url === "https://api.example.com/api/bootstrap") {
        return jsonResponse({ workspaces: [] });
      }
      if (url === "https://api.example.com/api/usage-summary") {
        return jsonResponse(healthyBudget());
      }
      if (url === "https://app.example.com") {
        return textResponse('<script type="module" src="/assets/index.js"></script>', {
          headers: { "set-cookie": "CF_Authorization=gui-token; Path=/" },
        });
      }
      if (url === "https://app.example.com/assets/index.js") {
        return textResponse("console.log('ok');", { headers: { "content-type": "text/javascript" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await assert.rejects(
      () =>
        runDeployedSmoke({
          config,
          fetchImpl,
          browserLauncher: fakeBrowserLauncher({
            responses: [
              { status: 200, url: "https://api.example.com/api/bootstrap" },
              { status: 404, url: "https://app.example.com/assets/missing.js" },
            ],
          }),
          options: {
            skipBrowser: false,
            allowMissingTelemetry: false,
            maxBottleneckUsedPct: 90,
            maxD1RowsWrittenUsedPct: 80,
          },
        }),
      /Browser observed failed deployed responses/,
    );
  });

  it("fails on deployed browser request failures without HTTP responses", async () => {
    const config = readConfig(smokeEnv());
    const fetchImpl = async (url, init = {}) => {
      if (init.headers?.["CF-Access-Client-Secret"] && init.redirect !== "manual") {
        throw new Error("Access header fetch did not disable automatic redirects");
      }
      if (url === "https://api.example.com/api/health") {
        return jsonResponse(healthBody(), { headers: { "set-cookie": "CF_Authorization=api-token; Path=/" } });
      }
      if (url === "https://api.example.com/api/bootstrap") {
        return jsonResponse({ workspaces: [] });
      }
      if (url === "https://api.example.com/api/usage-summary") {
        return jsonResponse(healthyBudget());
      }
      if (url === "https://app.example.com") {
        return textResponse('<script type="module" src="/assets/index.js"></script>', {
          headers: { "set-cookie": "CF_Authorization=gui-token; Path=/" },
        });
      }
      if (url === "https://app.example.com/assets/index.js") {
        return textResponse("console.log('ok');", { headers: { "content-type": "text/javascript" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await assert.rejects(
      () =>
        runDeployedSmoke({
          config,
          fetchImpl,
          browserLauncher: fakeBrowserLauncher({
            requestFailures: [
              { url: "https://app.example.com/assets/chunk.js", errorText: "net::ERR_FAILED" },
            ],
          }),
          options: {
            skipBrowser: false,
            allowMissingTelemetry: false,
            maxBottleneckUsedPct: 90,
            maxD1RowsWrittenUsedPct: 80,
          },
        }),
      (error) => {
        assert.match(error.message, /Browser observed failed deployed responses/);
        assert.doesNotMatch(JSON.stringify(error.details), /app\.example\.com/);
        assert.match(JSON.stringify(error.details), /requestfailed/);
        return true;
      },
    );
  });
});

describe("deployed smoke budget gate", () => {
  it("short-circuits assets and browser checks when the budget gate fails", async () => {
    const config = readConfig(smokeEnv());
    const requested = [];
    const hardLimitedBudget = {
      ...healthyBudget(),
      state: "hard_limited",
    };
    const fetchImpl = async (url, init = {}) => {
      requested.push(url);
      if (init.headers?.["CF-Access-Client-Secret"] && init.redirect !== "manual") {
        throw new Error("Access header fetch did not disable automatic redirects");
      }
      if (url === "https://api.example.com/api/health") {
        return jsonResponse(healthBody());
      }
      if (url === "https://api.example.com/api/bootstrap") {
        return jsonResponse({ workspaces: [] });
      }
      if (url === "https://api.example.com/api/usage-summary") {
        return jsonResponse(hardLimitedBudget);
      }
      throw new Error(`Unexpected request after budget failure: ${url}`);
    };

    await assert.rejects(
      () =>
        runDeployedSmoke({
          config,
          fetchImpl,
          browserLauncher: {
            async launch() {
              throw new Error("Browser should not launch after a budget failure");
            },
          },
          options: {
            skipBrowser: false,
            allowMissingTelemetry: false,
            maxBottleneckUsedPct: 90,
            maxD1RowsWrittenUsedPct: 80,
          },
        }),
      /Budget gate failed/,
    );
    assert.deepEqual(requested, [
      "https://api.example.com/api/health",
      "https://api.example.com/api/bootstrap",
      "https://api.example.com/api/usage-summary",
    ]);
  });

  it("passes a healthy telemetry-backed budget", () => {
    const budget = analyseBudget(healthyBudget(), {
      allowMissingTelemetry: false,
      maxBottleneckUsedPct: 90,
      maxD1RowsWrittenUsedPct: 80,
    });

    assert.equal(budget.ok, true);
    assert.equal(budget.source, "cloudflare_analytics");
    assert.equal(budget.bottleneck.label, "D1 rows read / day");
    assert.equal(budget.d1_rows_written_activity.rows_written_daily, 123);
  });

  it("passes with D1 usage window source when Cloudflare telemetry constraints are sampled", () => {
    const payload = {
      ...healthyBudget(),
      source: "d1_usage_windows",
      window_sample_count: 1,
    };
    const budget = analyseBudget(payload, {
      allowMissingTelemetry: false,
      maxBottleneckUsedPct: 90,
      maxD1RowsWrittenUsedPct: 80,
    });

    assert.equal(budget.ok, true);
    assert.equal(budget.source, "d1_usage_windows");
  });

  it("fails when telemetry is missing by default", () => {
    const budget = analyseBudget(
      {
        ...healthyBudget(),
        source: "d1_usage_windows",
        constraints: [],
        bottleneck_constraint: undefined,
        d1_activity: undefined,
      },
      {
        allowMissingTelemetry: false,
        maxBottleneckUsedPct: 90,
        maxD1RowsWrittenUsedPct: 80,
      },
    );

    assert.equal(budget.ok, false);
    assert.match(budget.failures.join("\n"), /Cloudflare telemetry/);
    assert.match(budget.failures.join("\n"), /No sampled hard budget constraints/);
  });

  it("still fails without sampled hard constraints when missing telemetry is allowed", () => {
    const budget = analyseBudget(
      {
        ...healthyBudget(),
        source: "d1_usage_windows",
        constraints: [],
        bottleneck_constraint: undefined,
        d1_activity: undefined,
      },
      {
        allowMissingTelemetry: true,
        maxBottleneckUsedPct: 90,
        maxD1RowsWrittenUsedPct: 80,
      },
    );

    assert.equal(budget.ok, false);
    assert.match(budget.failures.join("\n"), /No sampled hard budget constraints/);
    assert.match(budget.warnings.join("\n"), /Cloudflare telemetry/);
  });

  it("fails on hard limits and high D1 rows written", () => {
    const budget = healthyBudget();
    budget.state = "hard_limited";
    budget.constraints[0].used_pct = 90;
    const result = analyseBudget(budget, {
      allowMissingTelemetry: false,
      maxBottleneckUsedPct: 95,
      maxD1RowsWrittenUsedPct: 80,
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join("\n"), /hard_limited/);
    assert.match(result.failures.join("\n"), /D1 rows written \/ day is at 90%/);
  });

  it("fails on throttled posture", () => {
    const budget = {
      ...healthyBudget(),
      state: "throttled",
    };
    const result = analyseBudget(budget, {
      allowMissingTelemetry: false,
      maxBottleneckUsedPct: 90,
      maxD1RowsWrittenUsedPct: 80,
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join("\n"), /throttled/);
  });
});

describe("deployed smoke CLI", () => {
  it("keeps JSON output machine-readable on usage failures", async () => {
    const stdout = writableBuffer();
    const stderr = writableBuffer();
    const code = await runCli({
      argv: ["--json"],
      env: {
        CHAOP_GUI_DOMAIN: "app.example.com",
        VITE_CHAOP_API_BASE_URL: "https://api.example.com/",
        CF_ACCESS_CLIENT_ID: "client-id",
      },
      stdout,
      stderr,
    });

    assert.equal(code, 2);
    assert.equal(stderr.text, "");
    assert.deepEqual(JSON.parse(stdout.text), {
      ok: false,
      error: "CF_ACCESS_CLIENT_SECRET is required.",
      usage: usage(),
    });
  });

  it("keeps JSON output machine-readable on smoke failures", async () => {
    const stdout = writableBuffer();
    const stderr = writableBuffer();
    const code = await runCli({
      argv: ["--json"],
      env: smokeEnv(),
      stdout,
      stderr,
      runSmoke: async () => {
        throw new SmokeError("Budget gate failed.", {
          ok: false,
          budget: { failures: ["Budget posture is throttled."] },
        });
      },
    });

    assert.equal(code, 1);
    assert.equal(stderr.text, "");
    assert.deepEqual(JSON.parse(stdout.text), {
      ok: false,
      error: "Budget gate failed.",
      details: {
        ok: false,
        budget: { failures: ["Budget posture is throttled."] },
      },
    });
  });
});

function writableBuffer() {
  return {
    text: "",
    write(value) {
      this.text += value;
    },
  };
}

function smokeEnv() {
  return {
    CHAOP_GUI_DOMAIN: "app.example.com",
    VITE_CHAOP_API_BASE_URL: "https://api.example.com/",
    CF_ACCESS_CLIENT_ID: "client-id",
    CF_ACCESS_CLIENT_SECRET: "client-secret",
  };
}

function healthBody() {
  return {
    ok: true,
    service: "chaop-api",
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function textResponse(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

function fakeBrowserLauncher({
  goto = async () => {},
  responses = [{ status: 200, url: "https://api.example.com/api/bootstrap" }],
  requestFailures = [],
}) {
  return {
    async launch() {
      return {
        async newContext() {
          return {
            async addCookies() {},
            async newPage() {
              return {
                on(event, handler) {
                  if (event === "response") {
                    for (const response of responses) {
                      handler(fakeBrowserResponse(response));
                    }
                  } else if (event === "requestfailed") {
                    for (const failure of requestFailures) {
                      handler(fakeBrowserRequestFailure(failure));
                    }
                  }
                },
                goto,
                async waitForResponse(predicate, options = {}) {
                  for (const response of responses) {
                    const browserResponse = fakeBrowserResponse(response);
                    if (predicate(browserResponse)) return browserResponse;
                  }
                  const timeout = Math.min(options.timeout ?? 0, 10);
                  await new Promise((resolve) => setTimeout(resolve, timeout));
                  const error = new Error("Timeout waiting for response");
                  error.name = "TimeoutError";
                  throw error;
                },
                async waitForFunction() {},
                async title() {
                  return "Chaop Control Plane";
                },
              };
            },
            async close() {},
          };
        },
        async close() {},
      };
    },
  };
}

function fakeBrowserResponse(response) {
  return {
    status: () => response.status,
    url: () => response.url,
    headers: () => response.headers ?? { "content-type": "application/json" },
    async headerValue(name) {
      const headers = response.headers ?? { "content-type": "application/json" };
      return headers[name.toLowerCase()] ?? headers[name] ?? null;
    },
    async json() {
      if (response.body instanceof Error) throw response.body;
      return response.body ?? { workspaces: [] };
    },
  };
}

function fakeBrowserRequestFailure(failure) {
  return {
    url: () => failure.url,
    failure: () => ({ errorText: failure.errorText }),
  };
}

async function rejectAfter(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function collectUnhandledRejections(callback, settleMs = 0) {
  const rejections = [];
  const onUnhandledRejection = (reason) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await callback();
    if (settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
  return rejections;
}

function healthyBudget() {
  return {
    source: "cloudflare_analytics",
    state: "normal",
    generated_at: "2026-06-25T06:29:46.135Z",
    bottleneck_constraint: {
      id: "cloudflare_d1_rows_read_daily",
      label: "D1 rows read / day",
      window_type: "daily",
      unit: "d1_row_read",
      hard: true,
      sampled: true,
      state: "normal",
      source: "cloudflare_analytics",
      used_pct: 6.1,
      remaining_ratio: 0.939,
      remaining_event_capacity: null,
    },
    constraints: [
      {
        id: "cloudflare_d1_rows_written_daily",
        label: "D1 rows written / day",
        window_type: "daily",
        unit: "d1_row",
        hard: true,
        sampled: true,
        state: "normal",
        source: "cloudflare_analytics",
        used_pct: 0.1,
        remaining_ratio: 0.999,
        remaining_event_capacity: 3830,
      },
      {
        id: "cloudflare_d1_rows_read_daily",
        label: "D1 rows read / day",
        window_type: "daily",
        unit: "d1_row_read",
        hard: true,
        sampled: true,
        state: "normal",
        source: "cloudflare_analytics",
        used_pct: 6.1,
        remaining_ratio: 0.939,
        remaining_event_capacity: null,
      },
    ],
    d1_write_model: {
      budgeted_rows_written_per_event: 26,
      free_rows_written_per_day: 100000,
    },
    d1_activity: {
      generated_at: "2026-06-25T06:29:46.135Z",
      source: "d1_write_activity_signals",
      signals: [
        {
          id: "cloudflare_d1_rows_written_daily",
          label: "Measured D1 writes today",
          source: "cloudflare_analytics",
          rows_written_daily: 123,
          sampled: true,
          detail: "Measured from Cloudflare Analytics.",
        },
      ],
    },
  };
}
