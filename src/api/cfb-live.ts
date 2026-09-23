import type { Env } from '../types';
import { validateBatch } from '../durable-objects/cfb-week-live-feed';

type LiveFeedBinding = { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): DurableObjectStub };
type LiveFeedKey = { name: string; season: string; seasonType: string; week: string };
const MAX_BODY_BYTES = 1_048_576;
const MAX_CLOCK_SKEW_SECONDS = 300;
const LIVE_FEED_MARKER_TTL = 3600;
const LIVE_FEED_MARKER_PREFIX = 'cfb-live-active:v1:';
const TRUSTED_ORIGIN_HEADER = 'X-CFB-Trusted-Origin';
const encoder = new TextEncoder();

function key(url: URL): LiveFeedKey | null {
  const season = url.searchParams.get('season') || '';
  const seasonType = url.searchParams.get('seasonType') || 'regular';
  const week = url.searchParams.get('week') || '';
  if (!/^\d{4}$/.test(season) || !/^(regular|postseason|spring)$/.test(seasonType) || !/^\d{1,2}$/.test(week)) return null;
  const numericWeek = Number(week);
  if (!Number.isSafeInteger(numericWeek) || numericWeek < 1 || String(numericWeek) !== week) return null;
  return { season, seasonType, week, name: `${season}:${seasonType}:${week}` };
}

export function liveFeedActivationKey(season: string | number, seasonType: string, week: string | number): string | null {
  if (!/^\d{4}$/.test(String(season)) || !/^(regular|postseason|spring)$/.test(seasonType)) return null;
  const numericWeek = Number(week);
  if (!Number.isSafeInteger(numericWeek) || numericWeek < 1 || String(numericWeek) !== String(week)) return null;
  return `${LIVE_FEED_MARKER_PREFIX}${season}:${seasonType}:${numericWeek}`;
}

async function feedIsActive(env: Env, parsed: LiveFeedKey): Promise<boolean | null> {
  const marker = liveFeedActivationKey(parsed.season, parsed.seasonType, parsed.week);
  if (!marker || !env.CFB_SCHEDULE_CACHE) return null;
  try { return (await env.CFB_SCHEDULE_CACHE.get(marker)) !== null; } catch { return null; }
}

function inactiveResponse(active: boolean | null): Response {
  return active === false ? json({ error: 'live feed not active' }, 404) : json({ error: 'live feed unavailable' }, 503);
}

export async function handleCfbLive(request: Request, env: Env): Promise<Response> {
  const parsed = key(new URL(request.url));
  if (!parsed) return Response.json({ error: 'season, seasonType, and week are required' }, { status: 400 });
  const active = await feedIsActive(env, parsed);
  if (active !== true) return active === false ? inactiveResponse(active) : unavailableSnapshot();
  const binding = env.CFB_WEEK_LIVE_FEED as unknown as LiveFeedBinding;
  if (!binding) return unavailableSnapshot();
  return binding.get(binding.idFromName(parsed.name)).fetch(new Request(`https://cfb-live.internal/snapshot?season=${parsed.season}&seasonType=${parsed.seasonType}&week=${parsed.week}`, { headers: request.headers }));
}

export async function handleCfbLiveSocket(request: Request, env: Env): Promise<Response> {
  const externalOrigin = new URL(request.url).origin;
  const browserOrigin = request.headers.get('Origin');
  const allowedOrigins = configuredOrigins(env);
  if (browserOrigin && browserOrigin !== externalOrigin && !allowedOrigins.includes(browserOrigin)) return new Response('Forbidden', { status: 403 });
  const trustedOrigin = browserOrigin || externalOrigin;
  const headers = new Headers(request.headers);
  // Never pass through a client-supplied trust header.
  headers.delete(TRUSTED_ORIGIN_HEADER);
  headers.set(TRUSTED_ORIGIN_HEADER, trustedOrigin);
  const parsed = key(new URL(request.url));
  if (!parsed) return Response.json({ error: 'season, seasonType, and week are required' }, { status: 400 });
  const active = await feedIsActive(env, parsed);
  if (active !== true) return inactiveResponse(active);
  const binding = env.CFB_WEEK_LIVE_FEED as unknown as LiveFeedBinding;
  if (!binding) return inactiveResponse(null);
  return binding.get(binding.idFromName(parsed.name)).fetch(new Request(`https://cfb-live.internal/socket?season=${parsed.season}&seasonType=${parsed.seasonType}&week=${parsed.week}`, { method: request.method, headers }));
}

function configuredOrigins(env: Env): string[] {
  return (env.CFB_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
}

export async function handleCfbRelayIngest(request: Request, env: Env): Promise<Response> {
  const binding = env.CFB_WEEK_LIVE_FEED as unknown as LiveFeedBinding;
  if (!binding) return Response.json({ error: 'live feed unavailable' }, { status: 503 });
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) return json({ error: 'payload too large' }, 413);
  const raw = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!raw) return json({ error: 'payload too large' }, 413);
  const timestamp = request.headers.get('X-Relay-Timestamp');
  const nonce = request.headers.get('X-Relay-Nonce');
  const delivery = request.headers.get('X-Relay-Delivery') || request.headers.get('X-Relay-Delivery-Id');
  const signature = request.headers.get('X-Relay-Signature');
  if (!timestamp || !/^\d{1,20}$/.test(timestamp) || !nonce || !/^[-_A-Za-z0-9]{8,200}$/.test(nonce) || !delivery || !/^[A-Za-z0-9._-]{8,200}$/.test(delivery) || !signature || !/^v1=[A-Za-z0-9_-]{43}$/.test(signature)) return json({ error: 'invalid delivery headers' }, 401);
  const timestampNumber = Number(timestamp);
  if (!Number.isSafeInteger(timestampNumber) || Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > MAX_CLOCK_SKEW_SECONDS) return json({ error: 'stale delivery' }, 401);
  if (!env.CFBD_RELAY_HMAC_SECRET) return json({ error: 'ingest unavailable' }, 503);
  const bodyHash = await sha256Hex(raw);
  const signingString = `v1\nPOST\n/api/internal/cfbd/events\n${timestamp}\n${nonce}\n${bodyHash}`;
  const expected = `v1=${await hmacBase64Url(env.CFBD_RELAY_HMAC_SECRET, signingString)}`;
  if (!constantTimeEqual(signature, expected)) return json({ error: 'invalid signature' }, 401);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch { return json({ error: 'invalid JSON' }, 400); }
  const batch = body as Parameters<typeof validateBatch>[0];
  const key = validateBatch(batch);
  if (!key || batch.deliveryId !== delivery) return json({ error: 'invalid batch basics' }, 400);
  // Raw bytes and authenticated headers remain intact for DO defense-in-depth verification.
  const canonical = liveFeedActivationKey(key.season, key.seasonType, key.week);
  if (!canonical) return json({ error: 'invalid batch basics' }, 400);
  const response = await binding.get(binding.idFromName(`${key.season}:${key.seasonType}:${key.week}`)).fetch(new Request('https://cfb-live.internal/ingest', { method: 'POST', body: raw, headers: request.headers }));
  if (response.ok && env.CFB_SCHEDULE_CACHE) {
    try {
      const result = await response.clone().json() as { accepted?: boolean };
      if (result.accepted === true) await env.CFB_SCHEDULE_CACHE.put(canonical, '1', { expirationTtl: LIVE_FEED_MARKER_TTL });
    } catch { /* marker failure must not change committed ingest response */ }
  }
  return response;
}

async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', value));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left); const b = encoder.encode(right); let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index % (a.length || 1)] ?? 0) ^ (b[index % (b.length || 1)] ?? 0);
  return difference === 0;
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function unavailableSnapshot(): Response { return json({ revision: 0, games: [], lastUpdated: '', unavailable: true }, 503); }
