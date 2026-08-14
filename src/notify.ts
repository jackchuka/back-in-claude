import type { Notification } from "./types.ts";

export type NotifyOptions = {
  readonly topic: string;
  readonly email: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
};

/**
 * Deliver one notification via ntfy. A single POST reaches both the phone
 * (push) and email, which is why ntfy was chosen over wiring SMTP separately.
 *
 * Throws on failure: a lost notification is the whole product failing, so it
 * should surface as a red workflow run rather than pass quietly.
 */
export async function notify(
  notification: Notification,
  { topic, email, fetchImpl = fetch, timeoutMs = 10_000 }: NotifyOptions,
): Promise<void> {
  if (!topic) throw new Error("ntfy topic is not configured");

  const headers: Record<string, string> = {
    Title: notification.title,
    Priority: notification.priority,
    Tags: notification.tags,
  };
  if (email) headers["X-Email"] = email;

  const res = await fetchImpl(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers,
    body: notification.message,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw new Error(`ntfy POST failed with status ${res.status}`);
}
