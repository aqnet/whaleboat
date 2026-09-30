import { afterEach, describe, expect, it, vi } from "vitest";

// Never read the real repo-root .env.local: these tests must not reach the
// live database. Each test sets what it needs.
const env: Record<string, string | undefined> = {};
vi.mock("./serverEnv", () => ({ serverEnv: (name: string) => env[name] }));
// No local sample files either: listSamples() sees an empty directory.
vi.mock("node:fs/promises", async (orig) => ({
  ...(await orig<typeof import("node:fs/promises")>()),
  readdir: vi.fn(async () => []),
}));

const { tracksFromText, loadWindow, WINDOW_ID, WINDOW_S } = await import("./ais");

// --- AISStream message builders ----------------------------------------------

const T0 = Date.UTC(2026, 8, 30, 17, 0, 0) / 1000; // 2026-09-30 17:00:00 UTC

function aisTime(t: number): string {
  const d = new Date(t * 1000).toISOString(); // 2026-09-30T17:00:00.000Z
  return `${d.slice(0, 10)} ${d.slice(11, 23)}000000 +0000 UTC`;
}

function position(mmsi: number, t: number, lat: number, lon: number, sog: number | null = 8, cls: "A" | "B" = "A", name = "") {
  const type = cls === "A" ? "PositionReport" : "StandardClassBPositionReport";
  return JSON.stringify({
    MessageType: type,
    MetaData: { MMSI: mmsi, ShipName: name, latitude: lat, longitude: lon, time_utc: aisTime(t) },
    Message: { [type]: { Sog: sog ?? 102.3, Cog: 90 } },
  });
}

function staticData(mmsi: number, name: string, type: number, lengthM: number) {
  return JSON.stringify({
    MessageType: "ShipStaticData",
    MetaData: { MMSI: mmsi, ShipName: name, time_utc: aisTime(T0) },
    Message: { ShipStaticData: { Name: `${name}   `, Type: type, Dimension: { A: lengthM - 5, B: 5 } } },
  });
}

const lines = (...ls: string[]) => [ls.join("\n")];

// ~0.1 nm north per step at this latitude: 8 kn over 45 s is ~0.1 nm.
const step = (i: number) => 48.1 + i * 0.00167;

afterEach(() => {
  for (const k of Object.keys(env)) delete env[k];
});

// --- Track building --------------------------------------------------------------

describe("tracksFromText", () => {
  it("builds one track per vessel with class, name, type and length", () => {
    const s = tracksFromText("f", ["f"], lines(
      staticData(368457860, "EMERALD CLIPPER", 60, 31),
      position(368457860, T0, step(0), -122.5),
      position(368457860, T0 + 45, step(1), -122.5),
      position(338000001, T0, 48.2, -122.6, 5, "B", "SMALL BOAT"),
      position(338000001, T0 + 60, 48.2016, -122.6, 5, "B"),
    ), null);
    expect(s.vessels).toHaveLength(2);
    const clipper = s.vessels.find((v) => v.mmsi === 368457860)!;
    expect(clipper).toMatchObject({ name: "EMERALD CLIPPER", cls: "A", shipType: 60, lengthM: 31 });
    expect(clipper.fixes).toHaveLength(2);
    expect(clipper.whaleWatch).toMatchObject({ operator: "FRS Clipper", confirmed: true });
    const small = s.vessels.find((v) => v.mmsi === 338000001)!;
    expect(small).toMatchObject({ name: "SMALL BOAT", cls: "B", whaleWatch: null });
  });

  it("parses the AIS timestamp and counts messages and position reports", () => {
    const s = tracksFromText("f", ["f"], lines(staticData(1, "X", 60, 20), position(1, T0, 48.1, -122.5), "not json", ""), null);
    expect(s.vessels[0].fixes[0].t).toBeCloseTo(T0, 3);
    expect(s.messages).toBe(2);
    expect(s.positionReports).toBe(1);
    expect(s.start).toBeCloseTo(T0, 3);
  });

  it("treats the 102.3 kn 'not available' speed as unknown", () => {
    const s = tracksFromText("f", ["f"], lines(position(1, T0, 48.1, -122.5, null)), null);
    expect(s.vessels[0].fixes[0].sog).toBeNull();
  });

  it("drops a repeat report within the same second", () => {
    const s = tracksFromText("f", ["f"], lines(position(1, T0, 48.1, -122.5), position(1, T0 + 0.4, 48.1, -122.5)), null);
    expect(s.vessels[0].fixes).toHaveLength(1);
  });

  it("drops a fix that implies an impossible speed", () => {
    // 1° of latitude (60 nm) in one minute.
    const s = tracksFromText("f", ["f"], lines(position(1, T0, 48.1, -122.5), position(1, T0 + 60, 49.1, -122.5), position(1, T0 + 120, 48.1033, -122.5)), null);
    expect(s.vessels[0].fixes.map((f) => f.lat)).toEqual([48.1, 48.1033]);
  });

  it("starts a new segment after a gap of more than 10 minutes and skips one-point segments", () => {
    const s = tracksFromText("f", ["f"], lines(
      position(1, T0, step(0), -122.5),
      position(1, T0 + 45, step(1), -122.5),
      position(1, T0 + 45 + 11 * 60, step(2), -122.5), // alone after the gap
      position(1, T0 + 45 + 30 * 60, step(3), -122.5),
      position(1, T0 + 45 + 30 * 60 + 45, step(4), -122.5),
    ), null);
    const v = s.vessels[0];
    expect(v.fixes).toHaveLength(5);
    expect(v.segments.map((seg) => seg.path.length)).toEqual([2, 2]);
  });

  it("flags vessels as moving by speed or distance", () => {
    const s = tracksFromText("f", ["f"], lines(
      position(1, T0, 48.1, -122.5, 0), position(1, T0 + 60, 48.1, -122.5, 0), // moored
      position(2, T0, step(0), -122.6, 8), position(2, T0 + 45, step(1), -122.6, 8), // under way
    ), null);
    expect(s.vessels.find((v) => v.mmsi === 1)!.moving).toBe(false);
    expect(s.vessels.find((v) => v.mmsi === 2)!.moving).toBe(true);
    expect(s.vessels[0].mmsi).toBe(2); // moving vessels sort first
  });

  it("with a window start, drops older fixes and vessels left with none", () => {
    const s = tracksFromText("f", ["f"], lines(
      position(1, T0 - 3600, 48.1, -122.5), position(1, T0, 48.1016, -122.5),
      position(2, T0 - 3600, 48.3, -122.7), // only an old fix
      staticData(3, "STATIC ONLY", 37, 10), // never reported a position
    ), T0 - 60);
    expect(s.vessels.map((v) => v.mmsi)).toEqual([1]);
    expect(s.vessels[0].fixes).toHaveLength(1);
    expect(s.windowStart).toBe(T0 - 60);
  });

  it("merges several sample files into one track per vessel", () => {
    const a = position(1, T0, step(0), -122.5);
    const b = position(1, T0 + 45, step(1), -122.5);
    const s = tracksFromText(WINDOW_ID, ["a", "b"], [a, `${b}\n${a}`], null);
    expect(s.vessels[0].fixes).toHaveLength(2); // the overlap's duplicate is dropped
    expect(s.files).toEqual(["a", "b"]);
  });
});

// --- 48 h window from the database ------------------------------------------------

describe("loadWindow", () => {
  it("reads the window from the database when it is configured", async () => {
    env.SUPABASE_URL = "https://db.test";
    env.SUPABASE_SECRET_KEY = "test-key";
    const now = T0 + 3600;
    const fetchMock = vi.fn(async () =>
      Response.json({
        vessels: [{ mmsi: 368400660, name: "WAKE", cls: "B", shipType: 37, lengthM: 10 }],
        fixes: [
          [368400660, T0, -122.6, step(0), 6, 90],
          [368400660, T0 + 45, -122.6, step(1), 6, 90],
          [999000001, T0, -122.7, 48.3, null, null], // a vessel with no row in `vessels`
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const s = await loadWindow(now);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://db.test/rest/v1/rpc/tracks_window");
    expect((init.headers as Record<string, string>).apikey).toBe("test-key");
    expect(JSON.parse(init.body as string).since).toBe(new Date((now - WINDOW_S) * 1000).toISOString());

    expect(s).toMatchObject({ file: WINDOW_ID, source: "supabase", positionReports: 3 });
    const wake = s.vessels.find((v) => v.mmsi === 368400660)!;
    expect(wake).toMatchObject({ name: "WAKE", cls: "B", whaleWatch: { vessel: "Wake", confirmed: true } });
    expect(wake.fixes[0]).toMatchObject({ lon: -122.6, lat: step(0), sog: 6 });
    expect(s.vessels.find((v) => v.mmsi === 999000001)).toMatchObject({ name: "", cls: "?" });
  });

  it("falls back to local samples when the database read fails", async () => {
    env.SUPABASE_URL = "https://db.test";
    env.SUPABASE_SECRET_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await loadWindow(T0);
    expect(s).toMatchObject({ source: "files", files: [], positionReports: 0, vessels: [] });
  });

  it("uses local samples, without calling the database, when it isn't configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const s = await loadWindow(T0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.source).toBe("files");
  });
});
