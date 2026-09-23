export interface Env {
  DB: any;
  SCHEDULE_CACHE: any;
  ROSTER_CACHE: any;
  NEWS_CACHE: any;
  WEATHER_CACHE: any;
  RANKINGS_CACHE: any;
  STANDINGS_CACHE: any;
  CFB_SCHEDULE_CACHE: any;
  ASSETS: any;
  CFB_WEEK_LIVE_FEED: DurableObjectNamespace;
  CFBD_RELAY_HMAC_SECRET?: string;
  CFB_ALLOWED_ORIGINS?: string;
  CFB_SYNC_MODE?: 'legacy' | 'shadow' | 'do';
  OPENWEATHER_API_KEY: string;
  CFBD_API_KEY: string;
}

export interface Context {
  request: Request;
  env: Env;
}

export interface Team {
  name: string;
  shortName: string;
  logo: string;
  score: number;
  rank?: number;
  conference: string;
}

export interface ScheduleMatch {
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
}
