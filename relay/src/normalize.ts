export interface RelayEvent {
  eventId: string;
  gameId: string;
  sourceRevision: number;
  observedAt: string;
  payload: unknown;
}

export interface RelayBatch {
  schema: "cfbd-relay:v1";
  deliveryId: string;
  sentAt: string;
  season: number;
  seasonType: "regular" | "postseason" | "spring";
  week: number;
  sourceEpoch: string;
  events: RelayEvent[];
}

const idOf = (game: Record<string, unknown>): string => {
  for (const key of ["id", "gameId", "game_id", "eventId", "event_id"]) {
    if (typeof game[key] === "string" || typeof game[key] === "number") return String(game[key]);
  }
  return JSON.stringify(game);
};

export function scoreboardItems(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<string, unknown>;
  const scoreboard = data.scoreboard;
  if (Array.isArray(scoreboard)) return scoreboard.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  if (scoreboard && typeof scoreboard === "object") return [scoreboard as Record<string, unknown>];
  return [];
}

export function normalizeScoreboard(payload: unknown, revisions: (gameId: string) => number, season: number, seasonType: RelayBatch["seasonType"], week: number, sourceEpoch: string, now = new Date()): RelayBatch {
  const observedAt = now.toISOString();
  const events = scoreboardItems(payload).map((scoreboard) => {
    const gameId = idOf(scoreboard);
    const sourceRevision = revisions(gameId);
    return { eventId: `${gameId}:${sourceRevision}`, gameId, sourceRevision, observedAt, payload: scoreboard };
  });
  return { schema: "cfbd-relay:v1", deliveryId: crypto.randomUUID(), sentAt: observedAt, season, seasonType, week, sourceEpoch, events };
}
