// Schedule API for Cloudflare Worker
import { client, getGames, getMedia } from 'cfbd';
import { selectPayload, type CacheEnvelope } from '../lib/cache-envelope';
import { createFreshnessMetadata } from '../lib/response-freshness';
import { emitCacheEvent } from '../lib/structured-event-log';
import { readRetainedScheduleCache } from '../lib/schedule-cache';
import type { CanonicalScheduleGame, ProviderState, ProviderStates } from '../contracts/gameday';

const SCHEDULE_CACHE_SCHEMA = 'v9';
const CACHE_TTL = 60 * 60 * 6;
const CACHE_RETAIN_TTL = 60 * 60 * 24 * 7;
const PROVIDER_DEADLINE_MS = 8_000;
const REFRESH_BACKOFF_MS = 30_000;
const REFRESH_LEASE_MS = 15_000;
const KV_MIN_TTL_SECONDS = 60;

type ScheduleGame = CanonicalScheduleGame;

interface ScheduleResponse {
  success: boolean;
  data: ScheduleGame[];
  cached: boolean;
  lastUpdated: string;
  source: string;
  count?: number;
  nextRefresh?: string;
  stale?: boolean;
  error?: string;
  season?: number;
  meta?: {
    dataUpdatedAt: string | null;
    servedAt: string;
    cacheMode: 'network' | 'fresh-cache' | 'stale-cache' | 'miss';
    stale: boolean;
    sourceState: 'live' | 'fresh-cache' | 'stale-cache' | 'unavailable';
    providers: ProviderStates;
    sources: { cfbdGames: ProviderState; cfbdMedia: ProviderState; huskers: ProviderState; espn: ProviderState };
  };
}

type CachedData = CacheEnvelope<ScheduleGame[]> & { source: string; season: number; schema?: string; providers?: ProviderStates };

interface HuskerScheduleOverride {
  opponent: string;
  date: string;
  time: string;
  location?: string;
  network: string;
  opponentLogo?: string;
  kickoffAt?: string;
  kickoffStatus?: 'confirmed' | 'tba';
}

interface HuskerFetchResult {
  overrides: Map<string, HuskerScheduleOverride>;
  state: ProviderState;
}

const HUSKERS_FOOTBALL_SCHEDULE_ID = 242;

export async function handleScheduleRequest(request: Request, env: any): Promise<Response> {
  const url = new URL(request.url);
  const season = getRequestedSeason(url);
  const CACHE_KEY = `nebraska_schedule_${season}_cfbd_huskers_${SCHEDULE_CACHE_SCHEMA}`;
  const startedAt = Date.now();
  const requestId = request.headers.get('cf-ray') || crypto.randomUUID();
  
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Request-ID': requestId,
  };

  if (request.method === 'OPTIONS') {
    return finishResponse(new Response(null, { headers: corsHeaders }), requestId, startedAt, 'miss', 'unavailable', 0);
  }

  const respond = (body: ScheduleResponse, status: number, cacheMode: 'network' | 'fresh-cache' | 'stale-cache' | 'miss', sourceState: 'live' | 'fresh-cache' | 'stale-cache' | 'unavailable', cacheControl: string) => {
    const response = new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Cache-Control': cacheControl } });
    return finishResponse(response, requestId, startedAt, cacheMode, sourceState, body.data.length);
  };

  let cachedData: CachedData | null = null;
  let refreshLease = false;
  let providerStates: ProviderStates = {
    cfbdGames: 'skipped', cfbdMedia: 'skipped', huskers: 'skipped', espn: 'skipped',
  };
  try {
    // Check for cached data
    if (env.SCHEDULE_CACHE) {
      cachedData = await readRetainedScheduleCache(env.SCHEDULE_CACHE, CACHE_KEY, SCHEDULE_CACHE_SCHEMA) as CachedData | null;
    }
    
    // Return cached data if still valid
    const selected = selectPayload<ScheduleGame[]>(cachedData);
    if (selected.state === 'fresh') {
      const servedAt = Date.now();
      const response: ScheduleResponse = {
        success: true,
        data: selected.payload,
        cached: true,
        lastUpdated: new Date(selected.envelope.dataUpdatedAt).toISOString(),
        source: cachedData?.source || 'cfbd-api',
        count: selected.payload.length,
        nextRefresh: new Date(selected.envelope.freshUntil).toISOString(),
        season,
        stale: false,
        meta: createScheduleMeta(selected.envelope.dataUpdatedAt, servedAt, 'fresh-cache', 'fresh-cache', getProviderStates(cachedData?.providers || providerStates))
      };
      return respond(response, 200, 'fresh-cache', 'fresh-cache', 'public, max-age=3600');
    }

    const staleSelection = selectPayload<ScheduleGame[]>(cachedData);
    if (staleSelection.state === 'stale' && env.SCHEDULE_CACHE) {
      const retryKey = `${CACHE_KEY}:retry`;
      const leaseKey = `${CACHE_KEY}:lease`;
      const retryUntil = await readNumber(env.SCHEDULE_CACHE, retryKey);
      if (retryUntil > Date.now() || !(await claimLease(env.SCHEDULE_CACHE, leaseKey))) {
        return staleResponse(staleSelection, cachedData, respond, getProviderStates(cachedData?.providers || providerStates));
      }
      refreshLease = true;
    }

    if (!env.CFBD_API_KEY) {
      throw new Error('CFBD_API_KEY is not configured');
    }

    // Fetch fresh data from College Football Data
    const dataSource = 'cfbd-api';
    let scheduleData: ScheduleGame[] = [];

    client.setConfig({
      headers: {
        Authorization: `Bearer ${env.CFBD_API_KEY}`
      }
    });

    const [cfbdResult, mediaResult, huskerResult, espnResult] = await Promise.all([
      withDeadline(getGames({
        query: {
          year: season,
          seasonType: 'regular',
          team: 'Nebraska'
        }
      } as any), PROVIDER_DEADLINE_MS, 'CFBD games').catch((error) => ({ error })),
      withDeadline(getMedia({
        query: {
          year: season,
          seasonType: 'regular',
          team: 'Nebraska',
          mediaType: 'tv'
        }
      } as any), PROVIDER_DEADLINE_MS, 'CFBD media').catch((error) => ({ error })),
      withDeadline(fetchHuskerScheduleOverrides(season), PROVIDER_DEADLINE_MS, 'Huskers').catch((error) => ({ overrides: new Map<string, HuskerScheduleOverride>(), state: isTimeout(error) ? 'timeout' as const : 'error' as const })),
      withDeadline(fetchEspnSchedule(season), PROVIDER_DEADLINE_MS, 'ESPN').catch((error) => ({ state: isTimeout(error) ? 'timeout' as const : 'error' as const, events: [] as any[] }))
    ]);

    if (hasProviderError(cfbdResult) || !isProviderPayload(cfbdResult)) {
      if (hasProviderError(cfbdResult)) {
        const providerError = (cfbdResult as any).error;
        providerStates.cfbdGames = isTimeout(providerError)
          ? 'timeout'
          : 'error';
        throw new Error(providerStates.cfbdGames === 'timeout'
          ? 'CFBD provider timeout'
          : 'CFBD upstream error');
      }
      providerStates.cfbdGames = 'invalid';
      throw new Error('CFBD games response invalid');
    }
    providerStates.cfbdGames = 'live';

    const cfbdGames = (cfbdResult as any).data as any[];
    const cfbdMedia = hasProviderError(mediaResult) || !isProviderPayload(mediaResult) ? [] : (mediaResult as any).data as any[];
    providerStates.cfbdMedia = hasProviderError(mediaResult) ? (isTimeout((mediaResult as any).error) ? 'timeout' : 'error') : (isProviderPayload(mediaResult) ? 'live' : 'invalid');
    if (!Array.isArray(cfbdGames)) throw new Error('CFBD games response invalid');
    const mediaByGame = createMediaLookup(cfbdMedia);
    const parsedGames = parseCFBDSchedule(cfbdGames, mediaByGame, season);
    if (cfbdGames.length > 0 && parsedGames.length === 0) throw new Error('CFBD returned no valid regular-season games');
    providerStates.huskers = huskerResult.state;
    providerStates.espn = espnResult.state;
    scheduleData = applyHuskerOverrides(parsedGames, huskerResult.overrides);
    scheduleData = preserveRetainedSourceFields(scheduleData, cachedData?.payload, providerStates);
    if (espnResult.state === 'live') {
      scheduleData = applyEspnScheduleFields(scheduleData, espnResult.events);
    } else {
      scheduleData = preserveRetainedSourceFields(scheduleData, cachedData?.payload, providerStates);
      scheduleData = preserveEspnAdvisoryIds(scheduleData, cachedData?.payload);
    }
    console.log(`Fetched ${scheduleData.length} games from CFBD API for ${season}`);
    
    // Cache the fresh data
    const dataUpdatedAt = Date.now();
    if (env.SCHEDULE_CACHE) {
      try {
        const cacheData: CachedData = {
          payload: scheduleData,
          dataUpdatedAt,
          freshUntil: dataUpdatedAt + CACHE_TTL * 1000,
          retainUntil: dataUpdatedAt + CACHE_RETAIN_TTL * 1000,
          source: dataSource,
          season,
          providers: providerStates,
          schema: SCHEDULE_CACHE_SCHEMA,
        };
        
        await env.SCHEDULE_CACHE.put(CACHE_KEY, JSON.stringify(cacheData), { 
          expirationTtl: CACHE_RETAIN_TTL
        });
      } catch (error) {
        console.error('Cache write error:', safeError(error));
      }
    }

    const servedAt = Date.now();
    const response: ScheduleResponse = {
      success: true,
      data: scheduleData,
      cached: false,
      lastUpdated: new Date(dataUpdatedAt).toISOString(),
      source: dataSource,
      count: scheduleData.length,
      nextRefresh: new Date(dataUpdatedAt + CACHE_TTL * 1000).toISOString(),
      season,
      stale: false,
      meta: createScheduleMeta(dataUpdatedAt, servedAt, 'network', 'live', providerStates)
    };
    return respond(response, 200, 'network', 'live', 'public, max-age=3600');
    
  } catch (error) {
    console.error('Schedule handler error:', safeError(error));
    if (refreshLease && env.SCHEDULE_CACHE) {
      await writeRetryBackoff(env.SCHEDULE_CACHE, `${CACHE_KEY}:retry`);
    }
    
    const stale = selectPayload<ScheduleGame[]>(cachedData);
    if (stale.state === 'stale') {
      const servedAt = Date.now();
      return staleResponse(stale, cachedData, respond, providerStates);
    }
    const response: ScheduleResponse = {
      success: false,
      data: [],
      cached: false,
      source: 'cfbd-api',
      lastUpdated: new Date().toISOString(),
      error: safeError(error), season,
      stale: false,
      meta: createScheduleMeta(null, Date.now(), 'miss', 'unavailable', providerStates)
    };
    
    return respond(response, 502, 'miss', 'unavailable', 'no-store');
  }
}

function finishResponse(response: Response, requestId: string, startedAt: number, cacheMode: 'network' | 'fresh-cache' | 'stale-cache' | 'miss', sourceState: 'live' | 'fresh-cache' | 'stale-cache' | 'unavailable', resultCount: number): Response {
  emitCacheEvent({ requestId, source: `schedule:${sourceState}`, latencyMs: Date.now() - startedAt, cacheMode, resultCount, status: response.status }, (event) => console.log(JSON.stringify(event)));
  return response;
}

function createScheduleMeta(dataUpdatedAt: number | null, servedAt: number, cacheMode: 'network' | 'fresh-cache' | 'stale-cache' | 'miss', sourceState: 'live' | 'fresh-cache' | 'stale-cache' | 'unavailable', providers: ProviderStates): NonNullable<ScheduleResponse['meta']> {
  if (dataUpdatedAt === null) {
    return { dataUpdatedAt: null, servedAt: new Date(servedAt).toISOString(), cacheMode, stale: false, sourceState, providers, sources: providers };
  }
  const metadata = createFreshnessMetadata({ dataUpdatedAt, servedAt, cacheMode, sourceState }, servedAt);
  return {
    ...metadata,
    dataUpdatedAt: new Date(metadata.dataUpdatedAt).toISOString(),
    servedAt: new Date(metadata.servedAt).toISOString(),
    providers,
    sources: providers,
  };
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} provider timeout`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface EspnFetchResult {
  state: ProviderState;
  events: any[];
}

async function fetchEspnSchedule(season: number): Promise<EspnFetchResult> {
  const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/158/schedule?season=${season}`);
  if (!response.ok) {
    throw new Error(`ESPN schedule API failed: ${response.status}`);
  }

  const payload = await response.json() as any;
  if (!payload || !Array.isArray(payload.events)) {
    return { state: 'invalid', events: [] };
  }

  return { state: 'live', events: payload.events };
}

function applyEspnAdvisoryIds(games: ScheduleGame[], events: any[]): ScheduleGame[] {
  return games.map((game) => {
    const matches = events
      .map((event) => getEspnEventMatch(event, game))
      .filter((eventId): eventId is string => eventId !== undefined);
    const espnId = matches.length === 1 ? matches[0] : undefined;
    return {
      ...game,
      ...(espnId !== undefined
        ? { providerIds: { ...(game.providerIds?.cfbd ? { cfbd: game.providerIds.cfbd } : {}), espn: espnId } }
        : game.providerIds?.cfbd ? { providerIds: { cfbd: game.providerIds.cfbd } } : {}),
    };
  });
}

function applyEspnScheduleFields(games: ScheduleGame[], events: any[]): ScheduleGame[] {
  return games.map((game) => {
    const matches = events
      .map((event) => getEspnEventDetails(event, game))
      .filter((match): match is EspnEventDetails => match !== undefined);
    const match = matches.length === 1 ? matches[0] : undefined;
    if (!match) return game;

    const hasHuskerKickoff = game.kickoffStatus === 'confirmed' && game.fieldProvenance?.kickoffAt === 'huskers';
    const huskerBlockedKickoff = game.kickoffStatus === 'tba' && game.fieldProvenance?.kickoffAt === 'huskers';
    const canUseEspnKickoff = !hasHuskerKickoff && !huskerBlockedKickoff;
    const canUseEspnVenue = game.fieldProvenance?.venue !== 'huskers' && Boolean(match.venue);
    const usesEspnKickoff = canUseEspnKickoff && (match.kickoffStatus === 'tba' || Boolean(match.kickoffAt));
    const espnProvenance = {
      ...game.fieldProvenance,
      ...(usesEspnKickoff ? { kickoffAt: 'espn' as const } : {}),
      ...(canUseEspnVenue ? { venue: 'espn' as const } : {}),
    };
    const usesEspnFields = canUseEspnVenue || usesEspnKickoff;
    const next = {
      ...game,
      providerIds: { ...(game.providerIds?.cfbd ? { cfbd: game.providerIds.cfbd } : {}), espn: match.id },
      ...(canUseEspnVenue ? { venue: { name: match.venue!.name, timezone: getVenueTimezone(match.venue!.name, game.isHome && !game.isNeutral), ...(match.venue!.address ? { address: match.venue!.address } : {}) }, location: match.venue!.name } : {}),
      ...(canUseEspnKickoff && match.kickoffStatus === 'tba'
        ? { date: match.date || game.date, time: 'TBD', kickoffAt: undefined, kickoffStatus: 'tba' as const }
        : canUseEspnKickoff && match.kickoffAt
          ? { kickoffAt: match.kickoffAt, kickoffStatus: 'confirmed' as const }
          : {}),
      ...(usesEspnFields ? { fieldProvenance: espnProvenance } : {}),
    };
    return deriveVisibleKickoff(next);
  });
}

function getEspnEventMatch(event: any, game: ScheduleGame): string | undefined {
  return getEspnEventDetails(event, game)?.id;
}

type EspnVenueAddress = { street: string; city: string; region: string; postalCode: string };
type EspnEventDetails = { id: string; kickoffAt?: string; kickoffStatus: 'confirmed' | 'tba' | 'unconfirmed'; date?: string; venue?: { name: string; address?: EspnVenueAddress } };

function getEspnEventDetails(event: any, game: ScheduleGame): EspnEventDetails | undefined {
  const eventId = getEspnEventId(event?.id);
  const competition = event?.competitions?.[0];
  const eventDate = typeof competition?.date === 'string' ? competition.date : undefined;
  const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
  const nebraska = competitors.filter((competitor: any) => String(competitor?.team?.id) === '158');
  const opponents = competitors.filter((competitor: any) => String(competitor?.team?.id) !== '158' && typeof competitor?.team?.location === 'string');
  const gameDate = game.kickoffAt || getScheduleCalendarDate(game);
  if (eventId === undefined || !eventDate || nebraska.length !== 1 || opponents.length !== 1 || !gameDate) {
    return undefined;
  }

  const opponent = normalizeOpponentKey(opponents[0].team.location);
  if (opponent !== normalizeOpponentKey(game.opponent) || !datesWithinOneCalendarDay(gameDate, eventDate)) {
    return undefined;
  }

  const status = competition?.status?.type || {};
  const statusText = `${status.name || ''} ${status.shortDetail || ''} ${status.detail || ''}`;
  const explicitlyTba = /\bTBA\b|\bTBD\b/i.test(statusText);
  const kickoffAt = !explicitlyTba && competition.timeValid === true ? parseConfirmedKickoff(eventDate, true) : undefined;
  const venueName = decodeHtml(competition?.venue?.fullName || competition?.venue?.shortName || '');
  const address = competition?.venue?.address;
  const venueAddress = address && [address.street, address.city, address.state || address.region, address.zipCode || address.postalCode].every((value) => typeof value === 'string' && value.trim())
    ? { street: address.street.trim(), city: address.city.trim(), region: (address.state || address.region).trim(), postalCode: (address.zipCode || address.postalCode).trim() }
    : undefined;
  const kickoffStatus = kickoffAt && competition.timeValid === true ? 'confirmed' : explicitlyTba ? 'tba' : 'unconfirmed';
  return { id: eventId, kickoffStatus, date: formatGameDate(new Date(eventDate), false), ...(kickoffAt ? { kickoffAt } : {}), ...(venueName ? { venue: { name: venueName, ...(venueAddress ? { address: venueAddress } : {}) } } : {}) };
}

function getScheduleCalendarDate(game: ScheduleGame): string | undefined {
  const date = new Date(game.date);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function preserveEspnAdvisoryIds(games: ScheduleGame[], retainedPayload?: ScheduleGame[]): ScheduleGame[] {
  if (!retainedPayload) return games;
  const retainedIds = new Map(retainedPayload
    .map((game) => [game.gameKey, getEspnEventId(game.providerIds?.espn)] as const)
    .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])));
  return games.map((game) => {
    const espnId = game.gameKey ? retainedIds.get(game.gameKey) : undefined;
    return espnId === undefined ? game : { ...game, providerIds: { ...(game.providerIds || {}), espn: espnId } };
  });
}

function preserveRetainedSourceFields(games: ScheduleGame[], retainedPayload: ScheduleGame[] | undefined, providers: ProviderStates): ScheduleGame[] {
  if (!retainedPayload) return games;
  const retainedByKey = new Map(retainedPayload.map((game) => [game.gameKey, game]));
  return games.map((game) => {
    const retained = retainedByKey.get(game.gameKey);
    if (!retained) return game;
    const retainKickoff = (providers.huskers !== 'live' && retained.fieldProvenance?.kickoffAt === 'huskers') || (providers.espn !== 'live' && retained.fieldProvenance?.kickoffAt === 'espn');
    const retainVenue = (providers.huskers !== 'live' && retained.fieldProvenance?.venue === 'huskers') || (providers.espn !== 'live' && retained.fieldProvenance?.venue === 'espn');
    const retainedProvenance = {
      ...game.fieldProvenance,
      ...(retainKickoff && retained.fieldProvenance?.kickoffAt ? { kickoffAt: retained.fieldProvenance.kickoffAt } : {}),
      ...(retainVenue && retained.fieldProvenance?.venue ? { venue: retained.fieldProvenance.venue } : {}),
    };
    return {
      ...game,
      ...(retainKickoff ? { date: retained.date, time: retained.time, kickoffAt: retained.kickoffAt, kickoffStatus: retained.kickoffStatus } : {}),
      ...(retainVenue && retained.venue ? { venue: retained.venue, location: retained.location } : {}),
      ...(retainKickoff || retainVenue ? { fieldProvenance: retainedProvenance } : {}),
    };
  });
}

function getEspnEventId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getProviderStates(providers: Partial<ProviderStates>): ProviderStates {
  return {
    cfbdGames: providers.cfbdGames || 'skipped',
    cfbdMedia: providers.cfbdMedia || 'skipped',
    huskers: providers.huskers || 'skipped',
    espn: providers.espn || 'skipped',
  };
}

function isTimeout(error: unknown): boolean {
  return safeError(error) === 'provider_timeout';
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/timeout/i.test(message)) return 'provider_timeout';
  if (/CFBD_API_KEY/i.test(message)) return 'missing_config';
  if (/invalid|malformed|no valid|no regular-season/i.test(message)) return 'invalid_response';
  if (/cache/i.test(message)) return 'cache_error';
  if (/CFBD|Huskers|provider|API failed/i.test(message)) return 'upstream_error';
  return 'unavailable';
}

function isProviderPayload(value: unknown): value is { data: any[] } {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as any).data) && !(value as any).error);
}

function hasProviderError(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'error' in value);
}

async function readNumber(cache: any, key: string): Promise<number> {
  try {
    const value = await cache.get(key);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch { return 0; }
}

async function claimLease(cache: any, key: string): Promise<boolean> {
  try {
    if (await readNumber(cache, key) > Date.now()) return false;
    await cache.put(key, String(Date.now() + REFRESH_LEASE_MS), { expirationTtl: KV_MIN_TTL_SECONDS });
    return true;
  } catch { return true; }
}

async function writeRetryBackoff(cache: any, key: string): Promise<void> {
  try { await cache.put(key, String(Date.now() + REFRESH_BACKOFF_MS), { expirationTtl: KV_MIN_TTL_SECONDS }); } catch { /* cache is advisory */ }
}

function staleResponse(selection: { state: 'stale'; payload: ScheduleGame[]; envelope: CacheEnvelope<ScheduleGame[]> }, cachedData: CachedData | null, respond: (body: ScheduleResponse, status: number, mode: 'network' | 'fresh-cache' | 'stale-cache' | 'miss', sourceState: 'live' | 'fresh-cache' | 'stale-cache' | 'unavailable', cacheControl: string) => Response, providers: ProviderStates = { cfbdGames: 'skipped', cfbdMedia: 'skipped', huskers: 'skipped', espn: 'skipped' }): Response {
  const servedAt = Date.now();
  return respond({ success: true, data: selection.payload, cached: true, lastUpdated: new Date(selection.envelope.dataUpdatedAt).toISOString(), source: cachedData?.source || 'cfbd-api', count: selection.payload.length, season: cachedData?.season, nextRefresh: new Date(selection.envelope.freshUntil).toISOString(), stale: true, meta: createScheduleMeta(selection.envelope.dataUpdatedAt, servedAt, 'stale-cache', 'stale-cache', providers) }, 200, 'stale-cache', 'stale-cache', 'public, max-age=300');
}

function getRequestedSeason(url: URL): number {
  const requestedSeason = url.searchParams.get('season');
  if (requestedSeason && /^\d{4}$/.test(requestedSeason)) {
    return parseInt(requestedSeason, 10);
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  return now.getMonth() === 0 ? currentYear - 1 : currentYear;
}

async function fetchHuskerScheduleOverrides(season: number): Promise<HuskerFetchResult> {
  try {
    const apiUrl = `https://huskers.com/website-api/schedule-events?filter%5Bschedule_id%5D=${HUSKERS_FOOTBALL_SCHEDULE_ID}&filter%5Bhide_from_specific_sport_schedule%5D=false&include=conference.image,opponent.customLogo,opponent.officialLogo,opponentLogo,postEventArticle.image,preEventArticle.image,presentedBy,promotionalItems.image,schedule.sport,scheduleEventLinks.icon,scheduleEventResult,scheduleEventTags.image,secondOpponent.customLogo,secondOpponent.officialLogo,secondOpponentLogo,tournament&per_page=1000&sort=datetime&`;
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Rhule-aid.com/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`Huskers schedule API failed: ${response.status}`);
    }

    const payload = await response.json() as any;
    if (!payload || !Array.isArray(payload.data)) return { overrides: new Map(), state: 'invalid' };
    const events = payload.data;
    const overrides = new Map<string, HuskerScheduleOverride>();

    for (const event of events) {
      const eventYear = event.datetime ? new Date(event.datetime).getUTCFullYear() : null;
      const opponent = decodeHtml(event.opponent_name || event.opponent?.name || '');
      if (!opponent || /red\/white|spring game/i.test(opponent)) {
        continue;
      }

      if (eventYear !== season) {
        continue;
      }

      const officialTba = isOfficialTba(event.tba);
      const date = formatHuskerDate(event.datetime);
      const time = officialTba ? 'TBD' : formatHuskerTime(event.datetime, event.tba, event.tba_text);
      const location = decodeHtml(event.venue || event.location || '');
      const network = extractNetworkFromLinks(event.schedule_event_links || []);
      const opponentLogo = event.opponent_logo?.url || event.opponent?.officialLogo?.url || event.opponent?.customLogo?.url;
      const officialDate = officialTba ? null : parseConfirmedKickoff(event.datetime, event.tba === false);

      overrides.set(normalizeOpponentKey(opponent), {
        opponent,
        date,
        time,
        ...(location ? { location: normalizeHuskerLocation(location) } : {}),
        network: network || 'TBD',
        ...(officialDate ? { kickoffAt: officialDate } : {}),
        ...(officialTba ? { kickoffStatus: 'tba' as const } : officialDate ? { kickoffStatus: 'confirmed' as const } : {}),
        ...(opponentLogo ? { opponentLogo } : {})
      });
    }

    return { overrides, state: 'live' };
  } catch (error) {
    console.error('Huskers schedule override error:', safeError(error));
    return { overrides: new Map(), state: isTimeout(error) ? 'timeout' : 'error' };
  }
}

function isOfficialTba(value: unknown): boolean {
  if (value === true) return true;
  return typeof value === 'string' && /^(?:time_)?tba$|^tbd$/i.test(value.trim());
}

function applyHuskerOverrides(games: ScheduleGame[], overrides: Map<string, HuskerScheduleOverride>): ScheduleGame[] {
  return games.map((game) => {
    const override = overrides.get(normalizeOpponentKey(game.opponent));
    if (!override) {
      return game;
    }

    const base = {
      ...game,
      date: override.date,
      time: override.time,
      ...(override.kickoffStatus === 'tba' ? { kickoffAt: undefined, kickoffStatus: 'tba' as const, fieldProvenance: { ...game.fieldProvenance, kickoffAt: 'huskers' as const } } : {}),
      ...(override.location ? { location: override.location } : {}),
      ...(override.location ? { venue: { name: override.location, timezone: getVenueTimezone(override.location, game.isHome && !game.isNeutral) }, fieldProvenance: { ...game.fieldProvenance, venue: 'huskers' as const } } : {}),
      network: override.network !== 'TBD' ? override.network : game.network,
      tvNetwork: override.network !== 'TBD' ? override.network : game.tvNetwork,
      ...(override.opponentLogo ? { opponentLogo: override.opponentLogo } : {}),
      ...(override.kickoffAt ? { kickoffAt: override.kickoffAt, kickoffStatus: 'confirmed' as const, fieldProvenance: { ...game.fieldProvenance, ...(override.location ? { venue: 'huskers' as const } : {}), kickoffAt: 'huskers' as const } } : override.kickoffStatus === 'tba' ? { kickoffAt: undefined, kickoffStatus: 'tba' as const, fieldProvenance: { ...game.fieldProvenance, ...(override.location ? { venue: 'huskers' as const } : {}), kickoffAt: 'huskers' as const } } : {})
    };
    return deriveVisibleKickoff(base);
  });
}

function deriveVisibleKickoff(game: ScheduleGame): ScheduleGame {
  if (game.kickoffStatus !== 'confirmed') return { ...game, time: 'TBD', kickoffAt: undefined };
  if (!game.kickoffAt) return { ...game, time: 'TBD', kickoffAt: undefined };
  const kickoff = new Date(game.kickoffAt);
  if (Number.isNaN(kickoff.getTime())) return { ...game, time: 'TBD', kickoffAt: undefined };
  return {
    ...game,
    date: formatGameDate(kickoff, true),
    time: kickoff.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }).replace(/\s+/g, ' '),
  };
}

function formatHuskerDate(datetime: string): string {
  const date = new Date(datetime);
  if (Number.isNaN(date.getTime())) {
    return 'TBD';
  }

  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  });
}

function formatHuskerTime(datetime: string, tba?: boolean, tbaText?: string): string {
  if (tba === true) {
    return normalizeHuskerTime(tbaText || 'TBD');
  }

  const date = new Date(datetime);
  if (Number.isNaN(date.getTime()) || (tba !== false && isPlaceholderKickoff(date))) {
    return 'TBD';
  }

  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
    timeZoneName: 'short'
  }).replace(/\s+/g, ' ');
}

function normalizeHuskerTime(time: string): string {
  const trimmed = time.trim();
  return !trimmed || /^TBA$/i.test(trimmed) ? 'TBD' : trimmed;
}

function extractNetworkFromLinks(links: any[]): string | null {
  const candidates = links
    .filter((link) => link?.is_tv_translation || link?.icon?.title || link?.title || link?.link)
    .flatMap((link) => [link?.icon?.title, link?.icon?.original_name, link?.icon?.alt, link?.title, link?.label, link?.link])
    .filter((value): value is string => typeof value === 'string');

  for (const candidate of candidates) {
    const network = normalizeNetworkName(candidate);
    if (network) {
      return network;
    }
  }

  return null;
}

function normalizeNetworkName(value: string): string | null {
  const normalized = decodeHtml(value).replace(/[_-]/g, ' ').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized.includes('btn') || normalized.includes('big ten network')) return 'BTN';
  if (normalized.includes('fs1')) return 'FS1';
  if (normalized.includes('fox')) return 'FOX';
  if (normalized.includes('cbs')) return 'CBS';
  if (normalized.includes('nbc')) return 'NBC';
  if (normalized.includes('peacock')) return 'Peacock';
  if (normalized.includes('espn2')) return 'ESPN2';
  if (normalized.includes('espnu')) return 'ESPNU';
  if (normalized.includes('espn')) return 'ESPN';

  return null;
}

function normalizeOpponentKey(opponent: string): string {
  return opponent
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeHuskerLocation(location: string): string {
  return location
    .replace(/Lincoln, Neb\. \/ Memorial Stadium/i, 'Memorial Stadium (Lincoln, NE)')
    .replace(/East Lansing, Mich\./i, 'Spartan Stadium')
    .replace(/Eugene, Ore\./i, 'Autzen Stadium')
    .replace(/Champaign, Ill\./i, 'Memorial Stadium (Champaign, IL)')
    .replace(/Piscataway, N\.J\./i, 'SHI Stadium')
    .replace(/Iowa City, Iowa/i, 'Kinnick Stadium');
}

function decodeHtml(value: string | undefined): string {
  return (value || '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function parseCFBDSchedule(cfbdGames: any[], mediaByGame: Map<string, MediaMatch>, season: number): ScheduleGame[] {
  return cfbdGames
    .map(game => parseCFBDGame(game, mediaByGame, season))
    .filter((game): game is ScheduleGame => game !== null)
    .sort((a, b) => new Date(`${a.date} ${a.time === 'TBD' ? '12:00 PM' : a.time}`).getTime() - new Date(`${b.date} ${b.time === 'TBD' ? '12:00 PM' : b.time}`).getTime());
}

function parseCFBDGame(game: any, mediaByGame: Map<string, MediaMatch>, season: number): ScheduleGame | null {
  const homeTeam = game.homeTeam || game.home_team;
  const awayTeam = game.awayTeam || game.away_team;

  if (!homeTeam || !awayTeam) {
    return null;
  }

  const isHome = homeTeam === 'Nebraska';
  const opponent = isHome ? awayTeam : homeTeam;
  const homeId = normalizeTeamId(game.homeId ?? game.home_id);
  const awayId = normalizeTeamId(game.awayId ?? game.away_id);
  const opponentId = isHome ? awayId : homeId;
  const gameId = normalizeTeamId(game.id);
  const startDate = game.startDate || game.start_date;
  const gameDate = startDate ? new Date(startDate) : null;
  const hasAnnouncedKickoff = gameDate && !Number.isNaN(gameDate.getTime()) && game.startTimeTBD !== true && game.start_time_tbd !== true;
  const kickoffAt = hasAnnouncedKickoff && gameDate ? gameDate.toISOString() : undefined;
  const venueName = typeof game.venue === 'string' && game.venue.trim() ? game.venue.trim() : 'TBA';

  const date = gameDate && !isNaN(gameDate.getTime())
    ? formatGameDate(gameDate, Boolean(hasAnnouncedKickoff))
    : 'TBD';

  const time = hasAnnouncedKickoff
    ? gameDate.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/Chicago'
      }).replace(/\s+/g, ' ')
    : 'TBD';

  const homePoints = game.homePoints ?? game.home_points;
  const awayPoints = game.awayPoints ?? game.away_points;
  const nebraskaScore = isHome ? homePoints : awayPoints;
  const opponentScore = isHome ? awayPoints : homePoints;
  let result: string | undefined;
  let score: string | undefined;

  if (typeof nebraskaScore === 'number' && typeof opponentScore === 'number') {
    if (nebraskaScore > opponentScore) {
      result = 'W';
    } else if (opponentScore > nebraskaScore) {
      result = 'L';
    }
    score = `${nebraskaScore}-${opponentScore}`;
  }

  const network = getTVNetwork(game, mediaByGame);

  return {
    season,
    ...(gameId ? { id: gameId } : {}),
    date,
    opponent,
    ...(opponentId ? { opponentId } : {}),
    homeTeam,
    awayTeam,
    ...(homeId ? { homeTeamId: homeId } : {}),
    ...(awayId ? { awayTeamId: awayId } : {}),
    nebraskaLogo: getLogoUrl('Nebraska', isHome ? homeId : awayId),
    opponentLogo: getLogoUrl(opponent, opponentId),
    time,
    location: game.venue || 'TBA',
    network,
    tvNetwork: network,
    isHome,
    isNeutral: game.neutralSite === true || game.neutral_site === true,
    result,
    score,
    gameKey: gameId ? `cfbd:${gameId}` : `nebraska:${season}:${normalizeOpponentKey(opponent)}`,
    kickoffStatus: kickoffAt ? 'confirmed' : 'tba',
    ...(kickoffAt ? { kickoffAt } : {}),
    venue: { name: venueName, timezone: getVenueTimezone(venueName, false) },
    fieldProvenance: { kickoffAt: kickoffAt ? 'cfbd' : undefined, venue: venueName === 'TBA' ? 'unknown' : 'cfbd' },
    ...((gameId || game.__espnId) ? { providerIds: { ...(gameId ? { cfbd: gameId } : {}), ...(game.__espnId ? { espn: game.__espnId } : {}) } } : {})
  };
}

function getVenueTimezone(name: string, isVerifiedLincoln: boolean): 'America/Chicago' | null {
  return isVerifiedLincoln && /Lincoln,\s*(NE|Neb\.)/i.test(name) ? 'America/Chicago' : null;
}

function parseConfirmedKickoff(value: unknown, explicitlyConfirmed = false): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && (explicitlyConfirmed || !isPlaceholderKickoff(date)) ? date.toISOString() : undefined;
}

interface MediaMatch {
  outlet: string;
  startTime?: string;
}

function createMediaLookup(media: any[]): Map<string, MediaMatch> {
  const lookup = new Map<string, MediaMatch>();

  for (const item of media) {
    const outlet = normalizeOutlet(item.outlet);
    if (!outlet) {
      continue;
    }

    const startTime = item.startTime || item.start_time;
    const match: MediaMatch = { outlet, ...(startTime ? { startTime } : {}) };

    const homeTeam = item.homeTeam || item.home_team;
    const awayTeam = item.awayTeam || item.away_team;
    if (homeTeam && awayTeam) {
      lookup.set(`teams:${normalizeOpponentKey(homeTeam)}|${normalizeOpponentKey(awayTeam)}`, match);
    }

    if (homeTeam && awayTeam && startTime) {
      lookup.set(`full:${normalizeOpponentKey(homeTeam)}|${normalizeOpponentKey(awayTeam)}|${startTime}`, match);
    }
  }

  return lookup;
}

function getTVNetwork(game: any, mediaByGame: Map<string, MediaMatch>): string {
  const inlineTV = normalizeOutlet(game.tv || game.tvNetwork || game.tv_network || game.broadcast || game.network);
  if (inlineTV) {
    return inlineTV;
  }

  let match: MediaMatch | undefined;

  const homeTeam = game.homeTeam || game.home_team;
  const awayTeam = game.awayTeam || game.away_team;
  const startTime = game.startDate || game.start_date;
  const teamKey = homeTeam && awayTeam ? `teams:${normalizeOpponentKey(homeTeam)}|${normalizeOpponentKey(awayTeam)}` : '';

  if (!match && homeTeam && awayTeam && startTime) {
    match = mediaByGame.get(`full:${normalizeOpponentKey(homeTeam)}|${normalizeOpponentKey(awayTeam)}|${startTime}`);
  }

  if (!match && teamKey) {
    const candidate = mediaByGame.get(teamKey);
    const dateMatches = candidate?.outlet === 'ESPN'
      ? Boolean(startTime && candidate.startTime && datesWithinOneCalendarDay(startTime, candidate.startTime))
      : (!candidate?.startTime || !startTime || datesWithinOneCalendarDay(startTime, candidate.startTime));
    if (candidate && dateMatches) {
      match = candidate;
    }
  }

  if (match) {
    return match.outlet || 'TBD';
  }

  return 'TBD';
}

function datesWithinOneCalendarDay(first: string, second: string): boolean {
  const day = (value: string): number | null => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const year = Number(parts.find((part) => part.type === 'year')?.value);
    const month = Number(parts.find((part) => part.type === 'month')?.value);
    const dateOfMonth = Number(parts.find((part) => part.type === 'day')?.value);
    return Date.UTC(year, month - 1, dateOfMonth);
  };
  const firstDay = day(first);
  const secondDay = day(second);
  return firstDay !== null && secondDay !== null && Math.abs(firstDay - secondDay) <= 86_400_000;
}

function normalizeOutlet(outlet: unknown): string | null {
  if (typeof outlet !== 'string') {
    return null;
  }

  const normalized = outlet.trim();
  return normalized && normalized.toUpperCase() !== 'TBD' ? normalized : null;
}

function getLogoUrl(teamName: string, teamId?: number): string {
  if (teamId) {
    return `/api/logo?teamId=${teamId}&size=128`;
  }

  return `/api/logo?team=${encodeURIComponent(teamName)}&size=128`;
}

function formatGameDate(gameDate: Date, hasAnnouncedKickoff: boolean): string {
  return gameDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: hasAnnouncedKickoff ? 'America/Chicago' : 'UTC'
  });
}

function isPlaceholderKickoff(gameDate: Date): boolean {
  // CFBD commonly stores future unannounced games at midnight UTC.
  // Treat those as date-only games so they do not show as misleading late-night kickoffs.
  return gameDate.getUTCMinutes() === 0 && [0, 4, 5].includes(gameDate.getUTCHours());
}

function normalizeTeamId(teamId: unknown): number | undefined {
  if (typeof teamId === 'number' && Number.isFinite(teamId)) {
    return teamId;
  }

  if (typeof teamId === 'string' && /^\d+$/.test(teamId)) {
    return parseInt(teamId, 10);
  }

  return undefined;
}
