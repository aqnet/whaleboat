// Whale sightings from Acartia (acartia.io), the open data cooperative that
// pools Orca Network, Whale Alert / Spotter and other community reports for
// the Salish Sea and coastal Cascadia. Its public feed needs no key but only
// covers about the last 7 days, so every fetch is also saved (to Supabase, or
// data/acartia/ in local dev) and the app serves up to 30 days from that copy.
//
// Fetched on demand and kept in memory for CACHE_MS, like lib/sightings.ts.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serverEnv } from "./serverEnv";

export const ACARTIA_URL = "https://acartia.io/api/v1/sightings/current";
export const ACARTIA_SITE = "https://acartia.io";

const SNAPSHOT = join(process.cwd(), "..", "data", "acartia", "sightings.json");
const CACHE_MS = 10 * 60 * 1000;
export const MAX_DAYS = 30;

// Salish Sea, the Washington and Oregon coast and southern BC. The feed has
// the odd report from California or Alaska that would only pull the map away.
const BOUNDS = { south: 45.5, north: 51, west: -128, east: -121.5 };

export type Species = "Orca" | "Humpback" | "Gray whale" | "Other";
export const SPECIES: Species[] = ["Orca", "Humpback", "Gray whale", "Other"];

export type WhaleSighting = {
  id: string;
  t: number; // unix seconds
  species: Species;
  label: string; // as reported, e.g. "Minke Whale"
  count: number | null;
  lat: number;
  lon: number;
  verified: boolean; // Acartia's `trusted`: vetted by Orca Network
  comments: string;
  photoUrl: string | null;
};

export type WhaleSightings = {
  source: string;
  fetchedAt: string;
  stale: boolean; // true when the live feed failed and this is the saved copy
  sightings: WhaleSighting[]; // newest first
};

export function speciesOf(type: string): Species {
  const t = type.toLowerCase();
  if (/orca|killer/.test(t)) return "Orca";
  if (/humpback/.test(t)) return "Humpback";
  if (/gr[ae]y/.test(t)) return "Gray whale";
  return "Other";
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

// `created` is "YYYY-MM-DD HH:MM:SS" in UTC (it trails `ssemmi_date_added`,
// which carries an explicit GMT offset, by a few minutes).
function parseCreated(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(ms) ? null : ms / 1000;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseAcartia(rows: any[]): WhaleSighting[] {
  const out: WhaleSighting[] = [];
  for (const r of rows) {
    const lat = num(r?.latitude);
    const lon = num(r?.longitude);
    const t = parseCreated(r?.created);
    const id = r?.entry_id ?? r?.ssemmi_id;
    if (lat == null || lon == null || t == null || !id) continue;
    if (lat < BOUNDS.south || lat > BOUNDS.north || lon < BOUNDS.west || lon > BOUNDS.east) continue;
    const label = typeof r.type === "string" && r.type.trim() ? r.type.trim() : "Unspecified";
    const count = num(r.no_sighted);
    out.push({
      id: String(id),
      t,
      species: speciesOf(label),
      label,
      count: count && count > 0 ? count : null,
      lat,
      lon,
      verified: r.trusted === 1 || r.trusted === true,
      comments: typeof r.data_source_comments === "string" ? r.data_source_comments.trim() : "",
      photoUrl: typeof r.photo_url === "string" && /^https:\/\//.test(r.photo_url) ? r.photo_url : null,
    });
  }
  return out.sort((a, b) => b.t - a.t);
}

// Newer copies of a sighting replace older ones; anything past MAX_DAYS goes.
export function mergeSightings(saved: WhaleSighting[], fresh: WhaleSighting[], now = Date.now() / 1000): WhaleSighting[] {
  const byId = new Map(saved.map((s) => [s.id, s]));
  for (const s of fresh) byId.set(s.id, s);
  const cutoff = now - MAX_DAYS * 86400;
  return [...byId.values()].filter((s) => s.t >= cutoff).sort((a, b) => b.t - a.t);
}

// --- Saved copy -------------------------------------------------------------
// Supabase (db/migrations/*_whale_sightings.sql) when configured: Cloud Run
// has no durable disk. Otherwise a file under data/acartia/.

const supabase = () => {
  const url = serverEnv("SUPABASE_URL");
  const key = serverEnv("SUPABASE_SECRET_KEY");
  return url && key ? { url: `${url}/rest/v1/whale_sightings`, key } : null;
};

const toRow = (s: WhaleSighting) => ({
  id: s.id,
  source: "acartia",
  seen_at: new Date(s.t * 1000).toISOString(),
  species: s.species,
  label: s.label,
  count: s.count,
  lat: s.lat,
  lon: s.lon,
  verified: s.verified,
  comments: s.comments,
  photo_url: s.photoUrl,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fromRow = (r: any): WhaleSighting => ({
  id: r.id,
  t: Date.parse(r.seen_at) / 1000,
  species: r.species,
  label: r.label,
  count: r.count,
  lat: r.lat,
  lon: r.lon,
  verified: r.verified,
  comments: r.comments,
  photoUrl: r.photo_url,
});

async function readSaved(): Promise<WhaleSighting[]> {
  const db = supabase();
  if (!db) {
    try {
      return JSON.parse(await readFile(SNAPSHOT, "utf8"));
    } catch {
      return [];
    }
  }
  const since = new Date(Date.now() - MAX_DAYS * 86400_000).toISOString();
  const res = await fetch(`${db.url}?source=eq.acartia&seen_at=gte.${since}&order=seen_at.desc&select=*`, {
    headers: { apikey: db.key },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).map(fromRow);
}

async function save(fresh: WhaleSighting[], merged: WhaleSighting[]): Promise<void> {
  const db = supabase();
  if (!db) {
    await mkdir(join(SNAPSHOT, ".."), { recursive: true });
    await writeFile(SNAPSHOT, JSON.stringify(merged));
    return;
  }
  if (!fresh.length) return;
  const res = await fetch(`${db.url}?on_conflict=id`, {
    method: "POST",
    headers: { apikey: db.key, "content-type": "application/json", prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(fresh.map(toRow)),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
}

let cached: { at: number; data: WhaleSightings } | null = null;

export async function loadWhaleSightings(): Promise<WhaleSightings> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  const saved = await readSaved().catch((err) => {
    console.warn(`acartia: saved copy unavailable (${String(err)})`);
    return [] as WhaleSighting[];
  });
  try {
    const res = await fetch(ACARTIA_URL, { headers: { "user-agent": "whaleboat/0.1 (sightings map)" }, cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error("unexpected response shape");
    const fresh = parseAcartia(body);
    const merged = mergeSightings(saved, fresh);
    // Best effort: a failed save must not fail a good fetch.
    await save(fresh, merged).catch((err) => console.warn(`acartia: not saved (${String(err)})`));
    const data: WhaleSightings = { source: ACARTIA_SITE, fetchedAt: new Date().toISOString(), stale: false, sightings: merged };
    cached = { at: Date.now(), data };
    return data;
  } catch (err) {
    console.warn(`acartia: fetch failed (${String(err)}); using saved copy`);
    if (!saved.length) throw err;
    const data: WhaleSightings = { source: ACARTIA_SITE, fetchedAt: new Date().toISOString(), stale: true, sightings: mergeSightings(saved, []) };
    // Retry the live feed after a short pause rather than on every request.
    cached = { at: Date.now() - CACHE_MS + 2 * 60 * 1000, data };
    return data;
  }
}
