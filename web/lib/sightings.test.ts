import { describe, expect, it } from "vitest";
import { parseSightingsPage } from "./sightings";

// A miniature of the Supsystic tables on orcawhalewatch.com: row 1 is the
// season title, row 2 the merged month headers, row 3 the day numbers, then
// one row per species. The value lives in each cell's background class.
const SEEN = "1c4587";
const NO_TOUR = "d9d9d9";
const TOURED = "ffffff";

type Cell = string | null; // background colour, or null for no class

function cell(x: number, y: number, value: string, bg: Cell, extra = "") {
  const cls = `${bg ? `bg-${bg} ` : ""}fsize-11 ffamily-Arial`;
  return `<td data-cell-id="c${x}_${y}" data-x="${x}" data-y="${y}" class="${cls}" data-original-value="${value}"${extra}></td>`;
}

function table(opts: { id: number; title: string; months: [string, number[]][]; species: [string, Cell[]][] }) {
  const days = opts.months.flatMap(([, ds]) => ds);
  const rows: string[] = [];
  rows.push(`<tr>${cell(0, 1, opts.title.replace("Sightings", "Season"), "666666")}</tr>`);
  let x = 1;
  const monthCells = [cell(0, 2, "Month", null)];
  for (const [name, ds] of opts.months) {
    monthCells.push(cell(x, 2, name, "c9daf8", ` data-colspan="${ds.length}"`));
    x += ds.length;
  }
  rows.push(`<tr>${monthCells.join("")}</tr>`);
  rows.push(`<tr>${[cell(0, 3, "Day", null), ...days.map((d, i) => cell(i + 1, 3, String(d), "c9daf8"))].join("")}</tr>`);
  opts.species.forEach(([name, colours], i) => {
    const y = 4 + i;
    rows.push(`<tr>${[cell(0, y, name, null), ...colours.map((bg, j) => cell(j + 1, y, "", bg))].join("")}</tr>`);
  });
  return `<table id="supsystic-table-${opts.id}" class="supsystic-table compact border" data-id="${opts.id}" data-title="${opts.title}"><tbody>${rows.join("")}</tbody></table>`;
}

const page = (...tables: string[]) => `<html><body><p>intro</p>${tables.join("<p>between</p>")}</body></html>`;

describe("parseSightingsPage", () => {
  const season2025 = table({
    id: 7,
    title: "2025 Sightings",
    months: [
      ["MARCH", [30, 31]],
      ["APRIL", [1, 2, 3]],
    ],
    species: [
      //          Mar 30  Mar 31   Apr 1    Apr 2    Apr 3
      ["ORCA", [SEEN, NO_TOUR, TOURED, SEEN, TOURED]],
      ["HUMPBACK", [TOURED, NO_TOUR, SEEN, TOURED, TOURED]],
      ["SEA LION", [SEEN, NO_TOUR, null, TOURED, TOURED]],
    ],
  });

  it("maps columns to dates across a month boundary", () => {
    const [s] = parseSightingsPage(page(season2025));
    expect(s.year).toBe(2025);
    expect(s.days.map((d) => d.date)).toEqual(["2025-03-30", "2025-03-31", "2025-04-01", "2025-04-02"]);
  });

  it("reads seen, no-tour and toured-without-sighting days", () => {
    const [s] = parseSightingsPage(page(season2025));
    const byDate = Object.fromEntries(s.days.map((d) => [d.date, d]));
    expect(byDate["2025-03-30"]).toEqual({ date: "2025-03-30", toured: true, seen: ["Orca", "Sea Lion"] });
    expect(byDate["2025-03-31"]).toMatchObject({ toured: false, seen: [] });
    expect(byDate["2025-04-01"]).toMatchObject({ toured: true, seen: ["Humpback"] });
  });

  it("title-cases species names", () => {
    const [s] = parseSightingsPage(page(season2025));
    expect(s.species).toEqual(["Orca", "Humpback", "Sea Lion"]);
  });

  it("drops trailing days that haven't been filled in yet", () => {
    // Apr 3 is white in every row: not reported, rather than "toured, saw nothing".
    const [s] = parseSightingsPage(page(season2025));
    expect(s.days.at(-1)?.date).toBe("2025-04-02");
    expect(s.reportedThrough).toBe("2025-04-02");
  });

  it("returns seasons newest first and ignores tables that aren't sighting seasons", () => {
    const season2026 = table({
      id: 8,
      title: "2026 Sightings",
      months: [["MAY", [1, 2]]],
      species: [["ORCA", [SEEN, TOURED]]],
    });
    const other = table({ id: 9, title: "Price list", months: [["MAY", [1]]], species: [["ORCA", [SEEN]]] });
    const seasons = parseSightingsPage(page(season2025, other, season2026));
    expect(seasons.map((s) => s.year)).toEqual([2026, 2025]);
  });

  it("leaves out a season with nothing reported yet", () => {
    const empty = table({ id: 10, title: "2027 Sightings", months: [["MARCH", [23, 24]]], species: [["ORCA", [TOURED, TOURED]]] });
    expect(parseSightingsPage(page(empty))).toEqual([]);
  });

  it("returns nothing for a page without the tables", () => {
    expect(parseSightingsPage("<html><body>Maintenance</body></html>")).toEqual([]);
  });
});
