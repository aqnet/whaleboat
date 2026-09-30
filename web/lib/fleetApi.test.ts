import { describe, expect, it } from "vitest";
import { GET } from "../app/api/v1/fleet/route";
import { fleetResponse } from "./fleetApi";
import { OPERATORS } from "./whaleWatch";

const body = fleetResponse("2026-09-30T00:00:00.000Z");

describe("GET /api/v1/fleet", () => {
  it("serves JSON that any site can read, cached", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toMatch(/public/);
    const json = await res.json();
    expect(json.version).toBe(1);
    expect(Date.parse(json.generatedAt)).not.toBeNaN();
  });
});

describe("fleetResponse", () => {
  it("keeps the vessel fields compatible with the lovejoydiver list", () => {
    for (const v of body.vessels) {
      expect(Object.keys(v).sort()).toEqual(["homePort", "mmsi", "name", "operator", "operatorId", "operatorUrl"]);
      expect(v.mmsi === null || /^\d{9}$/.test(v.mmsi)).toBe(true); // string, like theirs
    }
  });

  it("lists every registry boat except those with an unknown operator", () => {
    const expected = OPERATORS.filter((o) => o.id !== "unknown").flatMap((o) => o.vessels.flatMap((v) => (v.mmsis?.length ? v.mmsis : [null])));
    expect(body.count).toBe(expected.length);
    expect(body.vessels).toHaveLength(body.count);
    expect(body.vessels.some((v) => v.operatorId === "unknown")).toBe(false);
    expect(body.vessels.some((v) => v.name === "Peregrine")).toBe(false);
  });

  it("has no duplicate MMSIs", () => {
    const mmsis = body.vessels.map((v) => v.mmsi).filter(Boolean);
    expect(new Set(mmsis).size).toBe(mmsis.length);
  });

  it("includes the requested boats", () => {
    const byName = Object.fromEntries(body.vessels.map((v) => [v.name, v]));
    expect(byName["Emerald Clipper"]).toMatchObject({ mmsi: "368457860", operator: "FRS Clipper" });
    expect(byName["Wild 4 Whales"]).toMatchObject({ mmsi: "316034816", operator: "Eagle Wing Tours" });
    expect(byName["Blackfish III"]).toMatchObject({ mmsi: null, operatorUrl: "https://www.outerislandx.com/ourfleet" });
  });

  it("credits its sources and publishes no positions", () => {
    expect(body.sources.map((s) => s.name)).toContain("whales.lovejoydiver.net");
    expect(JSON.stringify(body)).not.toMatch(/"(lat|lon|latitude|longitude|positions?)"/);
  });
});
