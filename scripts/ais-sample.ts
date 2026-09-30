// Sample AIS traffic from AISStream for a bounding box and summarize it.
//
//   node scripts/ais-sample.ts [--minutes 10] [--region puget-sound] [--rows 80] [--no-db]
//
// Reads AISSTREAM_API_KEY from .env.local. Writes every raw message to
// data/samples/ais-<region>-<timestamp>.jsonl and prints a per-vessel summary.
// With SUPABASE_URL and SUPABASE_SECRET_KEY set, positions and vessel details
// are also written to Supabase every few seconds
// (db/migrations/*_ais_positions.sql). --no-db skips Supabase for test runs.
// Box-wide on purpose: there is no registry yet, so this also shows which
// vessels would be registry candidates (spec §4.3).

import { mkdirSync, readFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";

type BBox = [[number, number], [number, number]]; // [[lat, lon] SW, [lat, lon] NE]

const REGIONS: Record<string, { name: string; bbox: BBox }> = {
  // Tacoma Narrows / Vashon Island north to Orcas and Lummi islands, from the
  // Seattle–Everett shoreline west to Orcas and the north end of Hood Canal:
  // central and south Sound, Admiralty Inlet, Whidbey/Camano, Skagit Bay,
  // Rosario Strait, Bellingham Bay and the eastern San Juans.
  "puget-sound": { name: "Puget Sound (Tacoma/Vashon – Orcas/Lummi)", bbox: [[47.22, -123.1], [48.78, -122.15]] },
  // Whidbey + Camano islands with the surrounding water: Saratoga Passage,
  // Port Susan, Skagit Bay, Possession Sound (west half), east Admiralty Inlet.
  "island-county": { name: "Island County (Whidbey + Camano)", bbox: [[47.88, -122.8], [48.42, -122.3]] },
  "camano": { name: "Camano Island (Saratoga Passage + Port Susan)", bbox: [[48.02, -122.6], [48.3, -122.32]] },
  "whaleboat-v1": { name: "Spec §3 primary box", bbox: [[47.5, -122.65], [48.3, -122.2]] },
  // Home waters of the web/lib/whaleWatch.ts fleets: Port Angeles and Port
  // Townsend, the San Juans out of Anacortes/Friday Harbor, down to Edmonds.
  "whale-watch": { name: "Whale-watch fleets (Port Angeles – San Juans – Edmonds)", bbox: [[47.75, -123.6], [48.8, -122.2]] },
};

const MESSAGE_TYPES = [
  "PositionReport",
  "StandardClassBPositionReport",
  "ExtendedClassBPositionReport",
  "ShipStaticData",
  "StaticDataReport",
];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function envVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\s]+)"?`));
      if (m) return m[1];
    }
  } catch {}
  return undefined;
}

function loadKey(): string {
  const key = envVar("AISSTREAM_API_KEY");
  if (key) return key;
  console.error("Missing AISSTREAM_API_KEY. Add it to .env.local (get one at https://aisstream.io/apikeys).");
  process.exit(1);
}

const minutes = Number(arg("minutes", "10"));
// Large regions see hundreds of vessels; cap the printed tables (the raw file keeps everything).
const TABLE_ROWS = Number(arg("rows", "80"));
const regionId = arg("region", "puget-sound");
const region = REGIONS[regionId];
if (!region) {
  console.error(`Unknown region "${regionId}". Options: ${Object.keys(REGIONS).join(", ")}`);
  process.exit(1);
}

type Vessel = {
  mmsi: number;
  name?: string;
  shipType?: number;
  lengthM?: number;
  cls?: "A" | "B";
  fixes: number;
  firstAt: number;
  lastAt: number;
  sogMin: number;
  sogMax: number;
  lastLat?: number;
  lastLon?: number;
};

const vessels = new Map<number, Vessel>();
const typeCounts: Record<string, number> = {};
let total = 0;

function vessel(mmsi: number): Vessel {
  let v = vessels.get(mmsi);
  if (!v) {
    v = { mmsi, fixes: 0, firstAt: 0, lastAt: 0, sogMin: Infinity, sogMax: -Infinity };
    vessels.set(mmsi, v);
  }
  return v;
}

function dimLength(d: any): number | undefined {
  const len = (d?.A ?? 0) + (d?.B ?? 0);
  return len > 0 ? len : undefined;
}

// --- Supabase ---------------------------------------------------------------

const USE_DB = !process.argv.includes("--no-db");
const SUPABASE_URL = USE_DB ? envVar("SUPABASE_URL") : undefined;
const SUPABASE_KEY = USE_DB ? envVar("SUPABASE_SECRET_KEY") : undefined;
const FLUSH_MS = 5_000;

type PositionRow = { mmsi: number; t: number; lon: number; lat: number; sog: number | null; cog: number | null };
let pendingPositions: PositionRow[] = [];
const dirtyVessels = new Set<number>();
let stored = 0;
let storeErrors = 0;

// "2026-09-29 14:51:42.593229588 +0000 UTC" -> epoch seconds
function parseAisTime(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)?/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}${(m[3] ?? "").slice(0, 4)}Z`);
  return Number.isNaN(ms) ? null : ms / 1000;
}

async function flush() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  const positions = pendingPositions;
  const mmsis = [...dirtyVessels];
  if (!positions.length && !mmsis.length) return;
  pendingPositions = [];
  dirtyVessels.clear();
  const vesselRows = mmsis.map((mmsi) => {
    const v = vessels.get(mmsi)!;
    return { mmsi, name: v.name ?? null, cls: v.cls ?? null, ship_type: v.shipType ?? null, length_m: v.lengthM ?? null };
  });
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ingest_ais`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "content-type": "application/json" },
      body: JSON.stringify({ p_positions: positions, p_vessels: vesselRows }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    stored += positions.length;
  } catch (err) {
    // Keep the batch for the next attempt; the raw .jsonl file has everything regardless.
    storeErrors++;
    pendingPositions = positions.concat(pendingPositions);
    for (const m of mmsis) dirtyVessels.add(m);
    if (storeErrors <= 3) console.error("Supabase write failed:", String(err).slice(0, 300));
  }
}

function handle(msg: any, now: number) {
  const type: string = msg.MessageType;
  typeCounts[type] = (typeCounts[type] ?? 0) + 1;
  const meta = msg.MetaData ?? {};
  const mmsi: number = meta.MMSI;
  if (!mmsi) return;
  const v = vessel(mmsi);
  dirtyVessels.add(mmsi);
  const shipName = typeof meta.ShipName === "string" ? meta.ShipName.trim() : "";
  if (shipName && !v.name) v.name = shipName;
  const body = msg.Message?.[type] ?? {};

  if (type === "PositionReport" || type === "StandardClassBPositionReport" || type === "ExtendedClassBPositionReport") {
    v.cls = type === "PositionReport" ? "A" : "B";
    v.fixes++;
    if (!v.firstAt) v.firstAt = now;
    v.lastAt = now;
    if (typeof body.Sog === "number" && body.Sog < 102.3) {
      v.sogMin = Math.min(v.sogMin, body.Sog);
      v.sogMax = Math.max(v.sogMax, body.Sog);
    }
    v.lastLat = meta.latitude;
    v.lastLon = meta.longitude;
    if (typeof meta.latitude === "number") recordCoverage(meta.latitude, meta.longitude, mmsi, body.Sog);
    if (typeof meta.latitude === "number" && typeof meta.longitude === "number") {
      pendingPositions.push({
        mmsi,
        t: parseAisTime(meta.time_utc) ?? now / 1000,
        lon: meta.longitude,
        lat: meta.latitude,
        sog: typeof body.Sog === "number" && body.Sog < 102.3 ? body.Sog : null,
        cog: typeof body.Cog === "number" && body.Cog < 360 ? body.Cog : null,
      });
    }
    if (type === "ExtendedClassBPositionReport") {
      v.shipType ??= body.Type;
      v.lengthM ??= dimLength(body.Dimension);
    }
  } else if (type === "ShipStaticData") {
    v.cls ??= "A";
    v.name = (body.Name ?? "").trim() || v.name;
    v.shipType = body.Type ?? v.shipType;
    v.lengthM = dimLength(body.Dimension) ?? v.lengthM;
  } else if (type === "StaticDataReport") {
    v.cls ??= "B";
    if (body.ReportA?.Valid) v.name = (body.ReportA.Name ?? "").trim() || v.name;
    if (body.ReportB?.Valid) {
      v.shipType = body.ReportB.ShipType ?? v.shipType;
      v.lengthM = dimLength(body.ReportB.Dimension) ?? v.lengthM;
    }
  }
}

function shipTypeLabel(t?: number): string {
  if (t == null) return "?";
  if (t >= 60 && t <= 69) return `${t} passenger`;
  if (t >= 70 && t <= 79) return `${t} cargo`;
  if (t >= 80 && t <= 89) return `${t} tanker`;
  if (t === 30) return "30 fishing";
  if (t === 31 || t === 32 || t === 52) return `${t} tug`;
  if (t === 36) return "36 sailing";
  if (t === 37) return "37 pleasure";
  if (t === 35) return "35 military";
  if (t === 55) return "55 law enf.";
  return String(t);
}

function summarize(outPath: string) {
  const list = [...vessels.values()].sort((a, b) => b.fixes - a.fixes);
  console.log(`\n=== ${region.name} · ${minutes} min · ${total} messages · ${list.length} vessels ===`);
  console.log("Messages by type:", typeCounts);
  const rows = list.map((v) => {
    const span = (v.lastAt - v.firstAt) / 1000;
    const candidate = v.shipType != null && v.shipType >= 60 && v.shipType <= 69 && (v.lengthM ?? 0) >= 15 && (v.lengthM ?? 0) <= 35;
    return {
      mmsi: v.mmsi,
      name: v.name ?? "",
      class: v.cls ?? "?",
      type: shipTypeLabel(v.shipType),
      len_m: v.lengthM ?? "",
      fixes: v.fixes,
      avg_s: v.fixes > 1 ? Math.round(span / (v.fixes - 1)) : "",
      sog_kn: v.sogMax >= 0 ? `${v.sogMin.toFixed(1)}–${v.sogMax.toFixed(1)}` : "",
      last: v.lastLat != null ? `${v.lastLat.toFixed(4)}, ${v.lastLon!.toFixed(4)}` : "",
      candidate: candidate ? "★" : "",
    };
  });
  console.table(rows.slice(0, TABLE_ROWS));
  if (rows.length > TABLE_ROWS) console.log(`(showing the ${TABLE_ROWS} vessels with the most fixes of ${rows.length}; all are in the raw file)`);
  const a = list.filter((v) => v.cls === "A").length;
  const b = list.filter((v) => v.cls === "B").length;
  console.log(`Class A: ${a} · Class B: ${b} · ★ = passenger type, 15–35 m (registry candidate, spec §4.3)`);
  summarizeCoverage();
  console.log(`Raw messages: ${outPath}`);
}

// Position reports per ~5 km cell (0.05°), to show where the feed actually hears boats.
const coverage = new Map<string, { msgs: number; mmsis: Set<number>; moving: Set<number> }>();

function recordCoverage(lat: number, lon: number, mmsi: number, sog?: number) {
  const key = `${(Math.floor(lat / 0.05) * 0.05).toFixed(2)},${(Math.floor(lon / 0.05) * 0.05).toFixed(2)}`;
  let c = coverage.get(key);
  if (!c) coverage.set(key, (c = { msgs: 0, mmsis: new Set(), moving: new Set() }));
  c.msgs++;
  c.mmsis.add(mmsi);
  if (sog != null && sog >= 2 && sog < 102.3) c.moving.add(mmsi);
}

function summarizeCoverage() {
  const cells = [...coverage.entries()].sort((a, b) => b[1].msgs - a[1].msgs);
  const [[s, w], [n, e]] = region.bbox;
  const totalCells = Math.ceil((n - s) / 0.05) * Math.ceil((e - w) / 0.05);
  console.log(`\nCoverage: position reports in ${cells.length} of ~${totalCells} cells (0.05° ≈ 5 km, SW corner shown)`);
  console.table(cells.slice(0, TABLE_ROWS).map(([cell, c]) => ({ cell, msgs: c.msgs, vessels: c.mmsis.size, moving: c.moving.size })));
  if (cells.length > TABLE_ROWS) console.log(`(showing the ${TABLE_ROWS} busiest cells of ${cells.length})`);
}

const key = loadKey();
mkdirSync(join("data", "samples"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join("data", "samples", `ais-${regionId}-${stamp}.jsonl`);
const out = createWriteStream(outPath);
const decoder = new TextDecoder();

console.log(`Sampling ${region.name} for ${minutes} min → ${outPath}`);
console.log(SUPABASE_URL && SUPABASE_KEY ? "Also writing to Supabase." : "Supabase not configured; writing the local file only.");
const flusher = setInterval(flush, FLUSH_MS);
const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
ws.binaryType = "arraybuffer";

let finished = false;
function finish(code = 0) {
  if (finished) return;
  finished = true;
  clearInterval(progress);
  clearInterval(flusher);
  try { ws.close(); } catch {}
  out.end(async () => {
    await flush();
    summarize(outPath);
    if (SUPABASE_URL && SUPABASE_KEY) {
      console.log(`Supabase: ${stored} positions stored${pendingPositions.length ? `, ${pendingPositions.length} not written` : ""}${storeErrors ? ` · ${storeErrors} failed writes` : ""}`);
    }
    process.exit(code);
  });
}

ws.addEventListener("open", () => {
  // AISStream closes the socket if the subscription isn't sent within 3 s.
  ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [region.bbox], FilterMessageTypes: MESSAGE_TYPES }));
  console.log("Connected, subscribed.");
});

ws.addEventListener("message", (ev) => {
  const text = typeof ev.data === "string" ? ev.data : decoder.decode(ev.data as ArrayBuffer);
  let msg: any;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.error) {
    console.error("AISStream error:", msg.error);
    finish(1);
    return;
  }
  const now = Date.now();
  total++;
  out.write(JSON.stringify({ received_at: new Date(now).toISOString(), ...msg }) + "\n");
  handle(msg, now);
});

ws.addEventListener("error", (ev: any) => console.error("WebSocket error:", ev.message ?? ev.type));
ws.addEventListener("close", (ev) => {
  if (!finished) {
    console.error(`Socket closed early (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""}).`);
    if (total === 0) console.error("No messages received: check that AISSTREAM_API_KEY is valid.");
    finish(total > 0 ? 0 : 1);
  }
});

const progress = setInterval(() => console.log(`  ${total} messages, ${vessels.size} vessels so far…`), 60_000);
setTimeout(() => finish(0), minutes * 60_000);
process.on("SIGINT", () => finish(0));
