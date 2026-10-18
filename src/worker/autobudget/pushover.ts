import type { WorkerEnv } from "../env.js";
import { truncate, MAX_MESSAGE_LENGTH } from "./alerts.js";

const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
const MAX_TITLE_LENGTH = 250;

export type Delivery = "sent" | "not_configured";

/**
 * Sends one notification through Pushover. Without both secrets nothing is
 * sent. The credentials go only in the request body and are never logged.
 */
export async function sendPushover(
  env: Pick<WorkerEnv, "PUSHOVER_APP_TOKEN" | "PUSHOVER_USER_KEY">,
  notification: { title: string; message: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Delivery> {
  if (!env.PUSHOVER_APP_TOKEN || !env.PUSHOVER_USER_KEY) return "not_configured";

  const response = await fetchImpl(PUSHOVER_URL, {
    method: "POST",
    body: new URLSearchParams({
      token: env.PUSHOVER_APP_TOKEN,
      user: env.PUSHOVER_USER_KEY,
      title: truncate(notification.title, MAX_TITLE_LENGTH),
      message: truncate(notification.message, MAX_MESSAGE_LENGTH),
    }),
  });
  if (!response.ok) throw new Error(`Pushover returned HTTP ${response.status}`);
  return "sent";
}
