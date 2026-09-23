import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeScoreboard } from "../src/normalize.js";
import { Outbox } from "../src/outbox.js";
import { createRequestAuth } from "../src/sign.js";
import { flush } from "../src/delivery.js";
import type { Config } from "../src/config.js";
import type { RelayBatch } from "../src/normalize.js";

test("normalizes scoreboard and assigns revisions", () => {
  const revisions = new Map<string, number>();
  const next = (id: string) => { const n = (revisions.get(id) ?? 0) + 1; revisions.set(id, n); return n; };
  const batch = normalizeScoreboard({ data: { scoreboard: [{ id: 42, status: "live" }] } }, next, 2026, "regular", 1, "epoch", new Date("2026-01-01T00:00:00.000Z"));
  assert.equal(batch.schema, "cfbd-relay:v1"); assert.equal(batch.sourceEpoch, "epoch"); assert.equal(batch.events[0]?.sourceRevision, 1); assert.equal(batch.events[0]?.gameId, "42"); assert.equal(batch.events[0]?.eventId, "42:1");
});
test("revisions persist and body signature is exact", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-")); const db = new Outbox(dir);
  assert.equal(db.nextRevision("g"), 1); assert.equal(db.nextRevision("g"), 2);
  assert.equal(db.sourceEpoch, db.sourceEpoch);
  const body = '{"a":1}'; assert.equal(createRequestAuth(body, "secret", "1700000000", "abc"), "v1=CfC_HKD7SBL8w9DyjIIQOUWzs0l3Fm7aGSQDnRc8dyA");
  db.close(); rmSync(dir, { recursive: true, force: true });
});

test("removes explicit duplicate 409 but preserves other conflicts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const db = new Outbox(dir);
  const batch = (deliveryId: string): RelayBatch => ({ schema: "cfbd-relay:v1", deliveryId, sentAt: new Date().toISOString(), season: 2026, seasonType: "regular", week: 1, sourceEpoch: "epoch", events: [] });
  db.enqueue(batch("a-replayed-1"));
  db.enqueue(batch("b-conflict-1"));
  const config: Config = { cfbdKey: "key", targetUrl: "https://example.invalid/api/internal/cfbd/events", hmacSecret: "secret", dataDir: dir, season: 2026, seasonType: "regular", week: 1 };
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => ({ ok: false, status: 409, text: async () => requests++ === 0 ? JSON.stringify({ error: "replayed delivery" }) : JSON.stringify({ error: "conflict" }) }) as Response;
  try {
    await flush(db, config);
    assert.deepEqual(db.pending().map((row) => row.batchId), ["b-conflict-1"]);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
