import { loadConfig } from "./config.js";
import { connect } from "./cfbd.js";
import { flush } from "./delivery.js";
import { normalizeScoreboard } from "./normalize.js";
import { Outbox } from "./outbox.js";

const config = loadConfig();
const outbox = new Outbox(config.dataDir);
let stopped = false;
let socket: ReturnType<typeof connect> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;
let connectionGeneration = 0;

const schedule = (): void => {
  if (stopped || reconnectTimer) return;
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(attempt++, 6));
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; const generation = ++connectionGeneration; let disconnected = false; const onDisconnect = (): void => { if (disconnected || generation !== connectionGeneration) return; disconnected = true; socket = undefined; schedule(); }; socket = connect(config, { onPayload: async (payload) => { const batch = normalizeScoreboard(payload, (id) => outbox.nextRevision(id), config.season, config.seasonType, config.week, outbox.sourceEpoch); outbox.enqueue(batch); await flush(outbox, config); }, onDisconnect }); }, base * (0.75 + Math.random() * 0.5));
};
const retryTimer = setInterval(() => { void flush(outbox, config); }, 5_000);
const stop = async (): Promise<void> => { stopped = true; clearInterval(retryTimer); if (reconnectTimer) clearTimeout(reconnectTimer); socket?.close(1000, "shutdown"); await flush(outbox, config); outbox.close(); process.exit(0); };
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
void flush(outbox, config).then(schedule).catch(schedule);
