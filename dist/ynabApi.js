import * as ynab from "ynab";
import { readYnabConfig } from "./config.js";
import { createYnabRateLimiter } from "./ynabRateLimiter.js";
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_RETRY_LIMIT = 1;
const sharedRateLimiter = createYnabRateLimiter();
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
function getRetryDelayMs(response, fallbackDelayMs) {
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
function createRateLimitedFetchApi(token, options) {
    return async (input, init) => {
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
export function createYnabApi(token = readYnabConfig(process.env).apiToken, options = {}) {
    const api = new ynab.API(token);
    const configuration = api._configuration;
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
            value: new ynab.MoneyMovementsApi(api._configuration),
        });
    }
    return api;
}
