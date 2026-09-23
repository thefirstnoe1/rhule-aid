import type { Config } from "./config.js";

const query = `subscription Scoreboard { scoreboard { id awayId awayTeam awayPoints awayLineScores homeId homeTeam homePoints homeLineScores status state currentClock currentPeriod currentPossession currentSituation lastPlay startDate } }`;
export interface Subscription { onPayload: (payload: unknown) => Promise<void>; onDisconnect: () => void; }

export function connect(config: Config, subscription: Subscription): WebSocket {
  const authorization = `Bearer ${config.cfbdKey}`;
  const ws = new WebSocket("wss://graphql.collegefootballdata.com/v1/graphql", "graphql-transport-ws");
  ws.addEventListener("open", () => { ws.send(JSON.stringify({ type: "connection_init", payload: { headers: { Authorization: authorization } } })); });
  ws.addEventListener("message", async (event) => {
    try {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as { type: string; id?: string; payload?: unknown };
      if (message.type === "connection_ack") ws.send(JSON.stringify({ id: "scoreboard", type: "subscribe", payload: { query, operationName: "Scoreboard" } }));
      else if (message.type === "next" && message.payload !== undefined) await subscription.onPayload(message.payload);
      else if (message.type === "error") subscription.onDisconnect();
    } catch { subscription.onDisconnect(); }
  });
  ws.addEventListener("close", subscription.onDisconnect);
  ws.addEventListener("error", subscription.onDisconnect);
  return ws;
}
