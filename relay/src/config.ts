export interface Config {
  cfbdKey: string;
  targetUrl: string;
  hmacSecret: string;
  keyId?: string;
  dataDir: string;
  season: number;
  seasonType: "regular" | "postseason" | "spring";
  week: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const targetUrl = required("RELAY_TARGET_URL");
  try {
    const url = new URL(targetUrl);
    if (url.protocol !== "https:" || url.pathname !== "/api/internal/cfbd/events" || url.search || url.hash || url.username || url.password) throw new Error();
  } catch { throw new Error("RELAY_TARGET_URL must be HTTPS /api/internal/cfbd/events without query, hash, or credentials"); }
  const integer = (name: string): number => {
    const value = Number(required(name));
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    return value;
  };
  const seasonType = required("CFBD_SEASON_TYPE");
  if (seasonType !== "regular" && seasonType !== "postseason" && seasonType !== "spring") throw new Error("CFBD_SEASON_TYPE must be regular, postseason, or spring");
  return { cfbdKey: required("CFBD_KEY"), targetUrl, hmacSecret: required("RELAY_HMAC_SECRET"), keyId: env.RELAY_KEY_ID || undefined, dataDir: env.RELAY_DATA_DIR || "/data", season: integer("CFBD_SEASON"), seasonType, week: integer("CFBD_WEEK") };
}
