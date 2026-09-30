// Daily sighting log published by Western Prince (orcawhalewatch.com), one of
// the whale-watch operators in lib/whaleWatch.ts. The page is a set of
// "Supsystic" WordPress tables, one per season: a row per species, a column
// per day from Mar 23 to Oct 31, and the value lives in the cell's background
// class (navy = seen, gray = no tours, white = toured without a sighting).
//
// Fetched on demand, kept in memory for CACHE_MS, and saved (to Supabase, or
// data/sightings/ in local dev) so the app still has the last good copy if
// the page is down or a past season is taken off it.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SIGHTINGS_URL = "https://orcawhalewatch.com/whale-watching-season/";
export const SIGHTINGS_OPERATOR_ID = "western-prince";

const SNAPSHOT = join(process.cwd(), "..", "data", "sightings", "western-prince.json");
const CACHE_MS = 6 * 60 * 60 * 1000;

const SEEN_BG = "1c4587";
// Every gray the page has used for "no tours"; white or no class means a tour ran.
const NO_TOUR_BG = new Set(["cccccc", "d9d9d9", "efefef", "f3f3f3", "b7b7b7", "999999"]);

const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

export type SightingDay = { date: string; toured: boolean; seen: string[] };

export type SightingSeason = {
  year: number;
  species: string[];
  // Only days up to the last one the operator has filled in; later days are
  // still blank on the page and would read as "toured, nothing seen".
  days: SightingDay[];
  reportedThrough: string | null;
};

export type SightingLog = {
  operatorId: string;
  source: string;
  fetchedAt: string;
  stale: boolean; // true when served from the snapshot because the fetch failed
  seasons: SightingSeason[];
};

type Cell = { x: number; y: number; bg: string | null; value: string; colspan: number };

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

function parseCells(table: string): Cell[] {
  const cells: Cell[] = [];
  for (const m of table.matchAll(/<t[dh]\b([^>]*)>/g)) {
    const tag = m[1];
    const x = attr(tag, "data-x");
    const y = attr(tag, "data-y");
    if (x == null || y == null) continue;
    cells.push({
      x: Number(x),
      y: Number(y),
      bg: (attr(tag, "class") ?? "").match(/\bbg-([0-9a-f]{6})\b/)?.[1] ?? null,
      value: (attr(tag, "data-original-value") ?? "").trim(),
      colspan: Number(attr(tag, "data-colspan") ?? 1),
    });
  }
  return cells;
}

function parseSeason(year: number, table: string): SightingSeason | null {
  const cells = parseCells(table);
  const rowOf = (label: string) => cells.find((c) => c.x === 0 && c.value.toLowerCase() === label)?.y;
  const monthRow = rowOf("month");
  const dayRow = rowOf("day");
  if (monthRow == null || dayRow == null) return null;

  // Column -> ISO date, from the merged month headers and the day numbers.
  const monthOfCol = new Map<number, number>();
  for (const c of cells.filter((c) => c.y === monthRow && c.x > 0)) {
    const mi = MONTHS.indexOf(c.value.toUpperCase());
    if (mi >= 0) for (let x = c.x; x < c.x + c.colspan; x++) monthOfCol.set(x, mi);
  }
  const dateOfCol = new Map<number, string>();
  for (const c of cells.filter((c) => c.y === dayRow && c.x > 0)) {
    const mi = monthOfCol.get(c.x);
    const d = Number(c.value);
    if (mi == null || !d) continue;
    dateOfCol.set(c.x, `${year}-${String(mi + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }

  const speciesRows = cells
    .filter((c) => c.x === 0 && c.y > dayRow && c.value)
    .map((c) => ({ y: c.y, name: c.value.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()) }));

  const bgAt = new Map(cells.map((c) => [`${c.x},${c.y}`, c.bg]));
  const days: SightingDay[] = [];
  let lastReported = -1;
  for (const [x, date] of [...dateOfCol].sort((a, b) => a[0] - b[0])) {
    const col = speciesRows.map((s) => ({ s, bg: bgAt.get(`${x},${s.y}`) ?? null }));
    const seen = col.filter((c) => c.bg === SEEN_BG).map((c) => c.s.name);
    const noTour = col.some((c) => c.bg != null && NO_TOUR_BG.has(c.bg));
    if (seen.length || noTour) lastReported = days.length;
    days.push({ date, toured: !noTour, seen });
  }

  const reported = days.slice(0, lastReported + 1);
  return { year, species: speciesRows.map((s) => s.name), days: reported, reportedThrough: reported.at(-1)?.date ?? null };
}

export function parseSightingsPage(html: string): SightingSeason[] {
  const seasons: SightingSeason[] = [];
  for (const m of html.matchAll(/<table\b[^>]*class="[^"]*supsystic-table[^"]*"[^>]*>/g)) {
    const year = Number(attr(m[0], "data-title")?.match(/(\d{4})\s+Sightings/i)?.[1]);
    if (!year) continue;
    const end = html.indexOf("</table>", m.index);
    const season = parseSeason(year, html.slice(m.index, end));
    if (season?.days.length) seasons.push(season);
  }
  return seasons.sort((a, b) => b.year - a.year);
}

// The last good copy lives in Supabase (db/migrations/*_sighting_logs.sql)
// when it's configured: Cloud Run containers have no durable disk. Without
// Supabase (local dev) it is a file under data/sightings/.
const supabase = () =>
  process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
    ? { url: `${process.env.SUPABASE_URL}/rest/v1/sighting_logs`, key: process.env.SUPABASE_SECRET_KEY }
    : null;

async function saveSnapshot(log: SightingLog): Promise<void> {
  const db = supabase();
  if (!db) {
    await mkdir(join(SNAPSHOT, ".."), { recursive: true });
    await writeFile(SNAPSHOT, JSON.stringify(log));
    return;
  }
  const res = await fetch(`${db.url}?on_conflict=operator_id`, {
    method: "POST",
    headers: { apikey: db.key, "content-type": "application/json", prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ operator_id: log.operatorId, source: log.source, fetched_at: log.fetchedAt, seasons: log.seasons }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function readSnapshot(): Promise<SightingLog> {
  const db = supabase();
  if (!db) return JSON.parse(await readFile(SNAPSHOT, "utf8"));
  const res = await fetch(`${db.url}?operator_id=eq.${SIGHTINGS_OPERATOR_ID}&select=*`, { headers: { apikey: db.key }, cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const [row] = await res.json();
  if (!row) throw new Error("no saved sighting log");
  return { operatorId: row.operator_id, source: row.source, fetchedAt: row.fetched_at, stale: true, seasons: row.seasons };
}

let cached: { at: number; log: SightingLog } | null = null;

export async function loadSightings(): Promise<SightingLog> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.log;
  try {
    const res = await fetch(SIGHTINGS_URL, { headers: { "user-agent": "whaleboat/0.1 (sighting log reader)" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const seasons = parseSightingsPage(await res.text());
    if (!seasons.length) throw new Error("no sighting tables found; the page layout may have changed");
    const log: SightingLog = {
      operatorId: SIGHTINGS_OPERATOR_ID,
      source: SIGHTINGS_URL,
      fetchedAt: new Date().toISOString(),
      stale: false,
      seasons,
    };
    // Best effort: a failed save must not fail a good fetch.
    await saveSnapshot(log).catch((err) => console.warn(`sightings: snapshot not saved (${String(err)})`));
    cached = { at: Date.now(), log };
    return log;
  } catch (err) {
    console.warn(`sightings: fetch failed (${String(err)}); using snapshot`);
    const log: SightingLog = { ...(await readSnapshot()), stale: true };
    // Retry the live page after a short pause rather than on every request.
    cached = { at: Date.now() - CACHE_MS + 10 * 60 * 1000, log };
    return log;
  }
}
