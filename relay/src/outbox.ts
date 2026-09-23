import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RelayBatch } from "./normalize.js";

export interface OutboxRow { batchId: string; body: string; attempts: number; }

export class Outbox {
  readonly db: Database.Database;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "relay.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS game_revisions (game_id TEXT PRIMARY KEY, revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS outbox (batch_id TEXT PRIMARY KEY, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);");
    this.db.exec("CREATE TABLE IF NOT EXISTS relay_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    this.db.prepare("INSERT OR IGNORE INTO relay_metadata(key, value) VALUES('source_epoch', ?)").run(crypto.randomUUID());
  }
  get sourceEpoch(): string { return (this.db.prepare("SELECT value FROM relay_metadata WHERE key = 'source_epoch'").get() as { value: string }).value; }
  nextRevision(gameId: string): number {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare("SELECT revision FROM game_revisions WHERE game_id = ?").get(gameId) as { revision: number } | undefined;
      const revision = (row?.revision ?? 0) + 1;
      this.db.prepare("INSERT INTO game_revisions(game_id, revision) VALUES(?, ?) ON CONFLICT(game_id) DO UPDATE SET revision=excluded.revision").run(gameId, revision);
      return revision;
    });
    return tx();
  }
  enqueue(batch: RelayBatch): void { this.db.prepare("INSERT OR IGNORE INTO outbox(batch_id, body, created_at) VALUES(?, ?, ?)").run(batch.deliveryId, JSON.stringify(batch), batch.sentAt); }
  pending(): OutboxRow[] { return this.db.prepare("SELECT batch_id AS batchId, body, attempts FROM outbox ORDER BY created_at, batch_id").all() as OutboxRow[]; }
  attempted(batchId: string): void { this.db.prepare("UPDATE outbox SET attempts = attempts + 1 WHERE batch_id = ?").run(batchId); }
  remove(batchId: string): void { this.db.prepare("DELETE FROM outbox WHERE batch_id = ?").run(batchId); }
  close(): void { this.db.close(); }
}
