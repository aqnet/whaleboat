// Turns raw AISStream sample files (data/samples/*.jsonl, written by
// scripts/ais-sample.ts) into per-vessel tracks for the map prototype.
// Mirrors the spec's rules where they matter for drawing: implausible jumps
// are dropped (§7.1) and a gap over 10 min starts a new segment (§8.2).

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { serverEnv } from "./serverEnv";
import { matchWhaleWatch, type WhaleWatchMatch } from "./whaleWatch";

export const SAMPLES_DIR = join(process.cwd(), "..", "data", "samples");

const MAX_GAP_S = 10 * 60;
const MAX_IMPLIED_KN = 45;
const MOVING_KN = 2;

export type Fix = { t: number; lon: number; lat: number; sog: number | null; cog: number | null };

export type Segment = { path: [number, number][]; timestamps: number[] };

export type VesselTrack = {
  mmsi: number;
  name: string;
  cls: "A" | "B" | "?";
  shipType: number | null;
  lengthM: number | null;
  fixes: Fix[];
  segments: Segment[];
  maxSog: number;
  distanceNm: number;
  moving: boolean;
  whaleWatch: WhaleWatchMatch | null;
};

export type SampleSummary = {
  file: string; // the one file, or WINDOW_ID for the merged window
  source: "supabase" | "files";
  files: string[]; // every sample file that contributed (empty when read from Supabase)
  windowStart: number | null; // epoch s; fixes before this were dropped
  messages: number;
  positionReports: number;
  start: number | null;
  end: number | null;
  vessels: VesselTrack[];
};

export type SampleFile = { file: string; bytes: number; modified: number };

export async function listSamples(): Promise<SampleFile[]> {
  let names: string[];
  try {
    names = await readdir(SAMPLES_DIR);
  } catch {
    return [];
  }
  const files = await Promise.all(
    names
      .filter((n) => n.endsWith(".jsonl"))
      .map(async (file) => {
        const s = await stat(join(SAMPLES_DIR, file));
        return { file, bytes: s.size, modified: s.mtimeMs };
      }),
  );
  return files.sort((a, b) => b.modified - a.modified);
}

// "2026-09-29 14:51:42.593229588 +0000 UTC" -> epoch seconds
function parseAisTime(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)?/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}${(m[3] ?? "").slice(0, 4)}Z`);
  return Number.isNaN(ms) ? null : ms / 1000;
}

function haversineNm(a: Fix, b: Fix): number {
  const R = 3440.065;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function dimLength(d: { A?: number; B?: number } | undefined): number | null {
  const len = (d?.A ?? 0) + (d?.B ?? 0);
  return len > 0 ? len : null;
}

const POSITION_TYPES = new Set(["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"]);

// The spec's default map window (§8.5): the last 48 h, ending now.
export const WINDOW_ID = "last-48h";
export const WINDOW_S = 48 * 60 * 60;

export async function loadSample(file: string): Promise<SampleSummary> {
  return loadTracks(file, [file], null);
}

// The last 48 h from Supabase when it's configured, else from every local
// sample with messages in the window. Local samples can overlap (two regions
// recorded at once); the duplicate fixes that produces are dropped like any
// other duplicate report.
export async function loadWindow(now = Date.now() / 1000): Promise<SampleSummary> {
  const since = now - WINDOW_S;
  if (supabaseConfigured()) {
    try {
      return await loadWindowFromSupabase(since);
    } catch (err) {
      console.warn(`tracks: Supabase read failed (${String(err)}); using local samples`);
    }
  }
  const files = (await listSamples()).filter((s) => s.modified / 1000 >= since).map((s) => s.file);
  return loadTracks(WINDOW_ID, files.reverse(), since);
}

type Acc = Omit<VesselTrack, "segments" | "maxSog" | "distanceNm" | "moving" | "whaleWatch">;

const supabaseConfigured = () => Boolean(serverEnv("SUPABASE_URL") && serverEnv("SUPABASE_SECRET_KEY"));

// db/migrations/*_ais_positions.sql: tracks_window() returns vessels
// plus fixes as [mmsi, epoch_s, lon, lat, sog, cog].
async function loadWindowFromSupabase(since: number): Promise<SampleSummary> {
  const res = await fetch(`${serverEnv("SUPABASE_URL")}/rest/v1/rpc/tracks_window`, {
    method: "POST",
    headers: { apikey: serverEnv("SUPABASE_SECRET_KEY")!, "content-type": "application/json" },
    body: JSON.stringify({ since: new Date(since * 1000).toISOString() }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body: {
    vessels: { mmsi: number; name: string | null; cls: "A" | "B" | null; shipType: number | null; lengthM: number | null }[];
    fixes: [number, number, number, number, number | null, number | null][];
  } = await res.json();

  const acc = new Map<number, Acc>();
  for (const v of body.vessels) {
    acc.set(v.mmsi, { mmsi: v.mmsi, name: v.name ?? "", cls: v.cls ?? "?", shipType: v.shipType, lengthM: v.lengthM, fixes: [] });
  }
  for (const [mmsi, t, lon, lat, sog, cog] of body.fixes) {
    let v = acc.get(mmsi);
    if (!v) acc.set(mmsi, (v = { mmsi, name: "", cls: "?", shipType: null, lengthM: null, fixes: [] }));
    v.fixes.push({ t, lon, lat, sog, cog });
  }
  return buildSummary({ id: WINDOW_ID, source: "supabase", files: [], since, acc, messages: body.fixes.length, positionReports: body.fixes.length });
}

async function loadTracks(id: string, files: string[], since: number | null): Promise<SampleSummary> {
  const acc = new Map<number, Acc>();
  let messages = 0;
  let positionReports = 0;

  const get = (mmsi: number): Acc => {
    let v = acc.get(mmsi);
    if (!v) acc.set(mmsi, (v = { mmsi, name: "", cls: "?", shipType: null, lengthM: null, fixes: [] }));
    return v;
  };

  const texts = await Promise.all(files.map((f) => readFile(join(SAMPLES_DIR, f), "utf8")));
  for (const line of texts.join("\n").split("\n")) {
    if (!line) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw AISStream JSON; fields are checked where used
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // the in-progress file can end mid-line
    }
    const type: string = msg.MessageType;
    const meta = msg.MetaData;
    if (!meta?.MMSI) continue;
    messages++;
    const v = get(meta.MMSI);
    const metaName = typeof meta.ShipName === "string" ? meta.ShipName.trim() : "";
    if (metaName && !v.name) v.name = metaName;
    const body = msg.Message?.[type] ?? {};

    if (POSITION_TYPES.has(type)) {
      positionReports++;
      v.cls = type === "PositionReport" ? "A" : "B";
      const t = parseAisTime(meta.time_utc) ?? Date.parse(msg.received_at) / 1000;
      if (typeof meta.latitude !== "number" || typeof meta.longitude !== "number") continue;
      v.fixes.push({
        t,
        lon: meta.longitude,
        lat: meta.latitude,
        sog: typeof body.Sog === "number" && body.Sog < 102.3 ? body.Sog : null,
        cog: typeof body.Cog === "number" && body.Cog < 360 ? body.Cog : null,
      });
      if (type === "ExtendedClassBPositionReport") {
        v.shipType ??= body.Type ?? null;
        v.lengthM ??= dimLength(body.Dimension);
      }
    } else if (type === "ShipStaticData") {
      if (v.cls === "?") v.cls = "A";
      v.name = (body.Name ?? "").trim() || v.name;
      v.shipType = body.Type ?? v.shipType;
      v.lengthM = dimLength(body.Dimension) ?? v.lengthM;
    } else if (type === "StaticDataReport") {
      if (v.cls === "?") v.cls = "B";
      if (body.ReportA?.Valid) v.name = (body.ReportA.Name ?? "").trim() || v.name;
      if (body.ReportB?.Valid) {
        v.shipType = body.ReportB.ShipType || v.shipType;
        v.lengthM = dimLength(body.ReportB.Dimension) ?? v.lengthM;
      }
    }
  }

  return buildSummary({ id, source: "files", files, since, acc, messages, positionReports });
}

// Cleans each vessel's fixes (window, duplicates, implausible jumps) and
// splits them into drawable segments.
function buildSummary(o: {
  id: string;
  source: SampleSummary["source"];
  files: string[];
  since: number | null;
  acc: Map<number, Acc>;
  messages: number;
  positionReports: number;
}): SampleSummary {
  const { id, source, files, since, acc, messages, positionReports } = o;
  let start: number | null = null;
  let end: number | null = null;
  const vessels: VesselTrack[] = [];

  for (const v of acc.values()) {
    const sorted = v.fixes.filter((f) => since == null || f.t >= since).sort((a, b) => a.t - b.t);
    const fixes: Fix[] = [];
    for (const f of sorted) {
      const prev = fixes.at(-1);
      if (prev && f.t - prev.t < 1) continue; // duplicate report
      if (prev && f.t - prev.t <= MAX_GAP_S && haversineNm(prev, f) / ((f.t - prev.t) / 3600) > MAX_IMPLIED_KN) continue;
      fixes.push(f);
    }

    const segments: Segment[] = [];
    let distanceNm = 0;
    let maxSog = 0;
    for (let i = 0; i < fixes.length; i++) {
      const f = fixes[i];
      const prev = fixes[i - 1];
      if (!prev || f.t - prev.t > MAX_GAP_S) segments.push({ path: [], timestamps: [] });
      else distanceNm += haversineNm(prev, f);
      const seg = segments.at(-1)!;
      seg.path.push([f.lon, f.lat]);
      seg.timestamps.push(f.t);
      if (f.sog != null) maxSog = Math.max(maxSog, f.sog);
    }

    if (fixes.length) {
      start = Math.min(start ?? Infinity, fixes[0].t);
      end = Math.max(end ?? -Infinity, fixes.at(-1)!.t);
    }

    vessels.push({
      ...v,
      fixes,
      segments: segments.filter((s) => s.path.length > 1),
      maxSog,
      distanceNm,
      moving: maxSog >= MOVING_KN || distanceNm > 0.25,
      whaleWatch: matchWhaleWatch(v.mmsi, v.name, v.shipType),
    });
  }

  vessels.sort((a, b) => Number(b.moving) - Number(a.moving) || b.distanceNm - a.distanceNm || b.fixes.length - a.fixes.length);
  return { file: id, source, files, windowStart: since, messages, positionReports, start, end, vessels: vessels.filter((v) => v.fixes.length || since == null) };
}
