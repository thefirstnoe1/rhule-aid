'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SurfaceCard } from '../components/ui';

type Team = {
  name: string;
  shortName: string;
  logo: string;
  rank?: number;
  conference: string;
  score: number;
};

type Game = {
  id: string;
  date: string;
  time: string;
  datetime: string;
  week: number;
  homeTeam: Team;
  awayTeam: Team;
  venue: string;
  location: string;
  tv: string;
  status: string;
  isCompleted: boolean;
  spread: string | null;
  division?: string;
};

export type CFBScheduleData = {
  games: Game[];
  weeks: Array<{ value: string; label: string }>;
  lastUpdated?: string;
  hasLiveGames?: boolean;
  error?: string;
};

type Filters = {
  week: string;
  conference: string;
  division: 'FBS' | 'FCS' | 'FBS_FCS' | 'all';
  status: string;
  rankedOnly: boolean;
};

type LayoutMode = 'cards' | 'compact' | 'tv';

const conferences = ['Big Ten', 'SEC', 'ACC', 'Big 12', 'Pac-12', 'Mountain West', 'American', 'Conference USA', 'MAC', 'Sun Belt', 'Independent'];

const timezones = [
  { value: 'America/Chicago', label: 'Central' },
  { value: 'America/New_York', label: 'Eastern' },
  { value: 'America/Denver', label: 'Mountain' },
  { value: 'America/Los_Angeles', label: 'Pacific' },
  { value: 'UTC', label: 'UTC' }
];

const layoutModes: Array<{ value: LayoutMode; label: string }> = [
  { value: 'cards', label: 'Cards' },
  { value: 'compact', label: 'Compact' },
  { value: 'tv', label: 'TV Grid' }
];

export function CFBScheduleExplorer({ initialData }: { initialData: CFBScheduleData }) {
  const [scheduleData, setScheduleData] = useState(initialData);
  const [filters, setFilters] = useState<Filters>({ week: initialData.weeks[0]?.value || '', conference: '', division: 'FBS_FCS', status: '', rankedOnly: false });
  const [timezone, setTimezone] = useState('America/Chicago');
  const [layout, setLayout] = useState<LayoutMode>('cards');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [noSpoilers, setNoSpoilers] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(Boolean(initialData.error));
  const [announcement, setAnnouncement] = useState(initialData.error ? 'Unable to load schedule data.' : '');
  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);
  // Server-rendered data uses backend default FBS; hydrate board with explicit all.
  const divisionRef = useRef<Filters['division']>('FBS');

  const filteredGames = useMemo(() => {
    return scheduleData.games.filter((game) => {
      if (filters.division === 'FBS' && game.division !== 'FBS') return false;
      if (filters.division === 'FCS' && game.division !== 'FCS') return false;
      if (filters.division === 'FBS_FCS' && game.division !== 'FBS' && game.division !== 'FCS') return false;
      if (filters.week && game.week.toString() !== filters.week) return false;
      if (filters.conference && game.homeTeam.conference !== filters.conference && game.awayTeam.conference !== filters.conference) return false;
      if (filters.status && getGameStatus(game) !== filters.status) return false;
      if (filters.rankedOnly && !game.homeTeam.rank && !game.awayTeam.rank) return false;
      return true;
    });
  }, [filters, scheduleData.games]);

  const gamesByDate = useMemo(() => {
    return filteredGames.reduce<Record<string, Game[]>>((groups, game) => {
      groups[game.date] = [...(groups[game.date] || []), game];
      return groups;
    }, {});
  }, [filteredGames]);

  const summary = useMemo(() => {
    return filteredGames.reduce<{ live: number; completed: number; ranked: number; networks: Set<string> }>((totals, game) => {
      const status = getGameStatus(game);
      if (status === 'live') totals.live += 1;
      if (status === 'completed') totals.completed += 1;
      if (game.homeTeam.rank || game.awayTeam.rank) totals.ranked += 1;
      if (game.tv && game.tv !== 'TBD') totals.networks.add(game.tv);
      return totals;
    }, { live: 0, completed: 0, ranked: 0, networks: new Set<string>() });
  }, [filteredGames]);

  const hasLiveGames = useMemo(() => scheduleData.games.some((game) => {
    if (filters.week && game.week.toString() !== filters.week) return false;
    return getGameStatus(game) === 'live';
  }), [filters.week, scheduleData.games]);

  const loadSchedule = useCallback(async (week = filters.week) => {
    if (loadingRef.current) return;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const division = filters.division;
    loadingRef.current = true;
    setLoading(true);
    setError(false);
    setAnnouncement(week ? `Loading week ${week}.` : 'Refreshing current board.');

    try {
      const url = new URL('/api/cfb-schedule', window.location.origin);
      if (week) url.searchParams.set('week', week);
      // Backend defaults to FBS. Combined and FCS views use the unfiltered
      // response, then get narrowed locally because backend supports only FBS or explicit all.
      if (division !== 'FBS') url.searchParams.set('division', 'all');

      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json() as CFBScheduleData;
      if (data.error) throw new Error(data.error);
      if (requestId !== requestIdRef.current) return;

      const returnedWeeks = Array.isArray(data.weeks) ? data.weeks : [];
      const selectedWeek = week || returnedWeeks[0]?.value || '';
      setScheduleData({
        games: Array.isArray(data.games) ? data.games : [],
        weeks: returnedWeeks,
        lastUpdated: data.lastUpdated,
        hasLiveGames: Boolean(data.hasLiveGames)
      });
      setFilters((current) => ({ ...current, week: selectedWeek }));
      setAnnouncement(week ? `Week ${week} loaded.` : 'Current board refreshed.');
    } catch (loadError) {
      console.error('Error loading CFB schedule:', loadError);
      setError(true);
      setAnnouncement(week ? `Unable to load week ${week}. Existing schedule data remains displayed.` : 'Unable to refresh the current board. Existing schedule data remains displayed.');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [filters.division, filters.week]);

  useEffect(() => {
    if (divisionRef.current === filters.division) return;
    divisionRef.current = filters.division;
    void loadSchedule(filters.week);
  }, [filters.division, filters.week, loadSchedule]);

  function selectWeek(week: string) {
    void loadSchedule(week);
  }

  useEffect(() => {
    if (!autoRefresh || !hasLiveGames) return undefined;

    const interval = window.setInterval(() => {
      void loadSchedule();
    }, 300000);

    return () => window.clearInterval(interval);
  }, [autoRefresh, hasLiveGames, loadSchedule]);

  return (
    <div className="container-shell pb-20">
      <SurfaceCard className="mb-5 overflow-hidden rounded-[2rem]">
        <div className="grid border-b border-[var(--border)] md:grid-cols-4">
          <Stat label="Games Showing" value={filteredGames.length.toString()} />
          <Stat label="Live" value={summary.live.toString()} tone="scarlet" />
          <Stat label="Ranked Matchups" value={summary.ranked.toString()} />
          <Stat label="Networks" value={summary.networks.size.toString()} />
        </div>

        <div className="grid gap-4 p-4 md:p-5 xl:grid-cols-[1fr_auto] xl:items-center">
          <div className="flex flex-wrap gap-2">
            <PillSelect id="cfb-week" label="Week" value={filters.week} onChange={selectWeek} disabled={loading}>
              {scheduleData.weeks.map((week) => <option key={week.value} value={week.value}>{week.label}</option>)}
            </PillSelect>

            <PillSelect id="cfb-conference" label="Conference" value={filters.conference} onChange={(value) => setFilters((current) => ({ ...current, conference: value }))}>
              <option value="">All Conferences</option>
              {conferences.map((conference) => <option key={conference} value={conference}>{conference}</option>)}
            </PillSelect>

            <PillSelect id="cfb-division" label="Division" value={filters.division} disabled={loading} onChange={(value) => {
              requestIdRef.current += 1;
              setFilters((current) => ({ ...current, division: value as Filters['division'] }));
            }}>
              <option value="FBS_FCS">FBS &amp; FCS</option>
              <option value="FBS">FBS</option>
              <option value="FCS">FCS</option>
              <option value="all">All Divisions</option>
            </PillSelect>

            <PillSelect id="cfb-status" label="Status" value={filters.status} onChange={(value) => setFilters((current) => ({ ...current, status: value }))}>
              <option value="">All Games</option>
              <option value="scheduled">Scheduled</option>
              <option value="live">Live</option>
              <option value="completed">Completed</option>
            </PillSelect>

            <PillSelect id="cfb-timezone" label="Time" value={timezone} onChange={setTimezone}>
              {timezones.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </PillSelect>

            <button
              type="button"
              onClick={() => setFilters((current) => ({ ...current, rankedOnly: !current.rankedOnly }))}
              aria-pressed={filters.rankedOnly}
              className={`rounded-full px-4 py-2 text-xs font-black uppercase tracking-[0.14em] transition ${filters.rankedOnly ? 'bg-[var(--scarlet)] text-white shadow-[0_14px_30px_var(--scarlet-shadow)]' : 'border border-[var(--border)] bg-[var(--surface-strong)] text-[var(--muted)] hover:text-[var(--foreground)]'}`}
            >
              Ranked Only
            </button>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center xl:justify-end">
            <div role="group" aria-label="Schedule layout" className="inline-flex rounded-full border border-[var(--border)] bg-[var(--surface-strong)] p-1">
              {layoutModes.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  onClick={() => setLayout(mode.value)}
                  aria-pressed={layout === mode.value}
                  className={`rounded-full px-3 py-2 text-xs font-black uppercase tracking-[0.14em] transition ${layout === mode.value ? 'bg-[var(--foreground)] text-[var(--background)]' : 'text-[var(--muted)] hover:text-[var(--foreground)]'}`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void loadSchedule()}
              disabled={loading}
              className="rounded-full bg-[var(--scarlet)] px-5 py-3 text-xs font-black uppercase tracking-[0.16em] text-white shadow-[0_18px_45px_var(--scarlet-shadow)] transition hover:bg-[var(--scarlet-dark)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? 'Refreshing' : 'Refresh'}
            </button>
            {scheduleData.lastUpdated && <p className="text-xs text-[var(--muted)]">Updated {new Date(scheduleData.lastUpdated).toLocaleTimeString()}</p>}
          </div>
        </div>
        <div className="flex justify-end border-t border-[var(--border)] px-4 py-3 md:px-5">
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => setAutoRefresh((enabled) => !enabled)}
              aria-pressed={autoRefresh}
              aria-label="Automatic live score updates"
              className="rounded-full border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-1.5 text-[0.65rem] font-black uppercase tracking-[0.14em] text-[var(--muted)] transition hover:border-[var(--scarlet)] hover:text-[var(--scarlet)]"
            >
              Auto live updates: {autoRefresh ? 'On' : 'Off'}
            </button>
            <button
              type="button"
              onClick={() => setNoSpoilers((enabled) => !enabled)}
              aria-pressed={noSpoilers}
              aria-label="Hide game scores"
              className={`rounded-full border px-3 py-1.5 text-[0.65rem] font-black uppercase tracking-[0.14em] transition ${noSpoilers ? 'border-[var(--scarlet)] bg-[color-mix(in_srgb,var(--scarlet)_12%,var(--surface-strong))] text-[var(--scarlet)]' : 'border-[var(--border)] bg-[var(--surface-strong)] text-[var(--muted)] hover:border-[var(--scarlet)] hover:text-[var(--scarlet)]'}`}
            >
              No spoilers: {noSpoilers ? 'On' : 'Off'}
            </button>
          </div>
        </div>
      </SurfaceCard>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>

      {error && (
        <SurfaceCard className="mb-6 rounded-[1.75rem] p-6 text-center">
          <h2 className="text-2xl font-black tracking-[-0.04em]">Unable to load schedule data.</h2>
          <p className="mt-2 text-sm text-[var(--muted)]">Try refreshing the schedule in a moment.</p>
        </SurfaceCard>
      )}

      {!error && !loading && filteredGames.length === 0 && (
        <SurfaceCard className="rounded-[1.75rem] p-8 text-center">
          <h2 className="text-2xl font-black tracking-[-0.04em]">No games match these filters.</h2>
          <p className="mt-2 text-sm text-[var(--muted)]">Try another week, conference, or status.</p>
        </SurfaceCard>
      )}

      <div className="grid gap-8">
        {Object.keys(gamesByDate).sort().map((date) => (
          <DateSection key={date} date={date} games={gamesByDate[date] || []} timezone={timezone} layout={layout} noSpoilers={noSpoilers} />
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'scarlet' }) {
  return (
    <div className="border-b border-[var(--border)] p-4 md:border-b-0 md:border-r md:last:border-r-0">
      <div className={`text-3xl font-black tracking-[-0.08em] ${tone === 'scarlet' ? 'text-[var(--scarlet)]' : 'text-[var(--foreground)]'}`}>{value}</div>
      <div className="mt-1 text-[0.65rem] font-black uppercase tracking-[0.16em] text-[var(--muted)]">{label}</div>
    </div>
  );
}

function PillSelect({ id, label, value, onChange, disabled = false, children }: { id: string; label: string; value: string; onChange: (value: string) => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <label htmlFor={id} className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-strong)] py-1 pl-4 pr-2 text-xs font-black uppercase tracking-[0.14em] text-[var(--muted)]">
      <span>{label}</span>
      <select
        id={id}
        aria-label={label}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="max-w-40 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-bold normal-case tracking-normal text-[var(--foreground)] outline-none"
      >
        {children}
      </select>
    </label>
  );
}

function DateSection({ date, games, timezone, layout, noSpoilers }: { date: string; games: Game[]; timezone: string; layout: LayoutMode; noSpoilers: boolean }) {
  const formattedDate = formatDate(date);
  const sortedGames = [...games].sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());

  return (
    <section>
      <div className="mb-4 flex items-end justify-between gap-4 border-b border-[var(--border)] pb-3">
        <h2 className="text-2xl font-black tracking-[-0.06em] sm:text-4xl">{formattedDate}</h2>
        <span className="text-xs font-black uppercase tracking-[0.16em] text-[var(--muted)]">{games.length} games</span>
      </div>
      <div className={layout === 'cards' ? 'grid gap-4 xl:grid-cols-2' : layout === 'compact' ? 'grid gap-2' : 'grid gap-3 md:grid-cols-2 xl:grid-cols-3'}>
        {sortedGames.map((game) => {
          if (layout === 'compact') return <CompactGame key={game.id} game={game} timezone={timezone} noSpoilers={noSpoilers} />;
          if (layout === 'tv') return <TVGame key={game.id} game={game} timezone={timezone} noSpoilers={noSpoilers} />;
          return <GameCard key={game.id} game={game} timezone={timezone} noSpoilers={noSpoilers} />;
        })}
      </div>
    </section>
  );
}

function GameCard({ game, timezone, noSpoilers }: { game: Game; timezone: string; noSpoilers: boolean }) {
  const status = getGameStatus(game);

  return (
    <SurfaceCard className={`overflow-hidden rounded-[2rem] transition hover:-translate-y-0.5 hover:border-[var(--scarlet)] ${status === 'live' ? 'border-[var(--scarlet)]' : ''}`}>
      <div className="grid gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <span className={`rounded-full px-3 py-1 text-xs font-black uppercase tracking-[0.14em] ${status === 'live' ? 'bg-[var(--scarlet)] text-white' : 'border border-[var(--border)] text-[var(--muted)]'}`}>
              {game.status}
            </span>
            {game.tv !== 'TBD' && <span className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-black uppercase tracking-[0.14em] text-[var(--muted)]">{game.tv}</span>}
          </div>
          <time className="text-sm font-black text-[var(--foreground)]">{formatGameTime(game, timezone)}</time>
        </div>

        <div className="grid gap-3">
          <TeamRow team={game.awayTeam} showScore={!noSpoilers && status !== 'scheduled'} winner={!noSpoilers && status !== 'scheduled' && game.awayTeam.score > game.homeTeam.score} />
          <div className="px-2 text-xs font-black uppercase tracking-[0.18em] text-[var(--muted)]">at</div>
          <TeamRow team={game.homeTeam} showScore={!noSpoilers && status !== 'scheduled'} winner={!noSpoilers && status !== 'scheduled' && game.homeTeam.score > game.awayTeam.score} />
        </div>

        <div className="grid gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-strong)] p-4 text-sm sm:grid-cols-2">
          <div>
            <div className="text-xs font-black uppercase tracking-[0.14em] text-[var(--muted)]">Venue</div>
            <div className="mt-1 font-bold">{game.venue}</div>
            <div className="mt-1 text-[var(--muted)]">{game.location}</div>
          </div>
          <div className="sm:text-right">
            <div className="text-xs font-black uppercase tracking-[0.14em] text-[var(--muted)]">Line</div>
            <div className="mt-1 font-bold">{game.spread || 'TBD'}</div>
          </div>
        </div>
      </div>
    </SurfaceCard>
  );
}

function CompactGame({ game, timezone, noSpoilers }: { game: Game; timezone: string; noSpoilers: boolean }) {
  const status = getGameStatus(game);

  return (
    <SurfaceCard className={`rounded-[1.25rem] p-3 transition hover:border-[var(--scarlet)] ${status === 'live' ? 'border-[var(--scarlet)]' : ''}`}>
      <div className="grid gap-3 md:grid-cols-[7rem_1fr_7rem_8rem] md:items-center">
        <div className="text-sm font-black">{formatGameTime(game, timezone)}</div>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
          <MiniTeam team={game.awayTeam} align="left" showScore={!noSpoilers} />
          <span className="hidden text-xs font-black uppercase tracking-[0.16em] text-[var(--muted)] sm:block">at</span>
          <MiniTeam team={game.homeTeam} align="right" showScore={!noSpoilers} />
        </div>
        <div className="text-xs font-black uppercase tracking-[0.14em] text-[var(--muted)] md:text-center">{game.tv}</div>
        <div className={`rounded-full px-3 py-1 text-center text-xs font-black uppercase tracking-[0.14em] ${status === 'live' ? 'bg-[var(--scarlet)] text-white' : 'border border-[var(--border)] text-[var(--muted)]'}`}>{game.status}</div>
      </div>
    </SurfaceCard>
  );
}

function TVGame({ game, timezone, noSpoilers }: { game: Game; timezone: string; noSpoilers: boolean }) {
  const status = getGameStatus(game);

  return (
    <SurfaceCard className="overflow-hidden rounded-[1.5rem] transition hover:-translate-y-0.5 hover:border-[var(--scarlet)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-strong)] px-4 py-3">
        <div className="text-lg font-black tracking-[-0.04em]">{game.tv || 'TBD'}</div>
        <div className={status === 'live' ? 'text-xs font-black uppercase tracking-[0.14em] text-[var(--scarlet)]' : 'text-xs font-black uppercase tracking-[0.14em] text-[var(--muted)]'}>{formatGameTime(game, timezone)}</div>
      </div>
      <div className="grid gap-3 p-4">
        <MiniTeam team={game.awayTeam} showScore={!noSpoilers} />
        <MiniTeam team={game.homeTeam} showScore={!noSpoilers} />
        <div className="truncate text-xs font-bold text-[var(--muted)]">{game.venue}</div>
      </div>
    </SurfaceCard>
  );
}

function MiniTeam({ team, align = 'left', showScore = true }: { team: Team; align?: 'left' | 'right'; showScore?: boolean }) {
  return (
    <div className={`flex items-center gap-2 ${align === 'right' ? 'sm:justify-end' : ''}`}>
      <img src={team.logo || '/images/logos/default-logo.png'} alt="" className="h-7 w-7 rounded-full bg-white object-contain p-1" loading="lazy" />
      <span className="truncate text-sm font-black">
        {team.rank && team.rank <= 25 && <span className="mr-1 text-[var(--scarlet)]">#{team.rank}</span>}
        {team.shortName || team.name}
      </span>
      {showScore && <span className="text-sm font-black">{team.score || ''}</span>}
    </div>
  );
}

function TeamRow({ team, showScore, winner }: { team: Team; showScore: boolean; winner: boolean }) {
  return (
    <div className={`grid grid-cols-[3.5rem_1fr_auto] items-center gap-3 rounded-2xl border p-3 ${winner ? 'border-[var(--scarlet)] bg-[color-mix(in_srgb,var(--scarlet)_10%,var(--surface-strong))]' : 'border-[var(--border)] bg-[var(--surface-strong)]'}`}>
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white p-2 shadow-sm">
        <img src={team.logo || '/images/logos/default-logo.png'} alt={`${team.name} logo`} className="max-h-full max-w-full object-contain" loading="lazy" />
      </div>
      <div className="min-w-0">
        <h3 className="truncate text-lg font-black tracking-[-0.035em]">
          {team.rank && team.rank <= 25 && <span className="mr-2 text-[var(--scarlet)]">#{team.rank}</span>}
          {team.shortName || team.name}
        </h3>
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--muted)]">{team.conference}</p>
      </div>
      <div className="text-3xl font-black tracking-[-0.08em]">{showScore ? team.score : ''}</div>
    </div>
  );
}

function getGameStatus(game: Game) {
  if (game.isCompleted) return 'completed';
  if (/\b(Q|OT)\b|half|halftime|quarter/i.test(game.status)) return 'live';
  return 'scheduled';
}

function formatGameTime(game: Game, timezone: string) {
  if (game.time === 'TBD' || !game.datetime || Number.isNaN(new Date(game.datetime).getTime())) return 'TBD';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
    timeZoneName: 'short'
  }).format(new Date(game.datetime));
}

function formatDate(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  const dateObject = new Date(year || new Date().getFullYear(), (month || 1) - 1, day || 1);

  return dateObject.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}
