'use client';

import { useMemo, useState } from 'react';
import { DataHealth, SurfaceCard } from '../components/ui';

export type ScheduleGame = {
  date: string;
  opponent: string;
  opponentId?: number;
  time: string;
  kickoffAt?: string;
  kickoffStatus?: 'confirmed' | 'tba' | 'unconfirmed';
  location: string;
  network?: string;
  tvNetwork: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamId?: number;
  awayTeamId?: number;
  nebraskaLogo: string;
  opponentLogo: string;
  isHome: boolean;
  isNeutral?: boolean;
  result?: string;
  score?: string;
};

type Standing = {
  market: string;
  team_rank: string;
  data: Array<{
    conf_record?: string;
    ovr_record?: string;
  }>;
};

type ScheduleExplorerProps = {
  games: ScheduleGame[];
  standings: Standing[];
  lastUpdated?: string;
  health?: { updatedAt?: string; stale?: boolean; providers?: Record<string, string> };
};

type Filter = 'all' | 'home' | 'away' | 'neutral' | 'conference';
type LayoutMode = 'cards' | 'list' | 'compact';

const bigTenOpponents = new Set([
  'Illinois',
  'Indiana',
  'Iowa',
  'Maryland',
  'Michigan',
  'Michigan State',
  'Minnesota',
  'Northwestern',
  'Ohio State',
  'Oregon',
  'Penn State',
  'Purdue',
  'Rutgers',
  'UCLA',
  'USC',
  'Washington',
  'Wisconsin'
]);

const filters: Array<{ label: string; value: Filter }> = [
  { label: 'All', value: 'all' },
  { label: 'Home', value: 'home' },
  { label: 'Away', value: 'away' },
  { label: 'Neutral', value: 'neutral' },
  { label: 'Big Ten', value: 'conference' }
];

const timezones = [
  { label: 'Central', value: 'America/Chicago' },
  { label: 'Eastern', value: 'America/New_York' },
  { label: 'Mountain', value: 'America/Denver' },
  { label: 'Pacific', value: 'America/Los_Angeles' }
];

const layoutModes: Array<{ label: string; value: LayoutMode }> = [
  { label: 'Cards', value: 'cards' },
  { label: 'List', value: 'list' },
  { label: 'Compact', value: 'compact' }
];

export function ScheduleExplorer({ games, standings, lastUpdated, health }: ScheduleExplorerProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [timezone, setTimezone] = useState('America/Chicago');
  const [layout, setLayout] = useState<LayoutMode>('cards');

  const filteredGames = useMemo(() => {
    return games.filter((game) => {
      if (filter === 'home') return game.isHome && !game.isNeutral;
      if (filter === 'away') return !game.isHome && !game.isNeutral;
      if (filter === 'neutral') return game.isNeutral;
      if (filter === 'conference') return bigTenOpponents.has(game.opponent);
      return true;
    });
  }, [filter, games]);

  return (
    <div className="container-shell pb-20">
      <div className="mb-6 flex flex-col gap-4 rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface)] p-4 backdrop-blur md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Schedule filters">
          {filters.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
              aria-pressed={filter === item.value}
              className={`rounded-full px-4 py-2 text-xs font-black uppercase tracking-[0.14em] transition ${filter === item.value ? 'bg-[var(--foreground)] text-[var(--background)]' : 'border border-[var(--border)] text-[var(--muted)] hover:border-[var(--foreground)] hover:text-[var(--foreground)]'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="inline-flex rounded-full border border-[var(--border)] bg-[var(--surface-strong)] p-1" role="group" aria-label="Schedule layout">
            {layoutModes.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setLayout(item.value)}
                aria-pressed={layout === item.value}
                className={`rounded-full px-3 py-2 text-xs font-black uppercase tracking-[0.14em] transition ${layout === item.value ? 'bg-[var(--foreground)] text-[var(--background)]' : 'text-[var(--muted)] hover:text-[var(--foreground)]'}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.14em] text-[var(--muted)]">
            Timezone
            <select
              id="schedule-timezone"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              className="rounded-full border border-[var(--border)] bg-[var(--surface-strong)] px-4 py-2 text-sm font-bold normal-case tracking-normal text-[var(--foreground)] outline-none"
            >
              {timezones.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <DataHealth updatedAt={health?.updatedAt || lastUpdated} stale={health?.stale} providers={health?.providers} label="Schedule" />

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        Showing {filteredGames.length} of {games.length} {games.length === 1 ? 'game' : 'games'}.
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <section className={layout === 'cards' ? 'grid gap-4' : layout === 'list' ? 'grid gap-3' : 'grid gap-2'}>
          {filteredGames.length > 0 ? filteredGames.map((game, index) => (
            <ScheduleGameView key={`${game.date}-${game.opponent}-${index}`} game={game} timezone={timezone} index={index} layout={layout} />
          )) : (
            <SurfaceCard className="rounded-[1.75rem] p-8 text-center">
              <h2 className="text-2xl font-black tracking-[-0.04em]">No games match this filter.</h2>
              <p className="mt-2 text-sm text-[var(--muted)]">Try another schedule view.</p>
            </SurfaceCard>
          )}
        </section>

        <aside className="grid content-start gap-4">
          <SurfaceCard className="rounded-[1.75rem] p-6">
            <p className="eyebrow mb-4">Big Ten Standings</p>
            <div className="grid gap-3">
              {standings.slice(0, 8).map((team) => (
                <div key={team.market} className={`grid grid-cols-[2rem_1fr_auto] items-center gap-3 rounded-2xl border border-[var(--border)] p-3 text-sm ${team.market.toLowerCase().includes('nebraska') ? 'bg-[var(--scarlet)] text-white' : 'bg-[var(--surface-strong)]'}`}>
                  <span className="font-black">{team.team_rank}</span>
                  <span className="font-bold">{team.market}</span>
                  <span className="text-xs font-black opacity-80">{getRecord(team, 'conf_record')}</span>
                </div>
              ))}
              {standings.length === 0 && <p className="text-sm text-[var(--muted)]">Standings are not available yet.</p>}
            </div>
            {lastUpdated && (
              <p className="mt-5 text-xs leading-5 text-[var(--muted)]">Schedule updated {new Date(lastUpdated).toLocaleString()}</p>
            )}
          </SurfaceCard>
        </aside>
      </div>
    </div>
  );
}

function ScheduleGameView({ game, timezone, index, layout }: { game: ScheduleGame; timezone: string; index: number; layout: LayoutMode }) {
  if (layout === 'list') return <ListGame game={game} timezone={timezone} />;
  if (layout === 'compact') return <CompactGame game={game} timezone={timezone} />;
  return <GameCard game={game} timezone={timezone} index={index} />;
}

function GameCard({ game, timezone, index }: { game: ScheduleGame; timezone: string; index: number }) {
  const gameType = game.isNeutral ? 'Neutral' : game.isHome ? 'Home' : 'Away';
  const convertedTime = formatGameTime(game, timezone);
  const dateParts = getDateParts(game.date);
  const network = game.network || game.tvNetwork || 'TBD';
  const matchup = getMatchupTeams(game);

  return (
    <SurfaceCard className="overflow-hidden rounded-[1.75rem] transition hover:-translate-y-0.5 hover:border-[var(--scarlet)]">
      <div className="grid gap-5 p-5 md:grid-cols-[6.5rem_1fr_auto] md:items-center md:p-6">
        <div className="rounded-2xl bg-[var(--foreground)] p-4 text-center text-[var(--background)]">
          <div className="text-xs font-black uppercase tracking-[0.16em] opacity-70">{dateParts.month}</div>
          <div className="mt-1 text-4xl font-black tracking-[-0.08em]">{dateParts.day}</div>
          <div className="mt-1 text-[0.65rem] font-black uppercase tracking-[0.16em] opacity-70">{dateParts.weekday}</div>
        </div>
        <div>
          <div className="mb-3 flex flex-wrap gap-2">
            <span className="rounded-full bg-[var(--scarlet)] px-3 py-1 text-xs font-black uppercase tracking-[0.14em] text-white">{gameType}</span>
            {bigTenOpponents.has(game.opponent) && <span className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-black uppercase tracking-[0.14em] text-[var(--muted)]">Big Ten</span>}
            {game.result && <span className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-black uppercase tracking-[0.14em] text-[var(--muted)]">{game.result} {game.score}</span>}
          </div>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <TeamLogo src={matchup.away.logo} alt={`${matchup.away.name} logo`} />
            <div className="text-sm font-black uppercase tracking-[0.16em] text-[var(--muted)]">{getMatchupLabel(game)}</div>
            <TeamLogo src={matchup.home.logo} alt={`${matchup.home.name} logo`} />
            <h2 className="text-3xl font-black tracking-[-0.06em] sm:text-4xl">
              {matchup.away.name} {getMatchupLabel(game)} {matchup.home.name}
            </h2>
          </div>
          <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{game.date} at {convertedTime}</p>
        </div>
        <div className="min-w-48 rounded-2xl border border-[var(--border)] bg-[var(--surface-strong)] p-4 md:text-right">
          <div className="text-xs font-black uppercase tracking-[0.14em] text-[var(--muted)]">Venue</div>
          <div className="mt-1 font-black">{game.location || 'TBA'}</div>
          <div className="mt-4 text-xs font-black uppercase tracking-[0.14em] text-[var(--muted)]">TV</div>
          <div className="mt-1 font-black">{network}</div>
        </div>
      </div>
    </SurfaceCard>
  );
}

function ListGame({ game, timezone }: { game: ScheduleGame; timezone: string }) {
  const matchup = getMatchupTeams(game);
  const dateParts = getDateParts(game.date);
  const network = game.network || game.tvNetwork || 'TBD';
  const gameType = game.isNeutral ? 'Neutral' : game.isHome ? 'Home' : 'Away';

  return (
    <SurfaceCard className="rounded-[1.25rem] p-3 transition hover:border-[var(--scarlet)]">
      <div className="grid gap-3 md:grid-cols-[7rem_8rem_1fr_6rem_5rem] md:items-center">
        <div className="text-sm font-black">{formatShortDate(game.date)}</div>
        <div className="text-sm font-black">{formatGameTime(game, timezone)}</div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-black">{matchup.away.name}</span>
          <span className="text-xs font-black uppercase tracking-[0.14em] text-[var(--muted)]">{getMatchupLabel(game)}</span>
          <span className="truncate font-black">{matchup.home.name}</span>
        </div>
        <div className="text-xs font-black uppercase tracking-[0.14em] text-[var(--muted)]">{network}</div>
        <div className="text-xs font-black uppercase tracking-[0.14em] text-[var(--muted)]">{game.result ? `${game.result} ${game.score || ''}` : gameType}</div>
      </div>
    </SurfaceCard>
  );
}

function CompactGame({ game, timezone }: { game: ScheduleGame; timezone: string }) {
  const matchup = getMatchupTeams(game);
  const dateParts = getDateParts(game.date);
  const network = game.network || game.tvNetwork || 'TBD';
  const gameType = game.isNeutral ? 'Neutral' : game.isHome ? 'Home' : 'Away';

  return (
    <SurfaceCard className="overflow-hidden rounded-[1.5rem] transition hover:border-[var(--scarlet)]">
      <div className="grid gap-4 p-4 md:grid-cols-[5.5rem_1fr_auto] md:items-center">
        <div className="rounded-2xl bg-[var(--foreground)] p-3 text-center text-[var(--background)]">
          <div className="text-xs font-black uppercase tracking-[0.16em] opacity-70">{dateParts.month}</div>
          <div className="text-3xl font-black tracking-[-0.08em]">{dateParts.day}</div>
        </div>
        <div>
          <div className="mb-2 flex flex-wrap gap-2">
            <span className="rounded-full bg-[var(--scarlet)] px-3 py-1 text-[0.65rem] font-black uppercase tracking-[0.14em] text-white">{gameType}</span>
            {game.result && <span className="rounded-full border border-[var(--border)] px-3 py-1 text-[0.65rem] font-black uppercase tracking-[0.14em] text-[var(--muted)]">{game.result} {game.score}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <MiniTeam name={matchup.away.name} logo={matchup.away.logo} />
            <span className="text-xs font-black uppercase tracking-[0.16em] text-[var(--muted)]">{getMatchupLabel(game)}</span>
            <MiniTeam name={matchup.home.name} logo={matchup.home.logo} />
          </div>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-strong)] p-4 text-sm md:min-w-44 md:text-right">
          <div className="font-black">{formatGameTime(game, timezone)}</div>
          <div className="mt-1 text-xs font-bold text-[var(--muted)]">{network}</div>
        </div>
      </div>
    </SurfaceCard>
  );
}

function MiniTeam({ name, logo }: { name: string; logo: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <img src={logo} alt="" className="h-9 w-9 rounded-full bg-white object-contain p-1 shadow-sm" loading="lazy" />
      <span className="truncate text-xl font-black tracking-[-0.04em]">{name}</span>
    </span>
  );
}

function getMatchupTeams(game: ScheduleGame) {
  const nebraska = { name: 'Nebraska', logo: game.nebraskaLogo };
  const opponent = { name: game.opponent, logo: game.opponentLogo };

  if (game.isHome) {
    return { away: opponent, home: nebraska };
  }

  return { away: nebraska, home: opponent };
}

function getMatchupLabel(game: ScheduleGame) {
  return game.isHome || game.isNeutral ? 'vs.' : 'at';
}

function TeamLogo({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-[var(--border)] bg-white p-2 shadow-sm">
      <img src={src} alt={alt} className="max-h-full max-w-full object-contain" loading="lazy" />
    </div>
  );
}

function getRecord(team: Standing, key: 'conf_record' | 'ovr_record') {
  return team.data.find((item) => item[key])?.[key] || '0-0';
}

function getDateParts(dateString: string) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return { month: 'TBD', day: '--', weekday: 'Date' };
  }

  return {
    month: date.toLocaleDateString('en-US', { month: 'short' }),
    day: date.toLocaleDateString('en-US', { day: 'numeric' }),
    weekday: date.toLocaleDateString('en-US', { weekday: 'short' })
  };
}

function formatShortDate(dateString: string) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return 'TBD';

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });
}

function formatGameTime(game: ScheduleGame, timezone: string) {
  if (game.kickoffStatus !== 'confirmed') {
    return 'TBD';
  }

  if (!game.kickoffAt) return timezone === 'America/Chicago' && game.time && game.time !== 'TBD' ? game.time : 'TBD';
  const date = new Date(game.kickoffAt);
  if (Number.isNaN(date.getTime())) return 'TBD';

  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(date);
}
