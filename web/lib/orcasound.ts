// Whale calls heard on Orcasound's hydrophones (live.orcasound.net). We use
// its "bouts": listening episodes its experts have reviewed and named, e.g.
// "J pod SB (Andrews Bay)". The raw detections are mostly boat noise, and the
// OrcaHello AI detections its reviewers confirm end up in bouts too.
//
// The API is open (no key) and keeps its history, so nothing is saved here:
// fetched on demand and kept in memory for CACHE_MS.

import type { Species } from "./acartia";

export const ORCASOUND_SITE = "https://live.orcasound.net";
const API = `${ORCASOUND_SITE}/api/json`;
const CACHE_MS = 10 * 60 * 1000;
const MAX_DAYS = 30;
const PAGE = 250; // the bouts endpoint's maximum
const MAX_PAGES = 4;

export type Hydrophone = { id: string; name: string; lat: number; lon: number; url: string };

export type Ecotype = "Southern Resident" | "Bigg's";

export type Bout = {
  id: string;
  hydrophoneId: string;
  start: number; // unix seconds
  end: number;
  name: string; // as named by Orcasound, e.g. "Bigg's calls (Andrews Bay)"
  species: Species;
  ecotype: Ecotype | null;
  url: string; // the bout's page, with the recording
};

export type Acoustic = {
  source: string;
  fetchedAt: string;
  stale: boolean; // true when the live fetch failed and this is the last good copy
  hydrophones: Hydrophone[];
  bouts: Bout[]; // newest first
};

// Bout names are free text written by Orcasound's reviewers.
export function classifyBout(name: string): { species: Species; ecotype: Ecotype | null } {
  if (/\bbigg'?s\b|transient|\bT\d{2,3}/i.test(name)) return { species: "Orca", ecotype: "Bigg's" };
  if (/\b[JKL][ -]?pod\b|\b[JKL]\d{2,3}\b|srkw|southern resident/i.test(name)) return { species: "Orca", ecotype: "Southern Resident" };
  if (/orca|killer|\bKW/i.test(name)) return { species: "Orca", ecotype: null };
  if (/humpback/i.test(name)) return { species: "Humpback", ecotype: null };
  if (/gr[ae]y whale/i.test(name)) return { species: "Gray whale", ecotype: null };
  return { species: "Other", ecotype: null };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseFeeds(body: any): Hydrophone[] {
  const out: Hydrophone[] = [];
  for (const f of body?.data ?? []) {
    const a = f?.attributes ?? {};
    const lat = Number(a.lat_lng?.lat);
    const lon = Number(a.lat_lng?.lng);
    // Hidden feeds are retired or off-site (one is on a ship in Norway).
    if (!a.visible || !Number.isFinite(lat) || !Number.isFinite(lon) || !f.id) continue;
    out.push({ id: f.id, name: String(a.name ?? a.slug ?? f.id), lat, lon, url: `${ORCASOUND_SITE}/listen/${a.slug}` });
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseBouts(rows: any[], hydrophoneIds: Set<string>): Bout[] {
  const out: Bout[] = [];
  for (const r of rows) {
    const a = r?.attributes ?? {};
    const start = Date.parse(a.start_time) / 1000;
    const end = Date.parse(a.end_time) / 1000;
    const feed = a.feed_id ?? r?.relationships?.feed?.data?.id;
    // Biophony is animal sound; anthrophony (boats) and geophony are not whales.
    if (a.category !== "biophony" || !r.id || !hydrophoneIds.has(feed) || !Number.isFinite(start)) continue;
    const name = String(a.name ?? "").trim() || "Whale calls";
    out.push({
      id: r.id,
      hydrophoneId: feed,
      start,
      end: Number.isFinite(end) ? end : start,
      name,
      ...classifyBout(name),
      url: `${ORCASOUND_SITE}/bouts/${r.id}`,
    });
  }
  return out.sort((x, y) => y.start - x.start);
}

async function getJson(url: string) {
  const res = await fetch(url, { headers: { "user-agent": "whaleboat/0.1 (whale map)" }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

let cached: { at: number; data: Acoustic } | null = null;

export async function loadAcoustic(): Promise<Acoustic> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  try {
    const hydrophones = parseFeeds(await getJson(`${API}/feeds`));
    if (!hydrophones.length) throw new Error("no hydrophones listed");
    const since = new Date(Date.now() - MAX_DAYS * 86400_000).toISOString();
    let url: string | null = `${API}/bouts?filter[start_time][greater_than_or_equal]=${since}&page[limit]=${PAGE}&sort=-start_time`;
    const rows = [];
    for (let i = 0; url && i < MAX_PAGES; i++) {
      const body = await getJson(url);
      rows.push(...(body.data ?? []));
      url = body.links?.next ?? null;
    }
    const data: Acoustic = {
      source: ORCASOUND_SITE,
      fetchedAt: new Date().toISOString(),
      stale: false,
      hydrophones,
      bouts: parseBouts(rows, new Set(hydrophones.map((h) => h.id))),
    };
    cached = { at: Date.now(), data };
    return data;
  } catch (err) {
    console.warn(`orcasound: fetch failed (${String(err)})`);
    if (!cached) throw err;
    // Serve the last good copy and retry the live API after a short pause.
    cached = { at: Date.now() - CACHE_MS + 2 * 60 * 1000, data: { ...cached.data, stale: true } };
    return cached.data;
  }
}
