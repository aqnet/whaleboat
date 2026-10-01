import { describe, expect, it } from "vitest";
import { mergeSightings, parseAcartia, speciesOf, type WhaleSighting } from "./acartia";

// Shaped like rows from https://acartia.io/api/v1/sightings/current.
const row = (over: Record<string, unknown> = {}) => ({
  ssemmi_id: "SPOTTER 261770",
  entry_id: "3b10bea3",
  created: "2026-09-25 00:27:00",
  type: "Orca",
  no_sighted: 1,
  latitude: 47.29642,
  longitude: -122.72165,
  trusted: 1,
  data_source_comments: "[Orca Network] Biggs T65A5 milling ",
  photo_url: "",
  ...over,
});

describe("speciesOf", () => {
  it("groups reported names into the map's species", () => {
    expect(speciesOf("Orca")).toBe("Orca");
    expect(speciesOf("Killer Whale")).toBe("Orca");
    expect(speciesOf("Humpback")).toBe("Humpback");
    expect(speciesOf("Gray Whale")).toBe("Gray whale");
    expect(speciesOf("Grey whale")).toBe("Gray whale");
    expect(speciesOf("Minke Whale")).toBe("Other");
    expect(speciesOf("Unspecified")).toBe("Other");
  });
});

describe("parseAcartia", () => {
  it("reads a row, treating `created` as UTC", () => {
    const [s] = parseAcartia([row()]);
    expect(s).toEqual({
      id: "3b10bea3",
      t: Date.UTC(2026, 8, 25, 0, 27) / 1000,
      species: "Orca",
      label: "Orca",
      count: 1,
      lat: 47.29642,
      lon: -122.72165,
      verified: true,
      comments: "[Orca Network] Biggs T65A5 milling",
      photoUrl: null,
    });
  });

  it("accepts coordinates sent as strings", () => {
    const [s] = parseAcartia([row({ latitude: "48.03111", longitude: "-122.27993" })]);
    expect([s.lat, s.lon]).toEqual([48.03111, -122.27993]);
  });

  it("drops rows without a position or time, and rows outside the PNW", () => {
    const rows = [
      row({ entry_id: "a", latitude: "" }),
      row({ entry_id: "b", created: "yesterday" }),
      row({ entry_id: "c", latitude: 36.79, longitude: -121.9 }), // Monterey
      row({ entry_id: "d" }),
    ];
    expect(parseAcartia(rows).map((s) => s.id)).toEqual(["d"]);
  });

  it("returns newest first, with unknown counts and unverified reports", () => {
    const out = parseAcartia([
      row({ entry_id: "old", created: "2026-09-25 00:00:00" }),
      row({ entry_id: "new", created: "2026-09-30 18:50:00", no_sighted: 0, trusted: 0, type: "" }),
    ]);
    expect(out.map((s) => s.id)).toEqual(["new", "old"]);
    expect(out[0]).toMatchObject({ count: null, verified: false, label: "Unspecified", species: "Other" });
  });
});

describe("mergeSightings", () => {
  const s = (id: string, daysAgo: number, label = "Orca"): WhaleSighting => ({
    id,
    t: 1_800_000_000 - daysAgo * 86400,
    species: "Orca",
    label,
    count: null,
    lat: 48,
    lon: -123,
    verified: false,
    comments: "",
    photoUrl: null,
  });

  it("keeps saved reports the live feed has dropped, up to 30 days", () => {
    const merged = mergeSightings([s("a", 10), s("b", 31)], [s("c", 1)], 1_800_000_000);
    expect(merged.map((x) => x.id)).toEqual(["c", "a"]);
  });

  it("lets a fresh copy of a report replace the saved one", () => {
    const merged = mergeSightings([s("a", 2, "Orca")], [s("a", 2, "Orca (Biggs)")], 1_800_000_000);
    expect(merged).toHaveLength(1);
    expect(merged[0].label).toBe("Orca (Biggs)");
  });
});
