import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../src/api/cfb-schedule.ts';

function request(division?: 'all') {
  return new Request(`https://rhule-aid.com/api/cfb-schedule?season=2025&week=1${division ? `&division=${division}` : ''}`);
}

function context(division?: 'all'): Parameters<typeof onRequest>[0] {
  return { request: request(division), env: { CFBD_API_KEY: 'test-key' } } as Parameters<typeof onRequest>[0];
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
