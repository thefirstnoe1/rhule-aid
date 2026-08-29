import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGames, getMedia } from "cfbd";
import { handleScheduleRequest } from "../src/api/schedule.ts";

vi.mock("cfbd", () => ({
  client: { setConfig: vi.fn() },
  getGames: vi.fn(),
  getMedia: vi.fn(),
}));

const now = new Date("2026-07-14T12:00:00.000Z").getTime();
const schedule = [{ opponent: "Iowa", date: "Saturday", isHome: true }];
const cacheKey = "nebraska_schedule_2025_cfbd_huskers_v9";

function createCache(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _options?: Record<string, unknown>) => values.set(key, value)),
  };
}

function cachedSchedule(payload = schedule, freshUntil = now + 60_000, retainUntil = now + 600_000) {
  return JSON.stringify({
    schema: "v9",
    payload,
    dataUpdatedAt: now - 60_000,
    freshUntil,
    retainUntil,
    source: "cfbd-api",
    season: 2025,
  });
}

function request() {
  return new Request("https://rhule-aid.com/api/schedule?season=2025", {
    headers: { "cf-ray": "ray-test-1" },
  });
}

function env(cache: ReturnType<typeof createCache>, apiKey = "test-key") {
  return { SCHEDULE_CACHE: cache, CFBD_API_KEY: apiKey };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.mocked(getGames).mockReset();
  vi.mocked(getMedia).mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled"); }));
});

describe("handleScheduleRequest", () => {
  it("returns a fresh retained cache response without upstream calls", async () => {
    const cache = createCache({ [cacheKey]: cachedSchedule() });

    const response = await handleScheduleRequest(request(), env(cache));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual(schedule);
    expect(body.cached).toBe(true);
    expect(body.meta.cacheMode).toBe("fresh-cache");
    expect(body.meta.stale).toBe(false);
    expect(body.meta.dataUpdatedAt).toBe(new Date(now - 60_000).toISOString());
    expect(body.meta.servedAt).toBe(new Date(now).toISOString());
    expect(getGames).not.toHaveBeenCalled();
    expect(getMedia).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats a retained empty successful schedule as valid", async () => {
    const cache = createCache({ [cacheKey]: cachedSchedule([], now + 60_000, now + 600_000) });

    const response = await handleScheduleRequest(request(), env(cache));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.meta.cacheMode).toBe("fresh-cache");
  });

  it("accepts a resolved empty CFBD schedule response", async () => {
    const cache = createCache();
    vi.mocked(getGames).mockResolvedValue({ data: [] } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);

    const response = await handleScheduleRequest(request(), env(cache));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
    expect(body.meta.sources.cfbdGames).toBe("live");
  });

  it("serves stale retained data when upstream fails", async () => {
    const cache = createCache({ [cacheKey]: cachedSchedule(schedule, now - 1, now + 600_000) });
    vi.mocked(getGames).mockRejectedValue(new Error("CFBD unavailable"));
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);

    const response = await handleScheduleRequest(request(), env(cache));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual(schedule);
    expect(body.stale).toBe(true);
    expect(body.meta.cacheMode).toBe("stale-cache");
    expect(body.meta.sourceState).toBe("stale-cache");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    const leaseWrite = cache.put.mock.calls.find(([key]) => key.endsWith(":lease"));
    expect(leaseWrite?.[2]).toEqual(expect.objectContaining({ expirationTtl: expect.any(Number) }));
    expect((leaseWrite?.[2] as { expirationTtl: number }).expirationTtl).toBeGreaterThanOrEqual(60);
  });

  it("does not replace retained schedule with malformed CFBD data", async () => {
    const cache = createCache({ [cacheKey]: cachedSchedule(schedule, now - 1, now + 600_000) });
    vi.mocked(getGames).mockResolvedValue({ data: [{ malformed: true }] } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);

    const response = await handleScheduleRequest(request(), env(cache));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual(schedule);
    expect(body.stale).toBe(true);
    expect(cache.put).not.toHaveBeenCalledWith(cacheKey, expect.anything(), expect.anything());
  });

  it("returns generic errors with request ID and no-store on failure", async () => {
    const cache = createCache();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getGames).mockRejectedValue({ secret: "do not expose" });
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);

    const response = await handleScheduleRequest(request(), env(cache));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.success).toBe(false);
    expect(body.error).toBe("upstream_error");
    expect(body.meta.sources.cfbdGames).toBe("error");
    expect(JSON.stringify(body)).not.toContain("do not expose");
    expect(response.headers.get("X-Request-ID")).toBe("ray-test-1");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("do not expose");
    errorSpy.mockRestore();
  });

  it("canonicalizes TBA and confirmed kickoff data and stable fallback keys", async () => {
    const cache = createCache();
    vi.mocked(getGames).mockResolvedValue({
      data: [
        { homeTeam: "Nebraska", awayTeam: "Iowa", startDate: "2026-09-05T00:00:00.000Z", startTimeTBD: true, venue: "Memorial Stadium" },
        { homeTeam: "Nebraska", awayTeam: "Minnesota", startDate: "2026-11-01T00:00:00.000Z", startTimeTBD: false, venue: "Memorial Stadium" },
      ],
    } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);

    const response = await handleScheduleRequest(request(), env(cache));
    const body = await response.json();
    const tba = body.data.find((game: { opponent: string }) => game.opponent === "Iowa");
    const confirmed = body.data.find((game: { opponent: string }) => game.opponent === "Minnesota");

    expect(tba.time).toBe("TBD");
    expect(tba.kickoffStatus).toBe("tba");
    expect(tba.gameKey).toBe("nebraska:2025:iowa");
    expect(confirmed.kickoffStatus).toBe("confirmed");
    expect(confirmed.kickoffAt).toBe("2026-11-01T00:00:00.000Z");
    expect(confirmed.time).toContain("7:00 PM");
    expect(confirmed.venue.timezone).toBeNull();
  });

  it("uses canonical kickoff instants across CST and CDT transitions", async () => {
    const cache = createCache();
    vi.mocked(getGames).mockResolvedValue({ data: [
      { homeTeam: "Nebraska", awayTeam: "Iowa", startDate: "2026-11-07T01:00:00.000Z", startTimeTBD: false },
      { homeTeam: "Nebraska", awayTeam: "Minnesota", startDate: "2026-11-14T17:00:00.000Z", startTimeTBD: false },
      { homeTeam: "Nebraska", awayTeam: "Wisconsin", startDate: "2026-09-05T18:00:00.000Z", startTimeTBD: false },
    ] } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);

    const body = await (await handleScheduleRequest(request(), env(cache))).json();
    const byOpponent = (opponent: string) => body.data.find((game: { opponent: string }) => game.opponent === opponent);

    expect(byOpponent("Iowa").kickoffAt).toBe("2026-11-07T01:00:00.000Z");
    expect(byOpponent("Iowa").time).toContain("7:00 PM");
    expect(byOpponent("Minnesota").time).toContain("11:00 AM");
    expect(byOpponent("Wisconsin").time).toContain("1:00 PM");
  });

  it("clears a placeholder kickoffAt for an official TBA override", async () => {
    const cache = createCache();
    vi.mocked(getGames).mockResolvedValue({ data: [{ homeTeam: "Nebraska", awayTeam: "Iowa", startDate: "2025-09-05T00:00:00.000Z", startTimeTBD: false }] } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("huskers.com")
      ? new Response(JSON.stringify({ data: [{ datetime: "2025-09-05T00:00:00.000Z", tba: true, opponent_name: "Iowa", venue: "Memorial Stadium", schedule_event_links: [] }] }), { status: 200 })
      : new Response(JSON.stringify({ data: [] }), { status: 200 })));

    const body = await (await handleScheduleRequest(request(), env(cache))).json();
    const game = body.data[0];
    expect(game.kickoffAt).toBeUndefined();
    expect(game.kickoffStatus).toBe("tba");
    expect(game.time).toBe("TBD");
  });

  it("locks official time_tba events to TBD without retaining placeholder kickoffs", async () => {
    const cache = createCache();
    const tbaOpponents = ["Iowa", "Oregon", "Minnesota", "Wisconsin", "Illinois", "Michigan", "UCLA"];
    const confirmedOpponents = ["Indiana", "Ohio State", "Penn State", "Rutgers", "USC"];
    const opponents = [...tbaOpponents, ...confirmedOpponents];
    vi.mocked(getGames).mockResolvedValue({ data: opponents.map((opponent, index) => ({
      homeTeam: "Nebraska",
      awayTeam: opponent,
      startDate: `2025-09-${String(index + 1).padStart(2, "0")}T18:00:00.000Z`,
      startTimeTBD: false,
    })) } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("huskers.com")
      ? new Response(JSON.stringify({ data: opponents.map((opponent, index) => ({
        datetime: `2025-09-${String(index + 1).padStart(2, "0")}T18:00:00.000Z`,
        tba: tbaOpponents.includes(opponent) ? "time_tba" : false,
        opponent_name: opponent,
        schedule_event_links: [],
      })) }), { status: 200 })
      : new Response(JSON.stringify({ events: [] }), { status: 200 })));

    const body = await (await handleScheduleRequest(request(), env(cache))).json();
    const tbaGames = body.data.filter((game: { kickoffStatus: string }) => game.kickoffStatus === "tba");

    expect(tbaGames).toHaveLength(7);
    expect(tbaGames.map((game: { opponent: string }) => game.opponent)).toContain("Oregon");
    expect(tbaGames.every((game: { time: string; kickoffAt?: string; fieldProvenance?: { kickoffAt?: string } }) =>
      game.time === "TBD" && game.kickoffAt === undefined && game.fieldProvenance?.kickoffAt === "huskers"
    )).toBe(true);
  });

  it("matches ESPN media by teams when media date differs by one day", async () => {
    const cache = createCache();
    vi.mocked(getGames).mockResolvedValue({
      data: [{ homeTeam: "Nebraska", awayTeam: "Iowa", startDate: "2025-09-05T18:00:00.000Z", venue: "Memorial Stadium" }],
    } as never);
    vi.mocked(getMedia).mockResolvedValue({
      data: [{ id: 456, espnId: 987, outlet: "ESPN", homeTeam: "nebraska", awayTeam: "IOWA", startTime: "2025-09-06T18:00:00.000Z" }],
    } as never);

    const response = await handleScheduleRequest(request(), env(cache));
    const body = await response.json();

    expect(body.data[0].network).toBe("ESPN");
    expect(body.data[0].tvNetwork).toBe("ESPN");
    expect(body.data[0].providerIds).toBeUndefined();
  });

  it("rejects an ESPN team match outside the timezone-aware date window", async () => {
    const cache = createCache();
    vi.mocked(getGames).mockResolvedValue({ data: [{ homeTeam: "Nebraska", awayTeam: "Iowa", startDate: "2025-09-05T18:00:00.000Z" }] } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [{ id: 987, outlet: "ESPN", homeTeam: "Nebraska", awayTeam: "Iowa", startTime: "2025-09-08T18:00:00.000Z" }] } as never);

    const body = await (await handleScheduleRequest(request(), env(cache))).json();

    expect(body.data[0].network).toBe("TBD");
    expect(body.data[0].providerIds).toBeUndefined();
    expect(body.meta.sources.cfbdMedia).toBe("live");
  });

  it("attaches the actual ESPN event ID only for a validated match", async () => {
    const cache = createCache();
    vi.mocked(getGames).mockResolvedValue({ data: [{ homeTeam: "Nebraska", awayTeam: "Iowa", startDate: "2025-09-05T18:00:00.000Z", venue: "CFBD venue", tv: "CFBD TV" }] } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("site.api.espn.com")) {
        return new Response(JSON.stringify({ events: [{ id: "opaque-espn-event-123", competitions: [{ date: "2025-09-06T00:00:00.000Z", timeValid: true, status: { type: {} }, venue: { fullName: "ESPN venue", address: { street: "1 Stadium Drive", city: "Lincoln", state: "NE", zipCode: "68588" } }, broadcasts: [{ names: ["ESPN2"] }], competitors: [
          { team: { id: "158", location: "Nebraska" }, homeAway: "home" },
          { team: { id: "2294", location: "Iowa" }, homeAway: "away", score: "99" },
        ] }] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));

    const body = await (await handleScheduleRequest(request(), env(cache))).json();

    expect(body.data[0].providerIds?.espn).toBe("opaque-espn-event-123");
    expect(body.meta.sources.espn).toBe("live");
    expect(body.data[0].kickoffAt).toBe("2025-09-06T00:00:00.000Z");
    expect(body.data[0].kickoffStatus).toBe("confirmed");
    expect(body.data[0].venue.name).toBe("ESPN venue");
    expect(body.data[0].venue.address).toEqual({ street: "1 Stadium Drive", city: "Lincoln", region: "NE", postalCode: "68588" });
    expect(body.data[0].network).toBe("CFBD TV");
    expect(body.data[0].score).toBeUndefined();
  });

  it("rejects wrong, missing-Nebraska, ambiguous, and out-of-date ESPN events", async () => {
    const cache = createCache();
    vi.mocked(getGames).mockResolvedValue({ data: [
      { homeTeam: "Nebraska", awayTeam: "Iowa", startDate: "2025-09-05T18:00:00.000Z" },
      { homeTeam: "Nebraska", awayTeam: "Minnesota", startDate: "2025-09-05T18:00:00.000Z" },
      { homeTeam: "Nebraska", awayTeam: "Wisconsin", startDate: "2025-09-05T18:00:00.000Z" },
      { homeTeam: "Nebraska", awayTeam: "Michigan", startDate: "2025-09-05T18:00:00.000Z" },
    ] } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);
    const event = (id: string, opponent: string, date: string, includeNebraska = true) => ({ id, competitions: [{ date, competitors: [
      ...(includeNebraska ? [{ team: { id: "158", location: "Nebraska" } }] : [{ team: { id: "999", location: "Ohio State" } }]),
      { team: { id: "2", location: opponent } },
    ] }] });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("site.api.espn.com")) {
        return new Response(JSON.stringify({ events: [
          event("40123456", "Ohio State", "2025-09-05T18:00:00.000Z"),
          event("40123457", "Minnesota", "2025-09-05T18:00:00.000Z", false),
          event("40123458", "Wisconsin", "2025-09-05T18:00:00.000Z"),
          event("40123459", "Wisconsin", "2025-09-06T18:00:00.000Z"),
          event("40123460", "Michigan", "2025-09-08T18:00:00.000Z"),
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));

    const body = await (await handleScheduleRequest(request(), env(cache))).json();

    expect(body.data.every((game: { providerIds?: { espn?: string } }) => game.providerIds?.espn === undefined)).toBe(true);
  });

  it("matches TBA games by source calendar date without confirming kickoff", async () => {
    const cache = createCache();
    vi.mocked(getGames).mockResolvedValue({ data: [{ homeTeam: "Nebraska", awayTeam: "Iowa", startDate: "2025-09-05T00:00:00.000Z", startTimeTBD: true }] } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("site.api.espn.com")
      ? new Response(JSON.stringify({ events: [{ id: "tba-espn-1", competitions: [{ date: "2025-09-05T18:00:00.000Z", timeValid: true, status: { type: {} }, competitors: [
        { team: { id: "158", location: "Nebraska" } }, { team: { id: "2294", location: "Iowa" } },
      ] }] }] }), { status: 200 })
      : new Response(JSON.stringify({ data: [] }), { status: 200 })));

    const game = (await (await handleScheduleRequest(request(), env(cache))).json()).data[0];

    expect(game.providerIds.espn).toBe("tba-espn-1");
    expect(game.kickoffAt).toBe("2025-09-05T18:00:00.000Z");
    expect(game.kickoffStatus).toBe("confirmed");
    expect(game.time).toBe("1:00 PM");
  });

  it("accepts an empty ESPN events response and preserves canonical CFBD fields", async () => {
    const cache = createCache();
    vi.mocked(getGames).mockResolvedValue({ data: [{ homeTeam: "Nebraska", awayTeam: "Iowa", startDate: "2025-09-05T18:00:00.000Z", venue: "CFBD venue", tv: "CFBD TV", homePoints: 24, awayPoints: 10 }] } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("site.api.espn.com")
      ? new Response(JSON.stringify({ events: [] }), { status: 200 })
      : new Response(JSON.stringify({ data: [] }), { status: 200 })));

    const body = await (await handleScheduleRequest(request(), env(cache))).json();
    const game = body.data[0];

    expect(body.meta.sources.espn).toBe("live");
    expect(game.kickoffAt).toBe("2025-09-05T18:00:00.000Z");
    expect(game.venue.name).toBe("CFBD venue");
    expect(game.network).toBe("CFBD TV");
    expect(game.score).toBe("24-10");
  });

  it("keeps valid CFBD data on ESPN failure and retains prior advisory IDs", async () => {
    const retained = { ...schedule[0], gameKey: "nebraska:2025:iowa", kickoffAt: "2025-09-05T18:00:00.000Z", kickoffStatus: "confirmed" as const, venue: { name: "Retained ESPN venue", timezone: null }, location: "Retained ESPN venue", fieldProvenance: { kickoffAt: "espn" as const, venue: "espn" as const }, providerIds: { espn: "40123499" } };
    const cache = createCache({ [cacheKey]: cachedSchedule([retained], now - 1, now + 600_000) });
    vi.mocked(getGames).mockResolvedValue({ data: [{ homeTeam: "Nebraska", awayTeam: "Iowa", startDate: "2025-09-05T18:00:00.000Z" }] } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("site.api.espn.com")
      ? new Response("upstream down", { status: 503 })
      : new Response(JSON.stringify({ data: [] }), { status: 200 })));

    const body = await (await handleScheduleRequest(request(), env(cache))).json();

    expect(body.success).toBe(true);
    expect(body.data[0].providerIds.espn).toBe("40123499");
    expect(body.data[0].kickoffAt).toBe(retained.kickoffAt);
    expect(body.data[0].venue).toEqual(retained.venue);
    expect(body.data[0].fieldProvenance).toEqual(retained.fieldProvenance);
    expect(body.meta.sources.espn).toBe("error");
  });

  it("requires ESPN timeValid and blocks CFBD promotion for explicit ESPN TBD", async () => {
    const cache = createCache();
    vi.mocked(getGames).mockResolvedValue({ data: [
      { homeTeam: "Nebraska", awayTeam: "Iowa", startDate: "2025-09-05T18:00:00.000Z" },
      { homeTeam: "Nebraska", awayTeam: "Minnesota", startDate: "2025-09-06T00:00:00.000Z", startTimeTBD: true },
    ] } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("site.api.espn.com")
      ? new Response(JSON.stringify({ events: [
        { id: "espn-invalid-time", competitions: [{ date: "2025-09-05T18:00:00.000Z", timeValid: false, status: { type: { detail: "Scheduled" } }, competitors: [{ team: { id: "158", location: "Nebraska" } }, { team: { id: "2294", location: "Iowa" } }] }] },
        { id: "espn-explicit-tbd", competitions: [{ date: "2025-09-06T18:00:00.000Z", timeValid: true, status: { type: { detail: "Time TBD" } }, competitors: [{ team: { id: "158", location: "Nebraska" } }, { team: { id: "2294", location: "Minnesota" } }] }] },
      ] }), { status: 200 })
      : new Response(JSON.stringify({ data: [] }), { status: 200 })));

    const body = await (await handleScheduleRequest(request(), env(cache))).json();
    const iowa = body.data.find((game: { opponent: string }) => game.opponent === "Iowa");
    const minnesota = body.data.find((game: { opponent: string }) => game.opponent === "Minnesota");
    expect(iowa.kickoffAt).toBe("2025-09-05T18:00:00.000Z");
    expect(iowa.fieldProvenance?.kickoffAt).toBe("cfbd");
    expect(minnesota.kickoffAt).toBeUndefined();
    expect(minnesota.kickoffStatus).toBe("tba");
    expect(minnesota.time).toBe("TBD");
  });

  it("returns valid CFBD data with a safe ESPN timeout state", async () => {
    const cache = createCache();
    vi.mocked(getGames).mockResolvedValue({ data: [{ homeTeam: "Nebraska", awayTeam: "Iowa", startDate: "2025-09-05T18:00:00.000Z" }] } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("site.api.espn.com")) return new Promise<Response>(() => undefined);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));

    const responsePromise = handleScheduleRequest(request(), env(cache));
    await vi.advanceTimersByTimeAsync(8_001);
    const response = await responsePromise;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.meta.sources.espn).toBe("timeout");
  });

  it("returns valid CFBD data with an invalid ESPN payload state", async () => {
    const cache = createCache();
    vi.mocked(getGames).mockResolvedValue({ data: [{ homeTeam: "Nebraska", awayTeam: "Iowa", startDate: "2025-09-05T18:00:00.000Z" }] } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("site.api.espn.com")
      ? new Response(JSON.stringify({ events: "not-an-array" }), { status: 200 })
      : new Response(JSON.stringify({ data: [] }), { status: 200 })));

    const response = await handleScheduleRequest(request(), env(cache));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.meta.sources.espn).toBe("invalid");
  });

  it("keeps an explicitly confirmed Husker midnight kickoff confirmed", async () => {
    const cache = createCache();
    vi.mocked(getGames).mockResolvedValue({ data: [{ homeTeam: "Nebraska", awayTeam: "Iowa", startDate: "2025-09-05T12:00:00.000Z" }] } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ datetime: "2025-09-05T00:00:00.000Z", tba: false, opponent_name: "Iowa", venue: "Memorial Stadium", schedule_event_links: [] }],
    }), { status: 200 })));

    const body = await (await handleScheduleRequest(request(), env(cache))).json();
    const game = body.data[0];

    expect(game.time).toContain("7:00 PM");
    expect(game.kickoffStatus).toBe("confirmed");
    expect(game.kickoffAt).toBe("2025-09-05T00:00:00.000Z");
  });

  it("exposes safe upstream error and malformed source states", async () => {
    const errorCache = createCache();
    vi.mocked(getGames).mockRejectedValue(new Error("CFBD unavailable"));
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);
    const errorBody = await (await handleScheduleRequest(request(), env(errorCache))).json();
    expect(errorBody.error).toBe("upstream_error");
    expect(errorBody.meta.sources.cfbdGames).toBe("error");

    const malformedCache = createCache();
    vi.mocked(getGames).mockResolvedValue({ nope: true } as never);
    const malformedBody = await (await handleScheduleRequest(request(), env(malformedCache))).json();
    expect(malformedBody.error).toBe("invalid_response");
    expect(malformedBody.meta.sources.cfbdGames).toBe("invalid");
  });

  it("merges Husker override provenance for venue and kickoff", async () => {
    const cache = createCache();
    vi.mocked(getGames).mockResolvedValue({
      data: [{ homeTeam: "Nebraska", awayTeam: "Iowa", startDate: "2026-09-05T18:00:00.000Z", venue: "Memorial Stadium" }],
    } as never);
    vi.mocked(getMedia).mockResolvedValue({ data: [] } as never);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{
        datetime: "2025-09-05T18:30:00.000Z",
        opponent_name: "Iowa",
        venue: "Memorial Stadium",
        schedule_event_links: [],
      }],
    }), { status: 200 })));

    const response = await handleScheduleRequest(request(), env(cache));
    const body = await response.json();
    const game = body.data[0];

    expect(game.fieldProvenance).toEqual(expect.objectContaining({
      kickoffAt: "huskers",
      venue: "huskers",
    }));
    expect(game.venue.name).toBe("Memorial Stadium");
    expect(game.kickoffStatus).toBe("confirmed");
  });
});
