import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../src/api/cfb-schedule.ts';

function request(division?: 'all', etag?: string, week: string | null = '1', date?: string) {
  return new Request(`https://rhule-aid.com/api/cfb-schedule?season=2025${week === null ? '' : `&week=${week}`}${date ? `&date=${date}` : ''}${division ? `&division=${division}` : ''}`, etag ? { headers: { 'If-None-Match': etag } } : undefined);
}

function context(division?: 'all', etag?: string, cache = new Map<string, string>(), week: string | null = '1', date?: string): Parameters<typeof onRequest>[0] {
  return {
    request: request(division, etag, week, date),
    env: {
      CFBD_API_KEY: 'test-key',
      CFB_SCHEDULE_CACHE: {
        get: async (key: string) => cache.get(key) || null,
        put: async (key: string, value: string) => { cache.set(key, value); },
      },
    },
  } as Parameters<typeof onRequest>[0];
}

function cfbdGame(id: number, homeId = 1, awayId = 2) {
  return {
    id,
    week: 1,
    startDate: '2025-09-01T18:00:00.000Z',
    homeTeam: 'Nebraska',
    awayTeam: 'Iowa',
    homeId,
    awayId,
  };
}

function cfbdGameWithTime(id: number, startTimeTBD: boolean) {
  return { ...cfbdGame(id), startTimeTBD };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, conference: 'Big Ten', classification: 'fbs' }, { id: 2, conference: 'Big Ten', classification: 'fbs' }]), { status: 200 });
    if (url.includes('/games/media')) return new Response(JSON.stringify([{ id: 1, outlet: 'BTN' }]), { status: 200 });
    if (url.includes('collegefootballdata.com')) {
      const games = url.includes('classification=fbs')
        ? [cfbdGame(1), cfbdGame(3, 1, 9)]
        : [cfbdGame(1), cfbdGame(2, 3, 4)];
      return new Response(JSON.stringify(games), { status: 200 });
    }
    return new Response(JSON.stringify({ events: [] }), { status: 200 });
  }));
});

describe('CFBD division views', () => {
  it('overlays the per-week Durable Object snapshot in do mode', async () => {
    const liveSnapshot = {
      games: [{ id: '1', competitions: [{ competitors: [
        { homeAway: 'home', score: '24' }, { homeAway: 'away', score: '17' },
      ], status: { displayClock: '04:12', period: 3, type: { state: 'in', name: 'In Progress', completed: false }, detail: 'Nebraska possession' }, situation: { possession: 'Nebraska' } }] }],
    };
    const liveFetch = vi.fn(async () => new Response(JSON.stringify(liveSnapshot)));
    const cache = new Map<string, string>([['cfb-live-active:v1:2025:regular:1', '1']]);
    const ctx = context(undefined, undefined, cache);
    (ctx.env as any).CFB_SYNC_MODE = 'do';
    (ctx.env as any).CFB_WEEK_LIVE_FEED = { idFromName: vi.fn(() => ({})), get: vi.fn(() => ({ fetch: liveFetch })) };

    const response = await onRequest(ctx);
    const body = await response.json() as { games: Array<{ homeTeam: { score: number }; awayTeam: { score: number }; status: string; displayClock: string; period: number; possession: string }> };

    expect(body.games[0]).toMatchObject({ status: 'In Progress', displayClock: '04:12', period: 3, possession: 'Nebraska' });
    expect(body.games[0]?.homeTeam.score).toBe(24);
    expect(body.games[0]?.awayTeam.score).toBe(17);
    expect(liveFetch).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('seasonType=regular') }));
  });

  it('retains legacy output when the Durable Object snapshot fails', async () => {
    const ctx = context();
    (ctx.env as any).CFB_SYNC_MODE = 'do';
    (ctx.env as any).CFB_WEEK_LIVE_FEED = { idFromName: vi.fn(() => ({})), get: vi.fn(() => ({ fetch: vi.fn(async () => new Response('unavailable', { status: 503 })) })) };

    const response = await onRequest(ctx);
    const body = await response.json() as { games: Array<{ id: string; status: string }> };

    expect(response.status).toBe(200);
    expect(body.games[0]).toMatchObject({ id: '1', status: 'Scheduled' });
  });

  it('retains legacy output and does not allocate when live week is inactive', async () => {
    const ctx = context();
    (ctx.env as any).CFB_SYNC_MODE = 'do';
    (ctx.env as any).CFB_WEEK_LIVE_FEED = { idFromName: vi.fn(() => { throw new Error('must not allocate'); }), get: vi.fn(() => { throw new Error('must not allocate'); }) };

    const response = await onRequest(ctx);
    expect(response.status).toBe(200);
    expect((await response.json() as { games: Array<{ status: string }> }).games[0]).toMatchObject({ status: 'Scheduled' });
  });

  it('canonicalizes zero-padded weeks and matches numeric overlay IDs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]));
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]');
      if (url.includes('/games?')) {
        expect(url).toContain('week=1');
        expect(url).not.toContain('week=01');
        return new Response(JSON.stringify([cfbdGame(1)]));
      }
      if (url.includes('/scoreboard?')) return new Response(JSON.stringify({ events: [{ id: '1', competitions: [{ competitors: [
        { homeAway: 'home', team: { displayName: 'Nebraska' }, score: '7' },
        { homeAway: 'away', team: { displayName: 'Iowa' }, score: '3' },
        ], status: { type: { name: 'In Progress', completed: false } } }] }] }));
      return new Response(JSON.stringify({ events: [] }));
    }));

    const response = await onRequest(context(undefined, undefined, new Map(), '01'));
    const body = await response.json() as { hasLiveGames: boolean; games: Array<{ status: string }> };

    expect(body.games[0]?.status).toBe('In Progress');
    expect(body.hasLiveGames).toBe(true);
  });

  it('uses a 60-second cache lifetime for game-day snapshots before live recognition', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]));
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]');
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]));
      return new Response(JSON.stringify({ events: [] }));
    }));

    const response = await onRequest(context(undefined, undefined, new Map(), '1', '2025-09-01'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('recognizes an ESPN In Progress overlay as live', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]));
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]');
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]));
      if (url.includes('/scoreboard?')) return new Response(JSON.stringify({ events: [{ id: 'espn-1', competitions: [{ competitors: [
         { homeAway: 'home', team: { displayName: 'Nebraska' }, score: '7' },
         { homeAway: 'away', team: { displayName: 'Iowa' }, score: '3' },
      ], status: { displayClock: '08:42', period: 2, detail: 'Nebraska possession', type: { state: 'in', name: 'In Progress', completed: false } } }] }] }));
      return new Response(JSON.stringify({ events: [] }));
    }));

    const response = await onRequest(context());
    const body = await response.json() as { hasLiveGames: boolean; games: Array<{ status: string; displayClock: string; period: number; detail: string }> };

    expect(body.games[0]?.status).toBe('In Progress');
    expect(body.games[0]?.displayClock).toBe('08:42');
    expect(body.games[0]?.period).toBe(2);
    expect(body.games[0]?.detail).toBe('Nebraska possession');
    expect(body.hasLiveGames).toBe(true);
    const scoreboardCall = vi.mocked(fetch).mock.calls.find(call => String(call[0]).includes('/scoreboard?'));
    expect(String(scoreboardCall?.[0])).toMatch(/[?&]dates=\d{8}(?:&|$)/);
    expect(scoreboardCall?.[1]).toMatchObject({
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://www.espn.com/',
      },
    });
  });

  it('falls back to the ESPN CDN when the site scoreboard fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]));
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]');
      if (url.includes('/games?')) return new Response(JSON.stringify([{ ...cfbdGame(401864494), startDate: '2026-08-29T16:00:00.000Z' }]));
      if (url.includes('site.api.espn.com')) return new Response('blocked', { status: 403 });
      if (url.includes('cdn.espn.com')) return new Response(JSON.stringify({ content: { sbData: { events: [{ id: '401864494', date: '2026-08-29T16:00:00.000Z', status: { displayClock: '00:00', period: 2, detail: 'Halftime', type: { description: 'Halftime', completed: false } }, competitions: [{ competitors: [
        { homeAway: 'home', team: { displayName: 'Nebraska' }, score: '14' },
        { homeAway: 'away', team: { displayName: 'Iowa' }, score: '10' },
        ] }] }] } } }));
      return new Response(JSON.stringify({ events: [] }));
    }));

    const response = await onRequest(context());
    const body = await response.json() as { hasLiveGames: boolean; games: Array<{ id: string; status: string; displayClock: string; period: number; detail: string; homeTeam: { score: number }; awayTeam: { score: number } }> };

    expect(body.games[0]).toMatchObject({ id: '401864494', status: 'Halftime' });
    expect(body.games[0]?.homeTeam.score).toBe(14);
    expect(body.games[0]?.awayTeam.score).toBe(10);
    expect(body.games[0]?.displayClock).toBe('00:00');
    expect(body.games[0]?.period).toBe(2);
    expect(body.games[0]?.detail).toBe('Halftime');
    expect(body.hasLiveGames).toBe(true);
  });

  it('excludes completed ESPN overlays from live games', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]));
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]');
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]));
      if (url.includes('/scoreboard?')) return new Response(JSON.stringify({ events: [{ id: 'espn-1', competitions: [{ competitors: [
        { homeAway: 'home', team: { displayName: 'Nebraska' }, score: '7' },
        { homeAway: 'away', team: { displayName: 'Iowa' }, score: '3' },
      ], status: { type: { state: 'post', detail: 'Final', completed: true } } }] }] }));
      return new Response(JSON.stringify({ events: [] }));
    }));

    const response = await onRequest(context());
    const body = await response.json() as { hasLiveGames: boolean; games: Array<{ status: string; isCompleted: boolean }> };

    expect(body.games[0]?.status).toBe('Final');
    expect(body.games[0]?.isCompleted).toBe(true);
    expect(body.hasLiveGames).toBe(false);
  });

  it('emits a quoted SHA-256 ETag for successful schedule payloads', async () => {
    const response = await onRequest(context());
    const body = await response.text();
    const etag = response.headers.get('ETag');

    expect(response.status).toBe(200);
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const expected = `"${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}"`;
    expect(etag).toBe(expected);
  });

  it('returns 304 for a matching ETag while retaining cache and CORS headers', async () => {
    const cache = new Map<string, string>();
    const first = await onRequest(context(undefined, undefined, cache));
    const etag = first.headers.get('ETag');
    const second = await onRequest(context(undefined, etag || undefined, cache));

    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(second.headers.get('ETag')).toBe(etag);
    expect(second.headers.get('Cache-Control')).toBe('public, max-age=900');
    expect(second.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('emits different ETags for changed schedule payloads', async () => {
    const first = await onRequest(context());
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]));
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]');
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(99)]));
      return new Response(JSON.stringify({ events: [] }));
    }));
    const second = await onRequest(context('all'));

    expect(second.status).toBe(200);
    expect(second.headers.get('ETag')).not.toBe(first.headers.get('ETag'));
  });

  it('does not assign a kickoff time to CFBD TBD games', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]', { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGameWithTime(1, true)]), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ time: string }> };
    expect(body.games[0]?.time).toBe('TBD');
  });

  it('normalizes confirmed CFBD kickoff time', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]', { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGameWithTime(1, false)]), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ time: string }> };
    expect(body.games[0]?.time).toContain('1:00 PM');
    expect(body.games[0]?.time).toContain('CDT');
  });

  it('keeps Core date-only events at TBD kickoff time', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.collegefootballdata.com')) return new Response('unavailable', { status: 503 });
      if (url.includes('/events?')) return new Response(JSON.stringify({ items: [{ $ref: 'https://sports.core.api.espn.com/v2/events/1' }] }), { status: 200 });
      if (url.includes('/events/1')) return new Response(JSON.stringify({
        id: 'core-1', week: { number: 1 }, competitions: [{ date: '2025-09-01', competitors: [
          { homeAway: 'home', team: { displayName: 'Nebraska', conferenceId: '7' } },
          { homeAway: 'away', team: { displayName: 'Iowa', conferenceId: '7' } },
        ] }],
      }), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ time: string }> };
    expect(body.games[0]?.time).toBe('TBD');
  });

  it('prefers formatted Consensus CFBD lines', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/games/media')) return new Response('[]', { status: 200 });
      if (url.includes('/lines')) return new Response(JSON.stringify([{ id: 1, lines: [
        { provider: 'DraftKings', spread: -3 },
        { provider: 'Consensus', formattedSpread: 'Iowa -2.5' },
      ] }]), { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ spread: string | null }> };
    expect(body.games[0]?.spread).toBe('Iowa -2.5');
  });

  it('uses nonempty ESPN current odds over CFBD lines', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/games/media')) return new Response('[]', { status: 200 });
      if (url.includes('/lines')) return new Response(JSON.stringify([{ id: 1, lines: [{ provider: 'Consensus', formattedSpread: 'Iowa -2.5' }] }]), { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]), { status: 200 });
      if (url.includes('/scoreboard?')) return new Response(JSON.stringify({ events: [{
        id: 'espn-1', competitions: [{ competitors: [
          { homeAway: 'home', team: { displayName: 'Nebraska' }, score: '0' },
          { homeAway: 'away', team: { displayName: 'Iowa' }, score: '0' },
        ], odds: [{ details: '' }, { details: 'Nebraska -4.5' }] }],
      }] }), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ spread: string | null }> };
    expect(body.games[0]?.spread).toBe('Nebraska -4.5');
  });

  it('requests authoritative FBS data by default', async () => {
    const response = await onRequest(context());
    const body = await response.json() as { games: unknown[] };

    expect(response.status).toBe(200);
    expect(body.games).toHaveLength(1);
    expect(String(vi.mocked(fetch).mock.calls.find(call => String(call[0]).includes('/games'))?.[0])).toContain('classification=fbs');
  });

  it('returns all ordered regular-season weeks from the CFBD calendar', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/calendar?')) return new Response(JSON.stringify([
        { week: 3, seasonType: 'regular' }, { week: 1, seasonType: 'regular' },
        { week: 2, seasonType: 'regular' }, { week: 15, seasonType: 'postseason' },
      ]), { status: 200 });
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]', { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { weeks: Array<{ label: string; value: string }> };
    expect(body.weeks).toEqual([
      { label: 'Week 1', value: '1' }, { label: 'Week 2', value: '2' }, { label: 'Week 3', value: '3' },
    ]);
    expect(String(vi.mocked(fetch).mock.calls.find(call => String(call[0]).includes('/calendar?'))?.[0])).toContain('seasonType=regular');
  });

  it('falls back to requested week when the CFBD calendar fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/calendar?')) return new Response('unavailable', { status: 503 });
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]', { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { weeks: Array<{ label: string; value: string }> };
    expect(body.weeks).toEqual([{ label: 'Week 1', value: '1' }]);
  });

  it('preserves an explicitly requested week without using calendar dates', async () => {
    const response = await onRequest(context(undefined, undefined, new Map(), '7'));
    const gameRequest = vi.mocked(fetch).mock.calls.find(call => String(call[0]).includes('/games?'));
    expect(String(gameRequest?.[0])).toContain('week=7');
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes('/calendar?'))).toBe(true);
  });

  it('selects the calendar week containing today when week is omitted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-09-10T12:00:00Z'));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/calendar?')) return new Response(JSON.stringify([
        { week: 2, seasonType: 'regular', firstGameStart: '2025-09-06T00:00:00Z', lastGameStart: '2025-09-12T23:59:59Z' },
        { week: 3, seasonType: 'regular', firstGameStart: '2025-09-13T00:00:00Z', lastGameStart: '2025-09-19T23:59:59Z' },
      ]));
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]));
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]');
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]));
      return new Response(JSON.stringify({ events: [] }));
    }));
    try {
      await onRequest(context(undefined, undefined, new Map(), null));
      const gameRequest = vi.mocked(fetch).mock.calls.find(call => String(call[0]).includes('/games?'));
      expect(String(gameRequest?.[0])).toContain('week=2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('selects the nearest upcoming calendar week when today falls between weeks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-09-12T12:00:00Z'));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/calendar?')) return new Response(JSON.stringify([
        { week: 2, seasonType: 'regular', firstGameStart: '2025-09-01T00:00:00Z', lastGameStart: '2025-09-05T23:59:59Z' },
        { week: 3, seasonType: 'regular', firstGameStart: '2025-09-13T00:00:00Z', lastGameStart: '2025-09-19T23:59:59Z' },
      ]));
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]));
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]');
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]));
      return new Response(JSON.stringify({ events: [] }));
    }));
    try {
      await onRequest(context(undefined, undefined, new Map(), null));
      const gameRequest = vi.mocked(fetch).mock.calls.find(call => String(call[0]).includes('/games?'));
      expect(String(gameRequest?.[0])).toContain('week=3');
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests unfiltered data and includes FCS games for division=all', async () => {
    const response = await onRequest(context('all'));
    const body = await response.json() as { games: unknown[] };

    expect(response.status).toBe(200);
    expect(body.games).toHaveLength(2);
    expect((body.games[0] as { homeTeam: { conference: string } }).homeTeam.conference).toBe('Big Ten');
  });

  it('classifies metadata-backed FBS and FCS games while leaving lower levels unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([
        { id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' },
        { id: 3, classification: 'fcs' }, { id: 4, classification: 'fcs' },
        { id: 5, classification: 'd2' }, { id: 6, classification: 'd2' },
      ]), { status: 200 });
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]', { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([
        cfbdGame(1, 1, 2), cfbdGame(2, 3, 4), cfbdGame(3, 5, 6),
      ]), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context('all'));
    const body = await response.json() as { games: Array<{ id: string; division: string; homeDivision: string; awayDivision: string }> };
    expect(body.games.map(game => [game.id, game.division, game.homeDivision, game.awayDivision])).toEqual([
      ['1', 'FBS', 'FBS', 'FBS'], ['2', 'FCS', 'FCS', 'FCS'], ['3', 'unknown', 'unknown', 'unknown'],
    ]);
  });

  it('joins CFBD TV media to games by exact ID', async () => {
    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ id: string; tv: string }> };

    expect(body.games.find(game => game.id === '1')?.tv).toBe('BTN');
  });

  it('selects ESPN+ over Disney+ without replacing an ESPN+ only listing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/games/media')) return new Response(JSON.stringify([{ id: 1, outlet: 'Disney+' }, { id: 1, outlet: 'ESPN+' }]), { status: 200 });
      if (url.includes('/lines')) return new Response('[]', { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ tv: string }> };
    expect(body.games[0]?.tv).toBe('ESPN+');
  });

  it('selects ESPN over ESPN+ and Disney+', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/games/media')) return new Response(JSON.stringify([{ id: 1, outlet: 'Disney+' }, { id: 1, outlet: 'ESPN+' }, { id: 1, outlet: 'ESPN' }]), { status: 200 });
      if (url.includes('/lines')) return new Response('[]', { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ tv: string }> };
    expect(body.games[0]?.tv).toBe('ESPN');
  });

  it('requests all CFBD media and normalizes streaming ESPN+', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/games/media')) return new Response(JSON.stringify([{ id: 1, outlet: 'ESPN+' }]), { status: 200 });
      if (url.includes('/lines')) return new Response('[]', { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]), { status: 200 });
      if (url.includes('/scoreboard?')) return new Response(JSON.stringify({ events: [] }), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ tv: string }> };
    const mediaRequest = vi.mocked(fetch).mock.calls.find(call => String(call[0]).includes('/games/media'))?.[0];
    expect(String(mediaRequest)).not.toContain('mediaType=tv');
    expect(body.games[0]?.tv).toBe('ESPN+');
  });

  it('preserves TBD TV when CFBD media fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, conference: 'Big Ten', classification: 'fbs' }, { id: 2, conference: 'Big Ten', classification: 'fbs' }]), { status: 200 });
      if (url.includes('/games/media')) return new Response('unavailable', { status: 503 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ tv: string }> };
    expect(response.status).toBe(200);
    expect(body.games[0].tv).toBe('TBD');
  });

  it('fills TBD TV with ESPN+ when broadcast names are supplied by ESPN', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]', { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]), { status: 200 });
      if (url.includes('/scoreboard?')) return new Response(JSON.stringify({ events: [{
        id: 'espn-event-1', competitions: [{ competitors: [
          { homeAway: 'home', team: { displayName: 'Nebraska Cornhuskers' }, score: '0' },
          { homeAway: 'away', team: { displayName: 'Iowa Hawkeyes' }, score: '0' },
        ], broadcasts: [{ names: ['ESPN'] }, { names: ['ESPN +'] }] }],
      }] }), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ tv: string }> };
    expect(body.games[0]?.tv).toBe('ESPN+');
  });

  it('does not overwrite CFBD media with ESPN broadcast overlay', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/games/media')) return new Response(JSON.stringify([{ id: 1, outlet: 'BTN' }]), { status: 200 });
      if (url.includes('/lines')) return new Response('[]', { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]), { status: 200 });
      if (url.includes('/scoreboard?')) return new Response(JSON.stringify({ events: [{
        id: 'different-espn-id', competitions: [{ competitors: [
          { homeAway: 'home', team: { displayName: 'Nebraska Cornhuskers' } },
          { homeAway: 'away', team: { displayName: 'Iowa Hawkeyes' } },
        ], broadcasts: [{ names: ['ESPN+'] }] }],
      }] }), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ tv: string }> };
    expect(body.games[0]?.tv).toBe('BTN');
  });

  it('falls back permissively when the FBS team lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/teams/fbs')
      ? new Response('unavailable', { status: 503 })
      : String(input).includes('collegefootballdata.com')
        ? new Response(JSON.stringify([cfbdGame(1, 3, 4)]), { status: 200 })
        : new Response(JSON.stringify({ events: [] }), { status: 200 })));

    const response = await onRequest(context());
    const body = await response.json() as { games: unknown[] };
    expect(response.status).toBe(200);
    expect(body.games).toHaveLength(1);
  });

});
