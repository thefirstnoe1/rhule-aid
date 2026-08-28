import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../src/api/cfb-schedule.ts';

function request(division?: 'all', week = '1') {
  return new Request(`https://rhule-aid.com/api/cfb-schedule?season=2025&week=${week}${division ? `&division=${division}` : ''}`);
}

function context(division?: 'all', week = '1'): Parameters<typeof onRequest>[0] {
  return { request: request(division, week), env: { CFBD_API_KEY: 'test-key' } } as Parameters<typeof onRequest>[0];
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

  it('adds AP Top 25 ranks and resolves provider name variants', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/rankings?')) return new Response(JSON.stringify([
        { week: 1, seasonType: 'regular', polls: [{ poll: 'Coaches Poll', ranks: [{ rank: 1, school: 'Nebraska' }] }, { poll: 'AP Top 25', ranks: [{ rank: 7, school: 'Nebraska Cornhuskers' }] }] },
      ]), { status: 200 });
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]', { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ homeTeam: { rank?: number }; awayTeam: { rank?: number } }> };
    const rankingsRequest = vi.mocked(fetch).mock.calls.find(call => String(call[0]).includes('/rankings?'))?.[0];
    expect(String(rankingsRequest)).not.toContain('poll=ap');
    expect(body.games[0]?.homeTeam.rank).toBe(7);
    expect(body.games[0]?.awayTeam.rank).toBeUndefined();
  });

  it('uses earliest preseason AP snapshot for week one and never uses a later poll', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/rankings?')) return new Response(JSON.stringify([
        { week: 0, seasonType: 'regular', polls: [{ poll: 'AP Top 25', ranks: [{ rank: 11, school: 'Nebraska' }] }] },
        { week: 2, seasonType: 'regular', polls: [{ poll: 'AP Top 25', ranks: [{ rank: 2, school: 'Nebraska' }] }] },
        { week: 1, seasonType: 'postseason', polls: [{ poll: 'AP Top 25', ranks: [{ rank: 1, school: 'Nebraska' }] }] },
      ]), { status: 200 });
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]', { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ homeTeam: { rank?: number } }> };
    expect(body.games[0]?.homeTeam.rank).toBe(11);
  });

  it('uses greatest prior AP snapshot when the requested week has no poll', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/rankings?')) return new Response(JSON.stringify([
        { week: 1, seasonType: 'regular', polls: [{ poll: 'AP Top 25', ranks: [{ rank: 7, school: 'Nebraska' }] }] },
        { week: 3, seasonType: 'regular', polls: [{ poll: 'AP Top 25', ranks: [{ rank: 2, school: 'Nebraska' }] }] },
      ]), { status: 200 });
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]', { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context(undefined, '2'));
    const body = await response.json() as { games: Array<{ homeTeam: { rank?: number } }> };
    expect(body.games[0]?.homeTeam.rank).toBe(7);
  });

  it('leaves teams unranked when CFBD rankings are unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/rankings?')) return new Response('unavailable', { status: 503 });
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]', { status: 200 });
      if (url.includes('/games?')) return new Response(JSON.stringify([cfbdGame(1)]), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ homeTeam: { rank?: number }; awayTeam: { rank?: number } }> };
    expect(response.status).toBe(200);
    expect(body.games[0]?.homeTeam.rank).toBeUndefined();
    expect(body.games[0]?.awayTeam.rank).toBeUndefined();
  });

  it('recovers from a transient CFBD games failure', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }]), { status: 200 });
      if (url.includes('/games?')) {
        attempts++;
        if (attempts === 1) return new Response('busy', { status: 503 });
        return new Response(JSON.stringify([cfbdGame(1)]), { status: 200 });
      }
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]', { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: unknown[] };
    expect(response.status).toBe(200);
    expect(body.games).toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it('retries unclassified games when the FBS classification request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/teams?')) return new Response(JSON.stringify([{ id: 1, classification: 'fbs' }, { id: 2, classification: 'fbs' }, { id: 3, classification: 'fcs' }, { id: 4, classification: 'fcs' }]), { status: 200 });
      if (url.includes('/games?')) return url.includes('classification=fbs')
        ? new Response('unsupported', { status: 400 })
        : new Response(JSON.stringify([cfbdGame(1, 1, 2), cfbdGame(2, 3, 4)]), { status: 200 });
      if (url.includes('/games/media') || url.includes('/lines')) return new Response('[]', { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context());
    const body = await response.json() as { games: Array<{ id: string }> };
    expect(response.status).toBe(200);
    expect(body.games.map(game => game.id)).toEqual(['1']);
    expect(vi.mocked(fetch).mock.calls.filter(call => String(call[0]).includes('/games?'))).toHaveLength(2);
  });

  it('waits for exhausted CFBD game retries before Core fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/games?')) return new Response('unavailable', { status: 503 });
      if (url.includes('/events?')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }));

    const response = await onRequest(context('all'));
    const gamesAttempts = vi.mocked(fetch).mock.calls.filter(call => String(call[0]).includes('/games?'));
    const coreAttempt = vi.mocked(fetch).mock.calls.find(call => String(call[0]).includes('/events?'));
    expect(response.status).toBe(502);
    expect(gamesAttempts).toHaveLength(3);
    expect(coreAttempt).toBeDefined();
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
