import { describe, expect, it } from "vitest";

import { readYnabConfig, resolveAppConfig } from "./config.js";

describe("config", () => {
  it("resolves the full app config from CLI flags and environment", () => {
    const config = resolveAppConfig(
      [
        "--transport",
        "http",
        "--host",
        "0.0.0.0",
        "--port",
        "8080",
        "--path",
        "/bridge",
        "--allowed-origins",
        "https://claude.ai,https://chat.openai.com",
      ],
      {
        MCP_ALLOWED_ORIGINS: "https://ignored.example",
        YNAB_API_TOKEN: "token-1",
        YNAB_PLAN_ID: "plan-1",
      },
    );

    expect(config).toEqual({
      runtime: {
        allowedOrigins: ["https://claude.ai", "https://chat.openai.com"],
        host: "0.0.0.0",
        path: "/bridge",
        port: 8080,
        transport: "http",
      },
      ynab: {
        apiToken: "token-1",
        planId: "plan-1",
      },
    });
  });

  it("reads only YNAB settings from environment", () => {
    expect(readYnabConfig({
      YNAB_API_TOKEN: "token-2",
      YNAB_PLAN_ID: "plan-2",
    })).toEqual({
      apiToken: "token-2",
      planId: "plan-2",
    });
  });

  it("fails fast when the API token is missing", () => {
    expect(() => resolveAppConfig([], {})).toThrow("YNAB_API_TOKEN is required.");
  });
});
