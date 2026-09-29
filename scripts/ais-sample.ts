// Sample AIS traffic from AISStream for a bounding box and summarize it.
//
//   node scripts/ais-sample.ts [--minutes 10] [--region island-county]
//
// Reads AISSTREAM_API_KEY from .env.local. Writes every raw message to
// data/samples/ais-<region>-<timestamp>.jsonl and prints a per-vessel summary.
// Box-wide on purpose: there is no registry yet, so this also shows which
// vessels would be registry candidates (spec §4.3).

import { mkdirSync, readFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";

type BBox = [[number, number], [number, number]]; // [[lat, lon] SW, [lat, lon] NE]

const REGIONS: Record<string, { name: string; bbox: BBox }> = {
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

function loadKey(): string {
  if (process.env.AISSTREAM_API_KEY) return process.env.AISSTREAM_API_KEY;
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*AISSTREAM_API_KEY\s*=\s*"?([^"\s]+)"?/);
      if (m) return m[1];
    }
  } catch {}
  console.error("Missing AISSTREAM_API_KEY. Add it to .env.local (get one at https://aisstream.io/apikeys).");
  process.exit(1);
}

const minutes = Number(arg("minutes", "10"));
const regionId = arg("region", "island-county");
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

function handle(msg: any, now: number) {
  const type: string = msg.MessageType;
  typeCounts[type] = (typeCounts[type] ?? 0) + 1;
  const meta = msg.MetaData ?? {};
  const mmsi: number = meta.MMSI;
  if (!mmsi) return;
  const v = vessel(mmsi);
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
  console.table(rows);
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
  console.table(cells.map(([cell, c]) => ({ cell, msgs: c.msgs, vessels: c.mmsis.size, moving: c.moving.size })));
}

const key = loadKey();
mkdirSync(join("data", "samples"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join("data", "samples", `ais-${regionId}-${stamp}.jsonl`);
const out = createWriteStream(outPath);
const decoder = new TextDecoder();

console.log(`Sampling ${region.name} for ${minutes} min → ${outPath}`);
const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
ws.binaryType = "arraybuffer";

let finished = false;
function finish(code = 0) {
  if (finished) return;
  finished = true;
  clearInterval(progress);
  try { ws.close(); } catch {}
  out.end(() => {
    summarize(outPath);
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
