import type { Config } from "./config.js";
import { Outbox } from "./outbox.js";
import { createRequestAuth, nonce } from "./sign.js";

const locks = new WeakMap<Outbox, Promise<void>>();
const maxAttempts = 3;
const timeoutMs = 10_000;

async function isExplicitDuplicate409(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  try {
    const body: unknown = JSON.parse(await response.text());
    if (!body || typeof body !== "object") return false;
    const error = (body as { error?: unknown }).error;
    return error === "replayed delivery" || error === "duplicate delivery";
  } catch {
    return false;
  }
}

async function runFlush(outbox: Outbox, config: Config): Promise<void> {
  for (const row of outbox.pending()) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const requestNonce = nonce();
        const response = await fetch(config.targetUrl, {
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            "Content-Type": "application/json",
            ...(config.keyId ? { "X-Relay-Key-Id": config.keyId } : {}),
            "X-Relay-Timestamp": timestamp,
            "X-Relay-Nonce": requestNonce,
            "X-Relay-Delivery-Id": row.batchId,
            "X-Relay-Signature": createRequestAuth(row.body, config.hmacSecret, timestamp, requestNonce),
          },
          body: row.body,
        });
        outbox.attempted(row.batchId);
        if (response.ok) {
          outbox.remove(row.batchId);
          break;
        }
        const duplicate = await isExplicitDuplicate409(response);
        if (duplicate) {
          outbox.remove(row.batchId);
          break;
        }
        if (response.status < 500) break;
      } catch {
        outbox.attempted(row.batchId);
      }
      if (attempt + 1 < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

export function flush(outbox: Outbox, config: Config): Promise<void> {
  const previous = locks.get(outbox) ?? Promise.resolve();
  const current = previous.then(() => runFlush(outbox, config), () => runFlush(outbox, config));
  locks.set(outbox, current);
  return current.finally(() => { if (locks.get(outbox) === current) locks.delete(outbox); });
}
