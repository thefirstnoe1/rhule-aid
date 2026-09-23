import { createHmac } from "node:crypto";
import { createHash, randomBytes } from "node:crypto";

export function createRequestAuth(body: string, secret: string, timestamp: string, nonce: string): string {
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const canonical = `v1\nPOST\n/api/internal/cfbd/events\n${timestamp}\n${nonce}\n${bodyHash}`;
  return `v1=${createHmac("sha256", secret).update(canonical, "utf8").digest("base64url")}`;
}

export function nonce(): string {
  return randomBytes(18).toString("base64url");
}
