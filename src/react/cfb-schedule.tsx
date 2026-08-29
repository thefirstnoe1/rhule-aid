import * as React from 'react';
const { useState, useEffect, useCallback } = React;

interface Team {
  id: string;
  name: string;
  shortName: string;
  logo: string;
  rank?: number;
  conference: string;
  score?: number;
}

interface Game {
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
  spread?: string;
}

interface ScheduleData {
  games: Game[];
  weeks: Array<{ value: string; label: string }>;
  lastUpdated: string;
}

interface Filters {
  week: string;
  conference: string;
  status: string;
  rankedOnly: boolean;
}

const TIMEZONES = [
  { value: 'America/Chicago', label: 'Central Time (CT)', short: 'CT' },
  { value: 'America/New_York', label: 'Eastern Time (ET)', short: 'ET' },
  { value: 'America/Denver', label: 'Mountain Time (MT)', short: 'MT' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)', short: 'PT' },
  { value: 'UTC', label: 'UTC', short: 'UTC' }
];

const CFBSchedule: React.FC = () => {
  const [scheduleData, setScheduleData] = useState<ScheduleData | null>(null);
  const [filteredGames, setFilteredGames] = useState<Game[]>([]);
  const [filters, setFilters] = useState<Filters>({
    week: '',
    conference: '',
    status: '',
    rankedOnly: false
  });
  const [selectedTimezone, setSelectedTimezone] = useState('America/Chicago');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const formatGameTime = useCallback((game: Game): string => {
    if (game.time === 'TBD' || !game.datetime || Number.isNaN(new Date(game.datetime).getTime())) return 'TBD';
    const date = new Date(game.datetime);
    
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: selectedTimezone,
      timeZoneName: 'short'
    });
  }, [selectedTimezone]);

  const getGameStatusCategory = useCallback((status: string, isCompleted: boolean): string => {
    if (isCompleted) return 'completed';
    if (status.includes('Q') || status.includes('Half') || status.includes('OT')) return 'live';
    return 'scheduled';
  }, []);

  const hasLiveGames = useCallback((): boolean => {
    if (!filteredGames) return false;
    return filteredGames.some(game => 
      getGameStatusCategory(game.status, game.isCompleted) === 'live'
    );
  }, [filteredGames, getGameStatusCategory]);

  const loadSchedule = useCallback(async () => {
    setLoading(true);
    setError(false);

    try {
      const url = new URL('/api/cfb-schedule', (window as any).location.origin);
      if (filters.week) {
        url.searchParams.set('week', filters.week);
      }

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as ScheduleData;
      setScheduleData(data);
    } catch (err) {
      console.error('Error loading schedule:', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [filters.week]);

  const applyFilters = useCallback(() => {
    if (!scheduleData?.games) return;

    const filtered = scheduleData.games.filter(game => {
      // Week filter
      if (filters.week && game.week.toString() !== filters.week) {
        return false;
      }

      // Conference filter
      if (filters.conference) {
        const hasConference = game.homeTeam.conference === filters.conference ||
                            game.awayTeam.conference === filters.conference;
        if (!hasConference) return false;
      }

      // Status filter
      if (filters.status) {
        const gameStatus = getGameStatusCategory(game.status, game.isCompleted);
        if (gameStatus !== filters.status) return false;
      }

      // Ranked teams filter
      if (filters.rankedOnly) {
        const hasRankedTeam = game.homeTeam.rank || game.awayTeam.rank;
        if (!hasRankedTeam) return false;
      }

      return true;
    });

    setFilteredGames(filtered);
  }, [scheduleData, filters, getGameStatusCategory]);

  const groupGamesByDate = useCallback((games: Game[]) => {
    const grouped: Record<string, Game[]> = {};
    games.forEach(game => {
      if (!grouped[game.date]) {
        grouped[game.date] = [];
      }
      const gameArray = grouped[game.date];
      if (gameArray) {
        gameArray.push(game);
      }
    });

    // Sort games within each date by time
    Object.keys(grouped).forEach(date => {
      const games = grouped[date];
      if (games) {
        games.sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());
      }
    });

    return grouped;
  }, []);

  // Load schedule on mount
  useEffect(() => {
    loadSchedule();
  }, [loadSchedule]);

  // Apply filters when data or filters change
  useEffect(() => {
    applyFilters();
  }, [applyFilters]);

  // Auto-refresh for live games
  useEffect(() => {
    const interval = setInterval(() => {
      if (hasLiveGames()) {
        loadSchedule();
      }
    }, 300000); // 5 minutes

    return () => clearInterval(interval);
  }, [hasLiveGames, loadSchedule]);

  const handleFilterChange = (key: keyof Filters, value: string | boolean) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  };

  const GameCard: React.FC<{ game: Game }> = ({ game }) => {
    const gameStatus = getGameStatusCategory(game.status, game.isCompleted);
    const statusClass = gameStatus === 'live' ? 'live' : gameStatus === 'completed' ? 'completed' : 'scheduled';
    const formattedTime = formatGameTime(game);

    return (
      <div className={`game-card ${statusClass}`}>
        <div className="game-header">
          <span className="game-time">{formattedTime}</span>
          <span className={`game-status ${statusClass}`}>{game.status}</span>
        </div>

        <div className="teams">
          <div className="team away-team">
            <div className="team-info">
              <img 
                src={game.awayTeam?.logo || '/images/logos/default-logo.png'} 
                alt={game.awayTeam?.name || 'Away Team'} 
                className="team-logo"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = '/images/logos/default-logo.png';
                }}
              />
              <div className="team-details">
                <div className="team-name">
                  {game.awayTeam?.rank && game.awayTeam.rank <= 25 && <span className="rank">#{game.awayTeam.rank}</span>}
                  <span className="team-short-name">{game.awayTeam?.shortName || 'Unknown'}</span>
                </div>
                <div className="team-conference">{game.awayTeam?.conference || 'Unknown'}</div>
              </div>
            </div>
            <div className="team-score">
              {(game.isCompleted || gameStatus === 'live') ? (game.awayTeam?.score || 0) : ''}
            </div>
          </div>

          <div className="vs-separator">@</div>

          <div className="team home-team">
            <div className="team-info">
              <img 
                src={game.homeTeam?.logo || '/images/logos/default-logo.png'} 
                alt={game.homeTeam?.name || 'Home Team'} 
                className="team-logo"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = '/images/logos/default-logo.png';
                }}
              />
              <div className="team-details">
                <div className="team-name">
                  {game.homeTeam?.rank && game.homeTeam.rank <= 25 && <span className="rank">#{game.homeTeam.rank}</span>}
                  <span className="team-short-name">{game.homeTeam?.shortName || 'Unknown'}</span>
                </div>
                <div className="team-conference">{game.homeTeam?.conference || 'Unknown'}</div>
              </div>
            </div>
            <div className="team-score">
              {(game.isCompleted || gameStatus === 'live') ? (game.homeTeam?.score || 0) : ''}
            </div>
          </div>
        </div>

        <div className="game-details">
          <div className="venue-info">
            <span className="venue">{game.venue}</span>
            <span className="location">{game.location}</span>
          </div>
          <div className="broadcast-info">
            <span className="tv">{game.tv}</span>
            {game.spread && <span className="spread">{game.spread}</span>}
          </div>
        </div>
      </div>
    );
  };

  const DateSection: React.FC<{ date: string; games: Game[] }> = ({ date, games }) => {
    // Parse the date string as UTC to avoid timezone shifting
    const dateParts = date.split('-').map(Number);
    const year = dateParts[0] || new Date().getFullYear();
    const month = (dateParts[1] || 1) - 1; // Month is 0-indexed
    const day = dateParts[2] || 1;
    
    const dateObj = new Date(year, month, day); // Local date without timezone conversion
    
    const formattedDate = dateObj.toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });

    return (
      <div className="date-section">
        <h2 className="date-header">{formattedDate}</h2>
        <div className="games-grid">
          {games.map(game => (
            <GameCard key={game.id} game={game} />
          ))}
        </div>
      </div>
    );
  };

  const gamesByDate = groupGamesByDate(filteredGames);

  return (
    <>
      <div className="schedule-controls">
        <div className="filter-controls">
          <div className="filter-group">
            <label htmlFor="week-filter">Week</label>
            <select
              id="week-filter"
              value={filters.week}
              onChange={(e) => handleFilterChange('week', (e.target as HTMLSelectElement).value)}
            >
              <option value="">All Weeks</option>
              {scheduleData?.weeks?.map(week => (
                <option key={week.value} value={week.value}>{week.label}</option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="conference-filter">Conference</label>
            <select
              id="conference-filter"
              value={filters.conference}
              onChange={(e) => handleFilterChange('conference', (e.target as HTMLSelectElement).value)}
            >
              <option value="">All Conferences</option>
              <option value="Big Ten">Big Ten</option>
              <option value="SEC">SEC</option>
              <option value="ACC">ACC</option>
              <option value="Big 12">Big 12</option>
              <option value="Pac-12">Pac-12</option>
              <option value="Mountain West">Mountain West</option>
              <option value="American Athletic">American Athletic</option>
              <option value="Conference USA">Conference USA</option>
              <option value="MAC">MAC</option>
              <option value="Sun Belt">Sun Belt</option>
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="status-filter">Game Status</label>
            <select
              id="status-filter"
              value={filters.status}
              onChange={(e) => handleFilterChange('status', (e.target as HTMLSelectElement).value)}
            >
              <option value="">All Games</option>
              <option value="scheduled">Scheduled</option>
              <option value="live">Live</option>
              <option value="completed">Completed</option>
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="ranked-filter">
              <input
                type="checkbox"
                id="ranked-filter"
                checked={filters.rankedOnly}
                onChange={(e) => handleFilterChange('rankedOnly', (e.target as HTMLInputElement).checked)}
              />
              Ranked Teams Only
            </label>
          </div>

          <div className="filter-group">
            <label htmlFor="timezone-filter">Time Zone</label>
            <select
              id="timezone-filter"
              value={selectedTimezone}
              onChange={(e) => setSelectedTimezone((e.target as HTMLSelectElement).value)}
            >
              {TIMEZONES.map(tz => (
                <option key={tz.value} value={tz.value}>{tz.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="refresh-controls">
          <button
            id="refresh-btn"
            className="btn btn-primary"
            onClick={() => loadSchedule()}
            disabled={loading}
          >
            <span className="refresh-icon">🔄</span> Refresh
          </button>
          {scheduleData?.lastUpdated && (
            <span className="last-updated">
              Last updated: {new Date(scheduleData.lastUpdated).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {loading && (
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading schedule...</p>
        </div>
      )}

      {error && (
        <div className="error-message">
          <p>⚠️ Unable to load schedule data</p>
          <button id="retry-btn" className="btn" onClick={() => loadSchedule()}>
            Try Again
          </button>
        </div>
      )}

      {!loading && !error && (
        <div id="schedule-container">
          {filteredGames.length === 0 ? (
            <div className="no-games">
              <p>No games found matching your filters.</p>
            </div>
          ) : (
            Object.keys(gamesByDate)
              .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
              .map(date => (
                <DateSection key={date} date={date} games={gamesByDate[date] || []} />
              ))
          )}
        </div>
      )}
    </>
  );
};

export default CFBSchedule;
