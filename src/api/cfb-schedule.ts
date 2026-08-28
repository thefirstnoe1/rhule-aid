import type { ScheduleMatch, Context } from '../types';

interface CFBDGame {
  id?: number | string;
  week?: number;
  startDate?: string;
  startTimeTBD?: boolean;
  homeTeam?: string;
  awayTeam?: string;
  homeId?: number;
  awayId?: number;
  homePoints?: number;
  awayPoints?: number;
  venue?: string;
  neutralSite?: boolean;
  status?: string;
  homeDivision?: string;
  awayDivision?: string;
  homeClassification?: string;
  awayClassification?: string;
  homeSubdivision?: string;
  awaySubdivision?: string;
}
interface CFBDMedia { id?: number | string; outlet?: string }
interface CFBDCalendarEntry { week?: number | string; seasonType?: string }
interface CFBDLine { provider?: string; spread?: number | string | null; formattedSpread?: string | null }
interface CFBDLinesGame { id?: number | string; lines?: CFBDLine[] }
type FBSTeamMetadata = { ids: Set<number>; fcsIds: Set<number>; conferences: Map<number, string> };

type GameDivision = 'FBS' | 'FCS' | 'unknown';
type ClassifiedScheduleMatch = ScheduleMatch & {
  division: GameDivision;
  homeDivision: GameDivision;
  awayDivision: GameDivision;
  homeTeamId?: number;
  awayTeamId?: number;
};

interface ESPNResponse { events: ESPNGame[]; leagues: unknown[] }
interface ESPNGame {
  id: string;
  date?: string;
  week?: { number?: number };
  competitions?: Array<{
    date?: string;
    competitors?: Array<{ homeAway: 'home' | 'away'; score?: string; team: { displayName?: string; shortDisplayName?: string; name?: string; abbreviation?: string; logo?: string; conferenceId?: string; location?: string } }>;
    status?: { type?: { description?: string; completed?: boolean } };
    venue?: { fullName?: string; address?: { city?: string; state?: string; country?: string } };
    broadcasts?: Array<{ names?: string[] }>;
    odds?: Array<{ details?: string }>;
  }>;
}

interface CoreEventList { items: Array<{ $ref?: string }> }
interface CoreCompetition { $ref?: string; id?: string; date?: string; competitors?: CoreCompetitor[]; venue?: { fullName?: string }; status?: { type?: { description?: string; completed?: boolean } } }
interface CoreEvent { id: string; date?: string; name?: string; shortName?: string; week?: { number?: number }; competitions?: CoreCompetition[] }
interface CoreCompetitor { homeAway: 'home' | 'away'; score?: unknown; team?: { id?: string; displayName?: string; name?: string; abbreviation?: string; shortDisplayName?: string; conferenceId?: string; division?: string; subdivision?: string; classification?: string; logos?: Array<{ href?: string }> } }

const CFBD_BASE = 'https://api.collegefootballdata.com/games';
const CFBD_LINES_BASE = 'https://api.collegefootballdata.com/lines';
const CORE_BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football';
const CACHE_SCHEMA = 'v18';
const CORE_MAX_DETAIL_REQUESTS = 8;
const FBS_TEAM_CACHE_TTL = 86400;
const CALENDAR_CACHE_TTL = 86400;

export async function onRequest(context: Context): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const season = getSeason(url);
  const week = url.searchParams.get('week') || '1';
  const date = url.searchParams.get('date') || '';
  const division = url.searchParams.get('division') === 'all' ? 'all' : 'fbs';
  const cacheKey = `cfb-schedule:${CACHE_SCHEMA}:${season}:${week}:${date || 'current'}:${division}`;
  const cached = await readCache(env, cacheKey);
  if (cached) return jsonResponse(cached, 200, 900);

  let games: ScheduleMatch[] = [];
  let calendarWeeks: ScheduleWeek[] | null = null;
  if (env.CFBD_API_KEY) {
    try {
      const [cfbdGames, fbsTeams, media, lines, calendar] = await Promise.all([
        fetchCFBD(season, week, env.CFBD_API_KEY, division),
        getFBSTeamMetadata(env, season, env.CFBD_API_KEY),
        fetchCFBDMedia(season, week, env.CFBD_API_KEY),
        fetchCFBDLines(season, week, env.CFBD_API_KEY),
        fetchCFBDCalendar(env, season, env.CFBD_API_KEY),
      ]);
      calendarWeeks = calendar;
      games = cfbdGames.map(game => normalizeCFBDGame(game, season, week, fbsTeams, media, lines)).filter(isGame).sort(sortGames);
      if (division === 'fbs' && fbsTeams) {
        games = games.filter(game => {
          const classified = game as ClassifiedScheduleMatch;
          return classified.homeTeamId !== undefined && classified.awayTeamId !== undefined && fbsTeams.ids.has(classified.homeTeamId) && fbsTeams.ids.has(classified.awayTeamId);
        });
      }
    } catch (error) {
      console.warn('CFBD schedule unavailable; using bounded ESPN Core fallback:', error);
    }
  }

  if (games.length === 0) {
    try {
      games = await fetchCoreFallback(season, week);
    } catch (error) {
      console.warn('ESPN Core schedule fallback unavailable:', error);
    }
  }

  // ESPN is advisory only. It can add current scores/status without becoming required.
  try {
    const overlay = await fetchScoreboard(season, week, date);
    games = mergeOverlay(games, overlay);
  } catch (error) {
    console.warn('ESPN scoreboard overlay unavailable:', error);
  }

  if (division === 'fbs') games = games.filter(game => isFBSGame(game as ClassifiedScheduleMatch));

  if (games.length === 0) return jsonResponse({ games: [], weeks: [], lastUpdated: new Date().toISOString(), hasLiveGames: false, error: 'Schedule data unavailable from CFBD and ESPN' }, 502, 0);

  const result = makeResult(games, week, calendarWeeks || [{ label: `Week ${week}`, value: week }]);
  const ttl = result.hasLiveGames ? 60 : 900;
  await writeCache(env, cacheKey, result, ttl);
  return jsonResponse(result, 200, ttl);
}

async function fetchCFBD(season: number, week: string, key: string, division: 'fbs' | 'all'): Promise<CFBDGame[]> {
  const params = new URLSearchParams({ year: String(season), seasonType: 'regular', week });
  if (division === 'fbs') params.set('classification', 'fbs');
  const endpoint = `${CFBD_BASE}?${params}`;
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`CFBD request failed: ${response.status}`);
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error('Invalid CFBD games response');
  return data as CFBDGame[];
}

async function fetchCFBDMedia(season: number, week: string, key: string): Promise<Map<string, string>> {
  // Do not restrict this request to TV: CFBD returns streaming outlets such
  // as ESPN+ through its all-media response.
  const params = new URLSearchParams({ year: String(season), seasonType: 'regular', week });
  try {
    const response = await fetch(`https://api.collegefootballdata.com/games/media?${params}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`CFBD media failed: ${response.status}`);
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw new Error('Invalid CFBD media response');
    const selected = new Map<string, string>();
    for (const row of data) {
      const media = row as CFBDMedia;
      if (media.id === undefined || !media.outlet) continue;
      const id = String(media.id);
      const outlet = normalizeMediaOutlet(media.outlet);
      const current = selected.get(id);
      if (!current || mediaOutletRank(outlet) < mediaOutletRank(current) ||
        (mediaOutletRank(outlet) === mediaOutletRank(current) && outlet.localeCompare(current) < 0)) selected.set(id, outlet);
    }
    return selected;
  } catch (error) {
    console.warn('CFBD game media unavailable; retaining TBD TV values:', error);
    return new Map();
  }
}

function normalizeMediaOutlet(outlet: string): string {
  const normalized = outlet.trim().replace(/\s+/g, ' ');
  if (/^espn\s*\+$/i.test(normalized)) return 'ESPN+';
  if (/^disney\s*\+$/i.test(normalized)) return 'Disney+';
  return normalized;
}

function mediaOutletRank(outlet: string): number {
  if (outlet.toLowerCase() === 'espn') return 0;
  if (outlet === 'ESPN+') return 1;
  if (outlet === 'Disney+') return 2;
  return 3;
}

interface ScheduleWeek { label: string; value: string }

async function fetchCFBDCalendar(env: Context['env'], season: number, key: string): Promise<ScheduleWeek[] | null> {
  const cacheKey = `cfb-schedule:${CACHE_SCHEMA}:calendar:${season}`;
  try {
    const cached = await env.CFB_SCHEDULE_CACHE?.get(cacheKey);
    if (cached) {
      const data = JSON.parse(cached) as { weeks?: ScheduleWeek[] };
      if (Array.isArray(data.weeks) && data.weeks.length) return data.weeks;
    }
    const params = new URLSearchParams({ year: String(season), seasonType: 'regular' });
    const response = await fetch(`https://api.collegefootballdata.com/calendar?${params}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`CFBD calendar failed: ${response.status}`);
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw new Error('Invalid CFBD calendar response');
    const values = [...new Set(data.flatMap(row => {
      const entry = row as CFBDCalendarEntry;
      return entry.seasonType && entry.seasonType.toLowerCase() !== 'regular' ? [] : entry.week === undefined ? [] : [String(entry.week).trim()];
    }).filter(value => /^\d+$/.test(value)))].sort((a, b) => Number(a) - Number(b));
    if (!values.length) throw new Error('CFBD calendar response had no regular-season weeks');
    const weeks = values.map(value => ({ label: `Week ${value}`, value }));
    await env.CFB_SCHEDULE_CACHE?.put(cacheKey, JSON.stringify({ weeks }), { expirationTtl: CALENDAR_CACHE_TTL });
    return weeks;
  } catch (error) {
    console.warn('CFBD calendar unavailable; retaining requested week:', error);
    return null;
  }
}

const LINE_PROVIDER_PRIORITY = ['consensus', 'espn', 'draftkings', 'fanduel'];

async function fetchCFBDLines(season: number, week: string, key: string): Promise<Map<string, string>> {
  const params = new URLSearchParams({ year: String(season), seasonType: 'regular', week });
  try {
    const response = await fetch(`${CFBD_LINES_BASE}?${params}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`CFBD lines failed: ${response.status}`);
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw new Error('Invalid CFBD lines response');
    const selected = new Map<string, CFBDLine>();
    for (const row of data) {
      if (!row || typeof row !== 'object') continue;
      const game = row as CFBDLinesGame;
      if (game.id === undefined || !Array.isArray(game.lines)) continue;
      for (const line of game.lines) {
        if (!line?.provider || !normalizeSpread(line.formattedSpread, line.spread)) continue;
        const current = selected.get(String(game.id));
        if (!current || providerRank(line.provider) < providerRank(current.provider || '') ||
          (providerRank(line.provider) === providerRank(current.provider || '') && line.provider.localeCompare(current.provider || '') < 0)) {
          selected.set(String(game.id), line);
        }
      }
    }
    return new Map([...selected].flatMap(([id, line]) => {
      const spread = normalizeSpread(line.formattedSpread, line.spread);
      return spread ? [[id, spread] as [string, string]] : [];
    }));
  } catch (error) {
    console.warn('CFBD game lines unavailable; retaining ESPN/TBD values:', error);
    return new Map();
  }
}

function providerRank(provider: string): number {
  const rank = LINE_PROVIDER_PRIORITY.indexOf(provider.trim().toLowerCase());
  return rank === -1 ? LINE_PROVIDER_PRIORITY.length : rank;
}

function normalizeSpread(formattedSpread?: string | null, spread?: number | string | null): string | null {
  if (typeof formattedSpread === 'string' && formattedSpread.trim()) return formattedSpread.trim();
  if (typeof spread === 'number' && Number.isFinite(spread)) return String(spread);
  if (typeof spread === 'string' && spread.trim() && Number.isFinite(Number(spread))) return spread.trim();
  return null;
}

async function getFBSTeamMetadata(env: Context['env'], season: number, key: string): Promise<FBSTeamMetadata | null> {
  const cacheKey = `cfb-schedule:${CACHE_SCHEMA}:fbs-team-metadata:v1:${season}`;
  try {
    const cached = await env.CFB_SCHEDULE_CACHE?.get(cacheKey);
    if (cached) {
      const data = JSON.parse(cached) as { teams?: Array<{ id: number; conference?: string; classification?: string }> };
      if (Array.isArray(data.teams)) return makeFBSTeamMetadata(data.teams);
    }
    const response = await fetch(`https://api.collegefootballdata.com/teams?year=${season}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`CFBD team metadata failed: ${response.status}`);
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw new Error('Invalid CFBD team metadata response');
    const teams = data.map(team => ({ id: Number((team as { id?: number }).id), conference: (team as { conference?: string }).conference, classification: (team as { classification?: string }).classification })).filter(team => Number.isInteger(team.id));
    if (!teams.length || !teams.some(team => normalizeDivision(team.classification) !== 'unknown')) throw new Error('CFBD team metadata response had no recognized classifications');
    await env.CFB_SCHEDULE_CACHE?.put(cacheKey, JSON.stringify({ teams }), { expirationTtl: FBS_TEAM_CACHE_TTL });
    return makeFBSTeamMetadata(teams);
  } catch (error) {
    console.warn('CFBD FBS team lookup unavailable; retaining permissive schedule:', error);
    return null;
  }
}

function makeFBSTeamMetadata(teams: Array<{ id: number; conference?: string; classification?: string }>): FBSTeamMetadata {
  const classified = teams.map(team => ({ ...team, division: normalizeDivision(team.classification) }));
  return {
    ids: new Set(classified.filter(team => team.division === 'FBS').map(team => team.id)),
    fcsIds: new Set(classified.filter(team => team.division === 'FCS').map(team => team.id)),
    conferences: new Map(classified.filter(team => team.conference).map(team => [team.id, team.conference!])),
  };
}

function gameDivisionFromTeam(supplied: Array<string | undefined>, teamId: number | undefined, metadata?: FBSTeamMetadata | null): GameDivision {
  const gameDivision = supplied.map(normalizeDivision).find(division => division !== 'unknown') || 'unknown';
  if (gameDivision !== 'unknown') return gameDivision;
  if (teamId !== undefined && metadata?.ids.has(teamId)) return 'FBS';
  if (teamId !== undefined && metadata?.fcsIds.has(teamId)) return 'FCS';
  return 'unknown';
}

function normalizeCFBDGame(game: CFBDGame, season: number, requestedWeek: string, metadata?: FBSTeamMetadata | null, media?: Map<string, string>, lines?: Map<string, string>): ScheduleMatch | null {
  if (!game.homeTeam || !game.awayTeam) return null;
  const datetime = game.startDate || '';
  const parsed = datetime ? new Date(datetime) : null;
  const validDate = parsed && !Number.isNaN(parsed.getTime());
  const completed = typeof game.homePoints === 'number' && typeof game.awayPoints === 'number';
  const status = game.status || (completed ? 'Final' : 'Scheduled');
  const homeDivision = gameDivisionFromTeam([game.homeDivision, game.homeClassification, game.homeSubdivision], game.homeId, metadata);
  const awayDivision = gameDivisionFromTeam([game.awayDivision, game.awayClassification, game.awaySubdivision], game.awayId, metadata);
  return {
    id: String(game.id || `${season}-${requestedWeek}-${game.awayTeam}-${game.homeTeam}`),
    date: validDate ? centralDate(parsed!) : 'TBD',
    time: validDate && hasKickoffTime(datetime) && game.startTimeTBD !== true ? centralTime(parsed!) : 'TBD',
    datetime,
    week: Number(game.week) || Number(requestedWeek) || 0,
    homeTeam: scheduleTeam(game.homeTeam, game.homeId, game.homePoints, metadata?.conferences.get(game.homeId ?? 0)),
    awayTeam: scheduleTeam(game.awayTeam, game.awayId, game.awayPoints, metadata?.conferences.get(game.awayId ?? 0)),
    venue: game.venue || 'TBD',
    location: game.venue || 'TBD',
    tv: media?.get(String(game.id)) || 'TBD', status, isCompleted: completed || /final|completed/i.test(status), spread: lines?.get(String(game.id)) || null,
    homeDivision, awayDivision, division: gameDivision(homeDivision, awayDivision),
    homeTeamId: game.homeId,
    awayTeamId: game.awayId,
  } as ClassifiedScheduleMatch;
}

function scheduleTeam(name: string, id?: number, score?: number, conference?: string) {
  return { name, shortName: name, logo: id ? `/api/logo?teamId=${id}&size=128` : `/api/logo?team=${encodeURIComponent(name)}&size=128`, score: typeof score === 'number' ? score : 0, conference: conference || 'Independent' };
}

function hasKickoffTime(datetime: string): boolean {
  return /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(datetime);
}

async function fetchScoreboard(season: number, week: string, date: string): Promise<ESPNGame[]> {
  const params = new URLSearchParams({ groups: '80', limit: '1000', week, dates: date || String(season), seasontype: '2' });
  const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?${params}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`ESPN scoreboard failed: ${response.status}`);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || !Array.isArray((data as ESPNResponse).events)) throw new Error('Invalid ESPN scoreboard response');
  return (data as ESPNResponse).events;
}

async function fetchCoreFallback(season: number, week: string): Promise<ScheduleMatch[]> {
  const response = await fetch(`${CORE_BASE}/seasons/${season}/types/2/weeks/${encodeURIComponent(week)}/events?limit=1000`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`ESPN Core week failed: ${response.status}`);
  const list: unknown = await response.json();
  if (!list || typeof list !== 'object' || !Array.isArray((list as CoreEventList).items)) throw new Error('Invalid ESPN Core week response');
  const refs = (list as CoreEventList).items.filter(item => typeof item.$ref === 'string').slice(0, Math.floor(CORE_MAX_DETAIL_REQUESTS / 2));
  const games: ScheduleMatch[] = [];
  for (const item of refs) {
    try {
      const event = await fetchCoreJson(item.$ref!) as CoreEvent;
      const competitionRef = event.competitions?.[0];
      const competition = competitionRef?.$ref ? await fetchCoreJson(competitionRef.$ref) as CoreCompetition : competitionRef;
      const game = normalizeCore(event, competition, week);
      if (game) games.push(game);
    } catch (error) { console.warn('Skipping invalid Core event:', error); }
  }
  return games.sort(sortGames);
}

async function fetchCoreJson(ref: string): Promise<unknown> {
  const url = new URL(ref.replace(/^http:/, 'https:'));
  if (url.hostname !== 'sports.core.api.espn.com') throw new Error('Invalid Core reference');
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`ESPN Core detail failed: ${response.status}`);
  return await response.json() as CoreEvent;
}

function normalizeCore(event: CoreEvent, competition: CoreCompetition | undefined, requestedWeek: string): ScheduleMatch | null {
  const home = competition?.competitors?.find(team => team.homeAway === 'home');
  const away = competition?.competitors?.find(team => team.homeAway === 'away');
  const datetime = competition?.date || event.date || '';
  if (!competition || !home || !away || !datetime || !home.team || !away.team) return null;
  const parsed = new Date(datetime); if (Number.isNaN(parsed.getTime())) return null;
  const homeDivision = coreDivision(home);
  const awayDivision = coreDivision(away);
  return { id: event.id, date: centralDate(parsed), time: hasKickoffTime(datetime) ? centralTime(parsed) : 'TBD', datetime, week: event.week?.number || Number(requestedWeek) || 0, homeTeam: coreTeam(home), awayTeam: coreTeam(away), venue: competition.venue?.fullName || 'TBD', location: 'TBD', tv: 'TBD', status: competition.status?.type?.description || 'Scheduled', isCompleted: competition.status?.type?.completed || false, spread: null, homeDivision, awayDivision, division: gameDivision(homeDivision, awayDivision) } as ClassifiedScheduleMatch;
}

function coreTeam(competitor: CoreCompetitor) { const team = competitor.team!; return { name: team.displayName || team.name || 'Unknown Team', shortName: team.shortDisplayName || team.abbreviation || team.name || 'Unknown', logo: team.logos?.[0]?.href || '/images/logos/default-logo.png', score: Number(competitor.score) || 0, conference: 'Independent' }; }
function centralDate(date: Date): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(date); }
function centralTime(date: Date): string { return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago', timeZoneName: 'short' }); }
function sortGames(a: ScheduleMatch, b: ScheduleMatch): number { return a.datetime.localeCompare(b.datetime); }
function isGame(game: ScheduleMatch | null): game is ScheduleMatch { return game !== null; }

function normalizeDivision(value?: string): GameDivision {
  if (!value) return 'unknown';
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === 'fbs' || normalized === 'division1fbs' || normalized === 'd1fbs') return 'FBS';
  if (normalized === 'fcs' || normalized === 'division1fcs' || normalized === 'd1fcs') return 'FCS';
  return 'unknown';
}

function coreDivision(competitor: CoreCompetitor): GameDivision {
  const team = competitor.team;
  if (!team) return 'unknown';
  const supplied = normalizeDivision(team.division || team.subdivision || team.classification);
  if (supplied !== 'unknown') return supplied;
  // ESPN Core commonly exposes conferenceId rather than an explicit subdivision.
  return FBS_CONFERENCE_IDS.has(String(team.conferenceId)) ? 'FBS' : 'unknown';
}

const FBS_CONFERENCE_IDS = new Set(['7', '8', '9', '12', '15', '16', '17', '18', '23', '25', '37']);
function gameDivision(home: GameDivision, away: GameDivision): GameDivision {
  return home === 'FBS' || away === 'FBS' ? 'FBS' : home === 'FCS' || away === 'FCS' ? 'FCS' : 'unknown';
}
function isFBSGame(game: ClassifiedScheduleMatch): boolean {
  // CFBD's games endpoint can omit division metadata. Treat that absence as
  // advisory rather than as evidence that a game is non-FBS, while retaining
  // the explicit FCS exclusion.
  if (game.homeDivision === 'FBS' || game.awayDivision === 'FBS') return true;
  return game.homeDivision !== 'FCS' && game.awayDivision !== 'FCS';
}

function mergeOverlay(games: ScheduleMatch[], events: ESPNGame[]): ScheduleMatch[] {
  return games.map(game => {
    const match = events.find(event => event.id === game.id || event.competitions?.[0]?.competitors?.some(c => c.homeAway === 'home' && sameTeam(c.team.displayName, game.homeTeam.name)) && event.competitions?.[0]?.competitors?.some(c => c.homeAway === 'away' && sameTeam(c.team.displayName, game.awayTeam.name)));
    const competition = match?.competitions?.[0]; if (!competition) return game;
    const home = competition.competitors?.find(c => c.homeAway === 'home'); const away = competition.competitors?.find(c => c.homeAway === 'away');
    const currentSpread = competition.odds?.find(odd => typeof odd.details === 'string' && odd.details.trim())?.details?.trim();
    const broadcast = game.tv === 'TBD' ? extractBroadcastNames(competition.broadcasts) : null;
    return { ...game, ...(home ? { homeTeam: { ...game.homeTeam, score: Number(home.score) || 0 } } : {}), ...(away ? { awayTeam: { ...game.awayTeam, score: Number(away.score) || 0 } } : {}), ...(competition.status?.type?.description ? { status: competition.status.type.description } : {}), ...(competition.status?.type?.completed !== undefined ? { isCompleted: competition.status.type.completed } : {}), tv: broadcast || game.tv, spread: currentSpread || game.spread };
  });
}

function sameTeam(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  const normalizedLeft = normalizeTeamName(left);
  const normalizedRight = normalizeTeamName(right);
  if (normalizedLeft === normalizedRight) return true;

  // ESPN sometimes appends a mascot to the provider's school name. Only
  // accept a one-sided, word-boundary match for names of reasonable length;
  // broad fuzzy matching can join unrelated games (for example, Miami and
  // Miami (OH)).
  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = shorter === normalizedLeft ? normalizedRight : normalizedLeft;
  return shorter.length >= 4 && new RegExp(`^${escapeRegExp(shorter)}(?: |$)`).test(longer);
}

function normalizeTeamName(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBroadcastNames(broadcasts?: Array<{ names?: string[] }>): string | null {
  const names = (broadcasts || []).flatMap(broadcast => broadcast.names || [])
    .map(name => name.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .map(name => /^espn\s*\+$/i.test(name) ? 'ESPN+' : name);
  const unique = [...new Map(names.map(name => [name.toLowerCase(), name])).values()];
  return unique.find(name => name === 'ESPN+') || unique.join(', ') || null;
}

function makeResult(games: ScheduleMatch[], week: string, weeks: ScheduleWeek[]) { return { games, weeks, lastUpdated: new Date().toISOString(), hasLiveGames: games.some(game => !game.isCompleted && /q|half|ot|quarter/i.test(game.status)) }; }
async function readCache(env: Context['env'], key: string): Promise<any | null> { if (!env.CFB_SCHEDULE_CACHE) return null; try { const value = await env.CFB_SCHEDULE_CACHE.get(key); return value ? JSON.parse(value) : null; } catch { return null; } }
async function writeCache(env: Context['env'], key: string, value: unknown, ttl: number): Promise<void> { if (env.CFB_SCHEDULE_CACHE && Array.isArray((value as { games?: unknown[] }).games) && (value as { games: unknown[] }).games.length) try { await env.CFB_SCHEDULE_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl }); } catch (error) { console.warn('Failed to write CFB schedule cache:', error); } }
function jsonResponse(body: unknown, status: number, maxAge: number): Response { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store' } }); }
function getSeason(url: URL): number { const requested = url.searchParams.get('season'); if (requested && /^\d{4}$/.test(requested)) return Number(requested); const now = new Date(); return now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear(); }
