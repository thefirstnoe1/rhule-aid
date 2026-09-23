import { getCloudflareContext } from '@opennextjs/cloudflare';
import { handleScheduleRequest } from '../../../src/api/schedule';
import { handleNewsRequest } from '../../../src/api/news';
import { handleRosterRequest } from '../../../src/api/roster';
import { handleWeatherRequest } from '../../../src/api/weather';
import { handleLogoRequest } from '../../../src/api/logo';
import { handleConferencesRequest } from '../../../src/api/conferences';
import { onRequest as handleCFBScheduleRequest } from '../../../src/api/cfb-schedule';
import { handleBigTenStandingsRequest } from '../../../src/api/bigten-standings';
import { handleSoccerRequest } from '../../../src/api/soccer';
import { handleGameStatusRequest } from '../../../src/api/nebraska-game-status';
import { handleGameCalendarRequest } from '../../../src/api/game-calendar';
import { handleWeatherAlertsRequest } from '../../../src/api/weather-alerts';
import type { Env } from '../../../src/types';
import { handleCfbLive, handleCfbLiveSocket, handleCfbRelayIngest } from '../../../src/api/cfb-live';

type RouteContext = {
  params: Promise<{
    pathname: string[];
  }>;
};

async function routeAPIRequest(request: Request, context: RouteContext): Promise<Response> {
  const { pathname } = await context.params;
  const path = `/api/${pathname.join('/')}`;
  const env = getCloudflareContext().env as Env;

  try {
    if (path === '/api/cfb-live') return request.method === 'GET' ? handleCfbLive(request, env) : Response.json({ error: 'Method Not Allowed' }, { status: 405 });
    if (path === '/api/cfb-live/socket') return request.method === 'GET' ? handleCfbLiveSocket(request, env) : Response.json({ error: 'Method Not Allowed' }, { status: 405 });
    if (path === '/api/internal/cfbd/events') return request.method === 'POST' ? handleCfbRelayIngest(request, env) : Response.json({ error: 'Method Not Allowed' }, { status: 405 });
    switch (path) {
      case '/api/schedule':
        return await handleScheduleRequest(request, env);
      case '/api/cfb-schedule':
        return await handleCFBScheduleRequest({ request, env });
      case '/api/news':
        return await handleNewsRequest(request, env);
      case '/api/roster':
        return await handleRosterRequest(request, env);
      case '/api/weather':
        return await handleWeatherRequest(request, env);
      case '/api/weather/alerts':
        return await handleWeatherAlertsRequest(request, env);
      case '/api/logo':
        return await handleLogoRequest(request, env);
      case '/api/conferences':
        return await handleConferencesRequest(request, env);
      case '/api/standings/big-ten':
        return await handleBigTenStandingsRequest(request, env);
      case '/api/soccer':
        return await handleSoccerRequest(request, env);
      case '/api/games/status':
        return await handleGameStatusRequest(request, env);
      case '/api/games/calendar':
        return await handleGameCalendarRequest(request, env);
      default:
        return Response.json({ error: 'Not Found' }, { status: 404 });
    }
  } catch (error) {
    console.error('Next API route error:', error);
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return routeAPIRequest(request, context);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return routeAPIRequest(request, context);
}
