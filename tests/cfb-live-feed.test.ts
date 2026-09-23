import { describe, expect, it } from 'vitest';
import { handleCfbLive, handleCfbLiveSocket, handleCfbRelayIngest } from '../src/api/cfb-live';
import { acceptsSourceRevision, CfbWeekLiveFeed, stableStringify, validateBatch } from '../src/durable-objects/cfb-week-live-feed';

const batchBase = { schema: 'cfbd-relay:v1' as const, deliveryId: 'delivery-1', sentAt: new Date().toISOString(), season: 2026, seasonType: 'regular' as const, week: 1, sourceEpoch: 'epoch-1', events: [] };

describe('CfbWeekLiveFeed input contract', () => {
  it('accepts valid week identity and source epoch', () => {
    expect(validateBatch({ ...batchBase, events: [{ eventId: 'event-1', gameId: 'game-1', sourceRevision: 1, observedAt: new Date().toISOString(), payload: {} }] })).toEqual({ season: '2026', seasonType: 'regular', week: '1' });
  });
  it('rejects malformed or missing week identity', () => {
    expect(validateBatch({ ...batchBase, season: 26 })).toBeNull();
    expect(validateBatch({ season: 2026, seasonType: 'regular', week: 1 })).toBeNull();
  });
  it('rejects missing source epoch', () => expect(validateBatch({ ...batchBase, sourceEpoch: '' })).toBeNull());
  it('accepts reset revisions only when source epoch changes', () => {
    expect(acceptsSourceRevision('epoch-2', 9, 'epoch-3', 0, 'old', 'new')).toBe(true);
    expect(acceptsSourceRevision('epoch-3', 9, 'epoch-3', 0, 'old', 'new')).toBe(false);
  });
  it('canonicalizes object key order for stable hashes', () => expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}'));
  it('rejects non-canonical delivery and week values', () => {
    expect(validateBatch({ ...batchBase, deliveryId: 'short' })).toBeNull();
    expect(validateBatch({ ...batchBase, week: 100 })).toBeNull();
  });
  it('accepts first valid signed ingest into a fresh object and snapshots revision one', async () => {
    const deliveries: Array<{ delivery_id: string; nonce: string; received_at: number }> = [];
    const games = new Map<string, Record<string, unknown>>();
    const metadata = new Map<string, string>();
    const sql = {
      exec(query: string, ...args: unknown[]) {
        if (query.startsWith('SELECT delivery_id')) {
          const [deliveryId, nonce] = args;
          return { toArray: () => deliveries.filter(row => row.delivery_id === deliveryId || row.nonce === nonce) };
        }
        if (query.startsWith('SELECT source_epoch')) {
          return { toArray: () => games.has(args[0] as string) ? [games.get(args[0] as string)] : [] };
        }
        if (query.startsWith('SELECT value')) return { toArray: () => metadata.has(args[0] as string) ? [{ value: metadata.get(args[0] as string) }] : [] };
        if (query.startsWith('SELECT game_id')) return { toArray: () => [...games.values()] };
        if (query.startsWith('INSERT INTO deliveries')) {
          deliveries.push({ delivery_id: args[0] as string, nonce: args[1] as string, received_at: args[2] as number });
        } else if (query.startsWith('INSERT OR REPLACE INTO games')) {
          games.set(args[0] as string, { game_id: args[0], revision: args[1], source_epoch: args[2], source_revision: args[3], observed_at: args[4], hash: args[5], payload: args[6] });
        } else if (query.startsWith('INSERT OR REPLACE INTO feed_meta')) metadata.set(args[0] as string, args[1] as string);
        return { toArray: () => [] };
      },
    };
    const state = { blockConcurrencyWhile: (callback: () => Promise<void>) => callback(), storage: { sql, transactionSync: (callback: () => void) => callback() }, getWebSockets: () => [] } as any;
    const secret = 'test-secret';
    const batch = { ...batchBase, events: [{ eventId: 'event-1', gameId: 'game-1', sourceRevision: 1, observedAt: new Date().toISOString(), payload: { home: 'Nebraska' } }] };
    const body = JSON.stringify(batch);
    const timestamp = String(Math.floor(Date.now() / 1000)); const nonce = 'nonce-fresh-12345678';
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
    const hash = [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v1\nPOST\n/api/internal/cfbd/events\n${timestamp}\n${nonce}\n${hash}`)));
    const signature = `v1=${btoa(String.fromCharCode(...signed)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    const feed = new CfbWeekLiveFeed(state, { CFBD_RELAY_HMAC_SECRET: secret } as any);
    const ingest = await feed.fetch(new Request('https://example.test/ingest', { method: 'POST', body, headers: { 'X-Relay-Timestamp': timestamp, 'X-Relay-Nonce': nonce, 'X-Relay-Delivery': batch.deliveryId, 'X-Relay-Signature': signature } }));
    expect(ingest.status).toBe(200);
    expect(await ingest.json()).toMatchObject({ accepted: true, changed: true, revision: 1 });
    const snapshot = await feed.fetch(new Request('https://example.test/snapshot'));
    expect(await snapshot.json()).toMatchObject({ revision: 1, games: [batch.events[0].payload] });
  });
});

describe('Cfb live edge routing', () => {
  it('does not allocate a DO for public reads', async () => {
    const binding = { idFromName: () => { throw new Error('must not allocate'); }, get: () => { throw new Error('must not allocate'); } };
    const env = { CFB_WEEK_LIVE_FEED: binding } as any;
    expect((await handleCfbLive(new Request('https://example.test/api/cfb/live?season=2026&week=1'), env)).status).toBe(503);
    expect((await handleCfbLiveSocket(new Request('https://example.test/api/cfb/live?season=2026&week=1'), env)).status).toBe(503);
  });
  it('does not allocate for an inactive week when the registry is available', async () => {
    const binding = { idFromName: () => { throw new Error('must not allocate'); }, get: () => { throw new Error('must not allocate'); } };
    const env = { CFB_WEEK_LIVE_FEED: binding, CFB_SCHEDULE_CACHE: { get: async () => null } } as any;
    expect((await handleCfbLive(new Request('https://example.test/api/cfb/live?season=2026&week=1'), env)).status).toBe(404);
  });
  it('forwards validated production origin only for active WebSocket feeds', async () => {
    const forwarded: Request[] = [];
    const env = {
      CFB_ALLOWED_ORIGINS: 'https://rhule-aid.com',
      CFB_SCHEDULE_CACHE: { get: async () => '1' },
      CFB_WEEK_LIVE_FEED: {
        idFromName: () => ({}),
        get: () => ({ fetch: async (request: Request) => { forwarded.push(request); return new Response('ok'); } }),
      },
    } as any;
    const valid = new Request('https://rhule-aid.com/api/cfb-live/socket?season=2026&week=1', {
      headers: { Origin: 'https://rhule-aid.com', Upgrade: 'websocket', 'X-CFB-Trusted-Origin': 'https://attacker.test' },
    });
    expect((await handleCfbLiveSocket(valid, env)).status).toBe(200);
    expect(forwarded[0]?.headers.get('X-CFB-Trusted-Origin')).toBe('https://rhule-aid.com');
    expect((await handleCfbLiveSocket(new Request('https://rhule-aid.com/api/cfb-live/socket?season=2026&week=1', {
      headers: { Origin: 'https://attacker.test', Upgrade: 'websocket' },
    }), env)).status).toBe(403);
    expect(forwarded).toHaveLength(1);
  });
  it('verifies signatures against the public internal API path', async () => {
    const secret = 'test-secret';
    const body = JSON.stringify(batchBase);
    const timestamp = String(Math.floor(Date.now() / 1000)); const nonce = 'nonce-12345678';
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
    const hash = [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v1\nPOST\n/api/internal/cfbd/events\n${timestamp}\n${nonce}\n${hash}`)));
    const signature = `v1=${btoa(String.fromCharCode(...signed)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    const puts: unknown[][] = [];
    const env = { CFBD_RELAY_HMAC_SECRET: secret, CFB_SCHEDULE_CACHE: { put: async (...args: unknown[]) => { puts.push(args); } }, CFB_WEEK_LIVE_FEED: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response(JSON.stringify({ accepted: true })) }) } } as any;
    const request = new Request('https://example.test/api/internal/cfbd/events', { method: 'POST', body, headers: { 'X-Relay-Timestamp': timestamp, 'X-Relay-Nonce': nonce, 'X-Relay-Delivery': 'delivery-1', 'X-Relay-Signature': signature } });
    expect((await handleCfbRelayIngest(request, env)).status).toBe(200);
    expect(puts[0]).toEqual(['cfb-live-active:v1:2026:regular:1', '1', { expirationTtl: 3600 }]);
  });
});
