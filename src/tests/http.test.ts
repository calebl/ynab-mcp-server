import { afterEach, describe, expect, it, vi } from "vitest";

import type { HttpServerOptions } from "../httpServer.js";

const created: HttpServerOptions[] = [];

vi.mock("../httpServer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../httpServer.js")>();
  return {
    ...actual,
    createHttpServer: (options: HttpServerOptions) => {
      created.push(options);
      return {
        listen: (_port: number, _host: string, onListening: () => void) => onListening(),
        close: () => {},
      };
    },
  };
});

/** Loads the HTTP entry fresh under the current env; returns its readOnly option and console output. */
async function loadHttpEntry(env: Record<string, string | undefined>) {
  created.length = 0;
  vi.stubEnv("YNAB_API_TOKEN", "test-token");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.resetModules();
  await import("../http.js");
  return {
    readOnly: created[0]?.readOnly,
    output: error.mock.calls.map((args) => String(args[0])).join("\n"),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("HTTP entry", () => {
  it.each([undefined, "", "true", "TRUE", " true ", "no"])("serves read-only when YNAB_READ_ONLY is %j", async (value) => {
    const { readOnly, output } = await loadHttpEntry({ YNAB_READ_ONLY: value, YNAB_MCP_HOST: "0.0.0.0" });
    expect(readOnly).toBe(true);
    expect(output).toContain("(read-only)");
    expect(output).not.toContain("Warning");
  });

  it.each(["false", " false "])("serves write tools when YNAB_READ_ONLY is %j", async (value) => {
    const { readOnly, output } = await loadHttpEntry({ YNAB_READ_ONLY: value });
    expect(readOnly).toBe(false);
    expect(output).not.toContain("(read-only)");
    expect(output).not.toContain("Warning");
  });

  it("warns when write tools are enabled on a non-loopback address", async () => {
    const { readOnly, output } = await loadHttpEntry({ YNAB_READ_ONLY: "false", YNAB_MCP_HOST: "0.0.0.0" });
    expect(readOnly).toBe(false);
    expect(output).toContain("Warning: listening on 0.0.0.0 with write tools enabled and no authentication.");
    expect(output).toContain("unset YNAB_READ_ONLY to serve read-only");
  });
});
