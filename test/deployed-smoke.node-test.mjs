import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyseBudget,
  cfAuthorizationCookie,
  extractAssetUrls,
  parseArgs,
  readConfig,
  runCli,
  SmokeError,
  splitCombinedSetCookie,
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
});

describe("deployed smoke budget gate", () => {
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
