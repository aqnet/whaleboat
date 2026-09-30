import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OPERATORS, matchWhaleWatch, normalizeName } from "./whaleWatch";

const allVessels = OPERATORS.flatMap((o) => o.vessels.map((v) => ({ operator: o, vessel: v })));
const allMmsis = allVessels.flatMap(({ vessel }) => vessel.mmsis ?? []);

describe("normalizeName", () => {
  it("uppercases, collapses punctuation and whitespace", () => {
    expect(normalizeName("  Salish   Sea-Eclipse ")).toBe("SALISH SEA ECLIPSE");
  });

  it("drops an M/V or F/V prefix", () => {
    expect(normalizeName("M/V Glacier Spirit")).toBe("GLACIER SPIRIT");
    expect(normalizeName("F/V Kestrel")).toBe("KESTREL");
  });

  it("turns a trailing roman numeral into digits, and only a trailing one", () => {
    expect(normalizeName("Blackfish VI")).toBe("BLACKFISH 6");
    expect(normalizeName("BLACKFISH 6")).toBe("BLACKFISH 6");
    expect(normalizeName("Spirit of Orca II")).toBe("SPIRIT OF ORCA 2");
    expect(normalizeName("V Class")).toBe("V CLASS");
  });

  it("leaves a single-word name that happens to be a numeral alone", () => {
    expect(normalizeName("X")).toBe("X");
  });
});

describe("matchWhaleWatch", () => {
  it("matches by MMSI whatever the name and type, and marks it confirmed", () => {
    // WAKE broadcasts as a pleasure craft (37); the MMSI pin still confirms it.
    expect(matchWhaleWatch(368400660, "WAKE", 37)).toMatchObject({ operator: "Blue Kingdom", vessel: "Wake", by: "mmsi", confirmed: true });
    expect(matchWhaleWatch(368643000, "", null)).toMatchObject({ vessel: "Rosario", by: "mmsi", confirmed: true });
  });

  it("does not match a pinned boat's name on a different MMSI", () => {
    expect(matchWhaleWatch(111111111, "OSPREY", 37)).toBeNull();
    expect(matchWhaleWatch(111111111, "EMERALD CLIPPER", 60)).toBeNull();
  });

  it("matches an unpinned, distinctive name as confirmed", () => {
    expect(matchWhaleWatch(222222222, "BLACKFISH 3", null)).toMatchObject({ vessel: "Blackfish III", by: "name", confirmed: true });
  });

  it("confirms an unpinned generic name only with a passenger ship type", () => {
    expect(matchWhaleWatch(333333333, "GALIANO", 37)).toMatchObject({ vessel: "Galiano", confirmed: false });
    expect(matchWhaleWatch(333333333, "GALIANO", null)).toMatchObject({ confirmed: false });
    expect(matchWhaleWatch(333333333, "GALIANO", 60)).toMatchObject({ confirmed: true });
    expect(matchWhaleWatch(333333333, "GALIANO", 69)).toMatchObject({ confirmed: true });
    expect(matchWhaleWatch(333333333, "GALIANO", 70)).toMatchObject({ confirmed: false });
  });

  it("returns null for unknown boats and empty names", () => {
    expect(matchWhaleWatch(444444444, "NOT A TOUR BOAT", 60)).toBeNull();
    expect(matchWhaleWatch(444444444, "", 60)).toBeNull();
  });
});

describe("registry integrity", () => {
  it("has unique operator ids", () => {
    const ids = OPERATORS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has 9-digit, unique MMSIs", () => {
    for (const m of allMmsis) expect(String(m)).toMatch(/^\d{9}$/);
    expect(new Set(allMmsis).size).toBe(allMmsis.length);
  });

  it("has no two boats whose names normalize to the same thing", () => {
    // A collision would make one of them unreachable by name.
    const seen = new Map<string, string>();
    for (const { operator, vessel } of allVessels) {
      const key = normalizeName(vessel.name);
      expect(seen.get(key), `${vessel.name} (${operator.name}) collides`).toBeUndefined();
      seen.set(key, operator.name);
    }
  });

  it("matches every pinned MMSI back to its own boat", () => {
    for (const { operator, vessel } of allVessels) {
      for (const m of vessel.mmsis ?? []) {
        expect(matchWhaleWatch(m, "", null)).toMatchObject({ operatorId: operator.id, vessel: vessel.name });
      }
    }
  });

  it("agrees with the whale_watch_vessels table seeded in db/migrations", () => {
    // That table gives these boats 30-day retention and exempts them from the
    // vessel-type filter; a boat missing from it silently loses history.
    const dir = join(__dirname, "..", "..", "db", "migrations");
    const seeded = new Set<number>();
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
      const sql = readFileSync(join(dir, f), "utf8");
      const insert = sql.match(/insert into public\.whale_watch_vessels[\s\S]*?;/i)?.[0];
      if (!insert) continue;
      for (const m of insert.matchAll(/\(\s*(\d{9})\s*,/g)) seeded.add(Number(m[1]));
    }
    expect([...seeded].sort()).toEqual([...allMmsis].sort());
  });
});
