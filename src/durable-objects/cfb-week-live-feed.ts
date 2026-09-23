import type { Env } from '../types';

const MAX_BODY_BYTES = 1_048_576;
const MAX_EVENTS = 500;
const MAX_CLOCK_SKEW_SECONDS = 300;
const TRUSTED_ORIGIN_HEADER = 'X-CFB-Trusted-Origin';
const SAFE_EXTERNAL_ORIGIN = 'https://rhule-aid.com';
const textEncoder = new TextEncoder();

interface FeedKey { season: string; seasonType: string; week: string }
interface RelayEvent { eventId: string; gameId: string; sourceRevision: number; observedAt: string; payload: unknown }
interface RelayBatch { schema: 'cfbd-relay:v1'; deliveryId: string; sentAt: string; season: number; seasonType: string; week: number; sourceEpoch: string; events: RelayEvent[] }

export class CfbWeekLiveFeed {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.state.blockConcurrencyWhile(async () => {
      this.state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS feed_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      this.state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS deliveries (delivery_id TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE, received_at INTEGER NOT NULL);`);
      this.state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS games (game_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, source_epoch TEXT NOT NULL DEFAULT '', source_revision INTEGER NOT NULL, observed_at TEXT NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL);`);
      // Compatibility with the first unreleased schema.
      try { this.state.storage.sql.exec('ALTER TABLE games ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      try { this.state.storage.sql.exec('ALTER TABLE games ADD COLUMN source_epoch TEXT NOT NULL DEFAULT ""'); } catch { /* exists */ }
      try { this.state.storage.sql.exec('ALTER TABLE games ADD COLUMN observed_at TEXT NOT NULL DEFAULT ""'); } catch { /* exists */ }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/ingest' && request.method === 'POST') return this.ingest(request);
    if (path === '/snapshot' && request.method === 'GET') return this.snapshot(request);
    if (path === '/socket' && request.method === 'GET') return this.socket(request);
    return new Response('Not Found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const value = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) as { type?: string };
      if (value.type === 'ping') ws.send(JSON.stringify({ type: 'pong', revision: this.revision() }));
      else if (value.type === 'hello') ws.send(JSON.stringify({ type: 'hello', revision: this.revision() }));
      else ws.send(JSON.stringify({ type: 'error', error: 'read-only socket; hello or ping required' }));
    } catch { ws.close(1003, 'invalid message'); }
  }
  async webSocketClose(ws: WebSocket): Promise<void> { ws.close(); }
  async webSocketError(ws: WebSocket): Promise<void> { ws.close(1011, 'socket error'); }

  private async ingest(request: Request): Promise<Response> {
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength > MAX_BODY_BYTES) return json({ error: 'payload too large' }, 413);
    const timestamp = request.headers.get('X-Relay-Timestamp');
    const nonce = request.headers.get('X-Relay-Nonce');
    const headerDelivery = request.headers.get('X-Relay-Delivery') || request.headers.get('X-Relay-Delivery-Id');
    const signature = request.headers.get('X-Relay-Signature') || '';
    if (!timestamp || !/^\d{1,20}$/.test(timestamp) || !nonce || !/^[-_A-Za-z0-9]{8,200}$/.test(nonce) || !headerDelivery || !/^[A-Za-z0-9._-]{8,200}$/.test(headerDelivery) || !/^v1=[A-Za-z0-9_-]{43}$/.test(signature)) return json({ error: 'invalid delivery headers' }, 401);
    const timestampNumber = Number(timestamp);
    if (!Number.isSafeInteger(timestampNumber) || Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > MAX_CLOCK_SKEW_SECONDS) return json({ error: 'stale delivery' }, 401);
    if (!this.env.CFBD_RELAY_HMAC_SECRET) return json({ error: 'ingest unavailable' }, 503);
    const bodyHash = await sha256Hex(raw);
    const signingString = `v1\nPOST\n/api/internal/cfbd/events\n${timestamp}\n${nonce}\n${bodyHash}`;
    const expected = await hmacBase64Url(this.env.CFBD_RELAY_HMAC_SECRET, signingString);
    if (!constantTimeEqual(signature, `v1=${expected}`)) return json({ error: 'invalid signature' }, 401);
    let batch: RelayBatch;
    try { batch = JSON.parse(new TextDecoder().decode(raw)) as RelayBatch; } catch { return json({ error: 'invalid JSON' }, 400); }
    const key = validateBatch(batch);
    if (!key || batch.deliveryId !== headerDelivery) return json({ error: 'invalid batch basics' }, 400);
    if (this.state.storage.sql.exec('SELECT delivery_id FROM deliveries WHERE delivery_id = ? OR nonce = ?', batch.deliveryId, nonce).toArray().length) return json({ error: 'replayed delivery' }, 409);

    const oldRevision = this.revision();
    const changedRows: Array<[string, number, string, string]> = [];
    const changedEvents = new Map<string, RelayEvent>();
    for (const event of batch.events) {
      const current = this.state.storage.sql.exec('SELECT source_epoch, source_revision, hash FROM games WHERE game_id = ?', event.gameId).toArray()[0] as { source_epoch?: string; source_revision?: number; hash?: string } | undefined;
      const hash = await sha256Hex(textEncoder.encode(stableStringify(event.payload)));
      const previous = changedEvents.get(event.gameId);
      if (previous && previous.sourceRevision === event.sourceRevision && (await sha256Hex(textEncoder.encode(stableStringify(previous.payload)))) !== hash) return json({ error: 'source revision conflict' }, 409);
      if (current && current.source_epoch === batch.sourceEpoch && current.source_revision === event.sourceRevision && current.hash !== hash) return json({ error: 'source revision conflict' }, 409);
      if (acceptsSourceRevision(current?.source_epoch, current?.source_revision, batch.sourceEpoch, event.sourceRevision, current?.hash, hash) && (!previous || previous.sourceRevision < event.sourceRevision)) changedEvents.set(event.gameId, event);
    }
    for (const event of changedEvents.values()) {
      changedRows.push([event.gameId, event.sourceRevision, event.observedAt, await sha256Hex(textEncoder.encode(stableStringify(event.payload)))]);
    }
    const revision = changedRows.length ? oldRevision + 1 : oldRevision;
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec('INSERT INTO deliveries (delivery_id, nonce, received_at) VALUES (?, ?, ?)', batch.deliveryId, nonce, Date.now());
      this.state.storage.sql.exec('DELETE FROM deliveries WHERE received_at < ?', Date.now() - 7 * 24 * 60 * 60 * 1000);
      this.state.storage.sql.exec('DELETE FROM deliveries WHERE delivery_id IN (SELECT delivery_id FROM deliveries ORDER BY received_at DESC LIMIT -1 OFFSET 10000)');
      if (!changedRows.length) return;
      for (const event of changedEvents.values()) {
        const row = changedRows.find(candidate => candidate[0] === event.gameId);
        if (row) this.state.storage.sql.exec('INSERT OR REPLACE INTO games (game_id, revision, source_epoch, source_revision, observed_at, hash, payload) VALUES (?, ?, ?, ?, ?, ?, ?)', event.gameId, revision, batch.sourceEpoch, event.sourceRevision, event.observedAt, row[3], JSON.stringify(event.payload));
      }
      this.state.storage.sql.exec('INSERT OR REPLACE INTO feed_meta (key, value) VALUES (?, ?)', 'revision', String(revision));
      this.state.storage.sql.exec('INSERT OR REPLACE INTO feed_meta (key, value) VALUES (?, ?)', 'key', JSON.stringify(key));
      this.state.storage.sql.exec('INSERT OR REPLACE INTO feed_meta (key, value) VALUES (?, ?)', 'source_epoch', batch.sourceEpoch);
    });
    if (changedRows.length) {
      const message = JSON.stringify({ type: 'schedule_changed', revision });
      for (const ws of this.state.getWebSockets()) try { ws.send(message); } catch { ws.close(); }
    }
    return json({ accepted: true, changed: changedRows.length > 0, revision });
  }

  private async snapshot(request: Request): Promise<Response> {
    const rows = this.state.storage.sql.exec('SELECT game_id, source_revision, observed_at, payload, hash FROM games ORDER BY game_id').toArray() as Array<{ game_id: string; source_revision: number; observed_at: string; payload: string; hash: string }>;
    const body = { revision: this.revision(), games: rows.map(row => JSON.parse(row.payload)), lastUpdated: rows.reduce((latest, row) => row.observed_at > latest ? row.observed_at : latest, '') };
    const etag = `"${await sha256Hex(textEncoder.encode(stableStringify(body)))}"`;
    const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ETag: etag });
    if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
    return new Response(JSON.stringify(body), { headers });
  }

  private socket(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Upgrade Required', { status: 426 });
    const origin = request.headers.get(TRUSTED_ORIGIN_HEADER);
    const allowed = (this.env.CFB_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
    const safeOrigins = allowed.length ? allowed : [SAFE_EXTERNAL_ORIGIN];
    if (!origin || !safeOrigins.includes(origin)) return new Response('Forbidden', { status: 403 });
    const pair = new WebSocketPair(); this.state.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: 'hello', revision: this.revision() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private revision(): number { return Number((this.state.storage.sql.exec('SELECT value FROM feed_meta WHERE key = ?', 'revision').toArray()[0] as { value?: string } | undefined)?.value || 0); }
}

export function validateBatch(batch: Partial<RelayBatch>): FeedKey | null {
  const season = String(batch.season ?? ''); const seasonType = String(batch.seasonType ?? ''); const week = String(batch.week ?? '');
  if (batch.schema !== 'cfbd-relay:v1' || !/^[A-Za-z0-9._-]{8,200}$/.test(batch.deliveryId || '') || !/^[A-Za-z0-9._-]{1,200}$/.test(batch.sourceEpoch || '') || !Number.isFinite(Date.parse(batch.sentAt || '')) || !/^\d{4}$/.test(season) || !/^(regular|postseason|spring)$/.test(seasonType) || !/^\d{1,2}$/.test(week) || !Array.isArray(batch.events) || batch.events.length > MAX_EVENTS) return null;
  if (batch.events.some(event => !event || !/^[A-Za-z0-9._-]{1,200}$/.test(event?.eventId || '') || !/^[A-Za-z0-9._-]{1,200}$/.test(event?.gameId || '') || !Number.isSafeInteger(event?.sourceRevision) || (event?.sourceRevision ?? -1) < 0 || !Number.isFinite(Date.parse(event?.observedAt || '')) || event?.payload === undefined)) return null;
  return { season, seasonType, week };
}
export function acceptsSourceRevision(currentEpoch: string | undefined, currentRevision: number | undefined, batchEpoch: string, eventRevision: number, currentHash: string | undefined, eventHash: string): boolean {
  if (currentEpoch !== batchEpoch) return true;
  return (currentRevision ?? -1) < eventRevision && currentHash !== eventHash;
}
export function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value); }
async function sha256Hex(value: Uint8Array): Promise<string> { const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', value)); return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
async function hmacBase64Url(secret: string, value: string): Promise<string> { const cryptoKey = await crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, textEncoder.encode(value))); return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function constantTimeEqual(left: string, right: string): boolean { const a = textEncoder.encode(left); const b = textEncoder.encode(right); let difference = a.length ^ b.length; for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index % (a.length || 1)] ?? 0) ^ (b[index % (b.length || 1)] ?? 0); return difference === 0; }
