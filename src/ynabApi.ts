import * as ynab from "ynab";

import { readYnabConfig } from "./config.js";
import { SlidingWindowRateLimiter, createYnabRateLimiter } from "./ynabRateLimiter.js";

declare module "ynab" {
  interface api {
    moneyMovements: ynab.MoneyMovementsApi;
  }
}

type CreateYnabApiOptions = {
  fetchApi?: typeof fetch;
  rateLimiter?: SlidingWindowRateLimiter;
  retryDelayMs?: number;
  retryLimit?: number;
};

const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_RETRY_LIMIT = 1;
const sharedRateLimiter = createYnabRateLimiter();

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getRetryDelayMs(response: Response, fallbackDelayMs: number) {
  const retryAfter = response.headers.get("retry-after");

  if (!retryAfter) {
    return fallbackDelayMs;
  }

  const retryAfterSeconds = Number(retryAfter);

  if (Number.isFinite(retryAfterSeconds)) {
    return Math.max(retryAfterSeconds * 1000, 0);
  }

  const retryAfterTimestamp = Date.parse(retryAfter);

  if (Number.isNaN(retryAfterTimestamp)) {
    return fallbackDelayMs;
  }

  return Math.max(retryAfterTimestamp - Date.now(), 0);
}

function createRateLimitedFetchApi(
  token: string,
  options: Required<Pick<CreateYnabApiOptions, "fetchApi" | "rateLimiter" | "retryDelayMs" | "retryLimit">>,
) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    let attempt = 0;

    while (true) {
      await options.rateLimiter.acquire(token);
      const response = await options.fetchApi(input, init);

      if (response.status !== 429 || attempt >= options.retryLimit) {
        return response;
      }

      attempt += 1;
      await sleep(getRetryDelayMs(response, options.retryDelayMs));
    }
  };
}

export function createYnabApi(token = readYnabConfig(process.env).apiToken, options: CreateYnabApiOptions = {}) {
  const api = new ynab.API(token);
  const configuration = (api as any)._configuration;

  configuration.config = {
    ...configuration.configuration,
    fetchApi: createRateLimitedFetchApi(token, {
      fetchApi: options.fetchApi ?? fetch,
      rateLimiter: options.rateLimiter ?? sharedRateLimiter,
      retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      retryLimit: options.retryLimit ?? DEFAULT_RETRY_LIMIT,
    }),
  };

  if (!("moneyMovements" in api)) {
    Object.defineProperty(api, "moneyMovements", {
      configurable: true,
      enumerable: false,
      value: new ynab.MoneyMovementsApi((api as any)._configuration),
    });
  }

  return api;
}
