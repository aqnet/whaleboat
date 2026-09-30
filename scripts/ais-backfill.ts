// Load recorded AIS samples (data/samples/*.jsonl) into Supabase.
//
//   node scripts/ais-backfill.ts [file.jsonl ...]     (default: every sample)
//
// Replays each file through the same ingest_ais() function the sampler uses,
// so it is safe to re-run: positions already stored are skipped.
// Reads SUPABASE_URL and SUPABASE_SECRET_KEY from the environment or .env.local.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SAMPLES_DIR = join("data", "samples");
const BATCH = 2000;

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

const SUPABASE_URL = envVar("SUPABASE_URL");
const SUPABASE_KEY = envVar("SUPABASE_SECRET_KEY");
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY (.env.local).");
  process.exit(1);
}

// "2026-09-29 14:51:42.593229588 +0000 UTC" -> epoch seconds
function parseAisTime(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)?/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}${(m[3] ?? "").slice(0, 4)}Z`);
  return Number.isNaN(ms) ? null : ms / 1000;
}

const dimLength = (d: any): number | null => {
  const len = (d?.A ?? 0) + (d?.B ?? 0);
  return len > 0 ? len : null;
};

type PositionRow = { mmsi: number; t: number; lon: number; lat: number; sog: number | null; cog: number | null };
type VesselRow = { mmsi: number; name: string | null; cls: "A" | "B" | null; ship_type: number | null; length_m: number | null };

async function ingest(positions: PositionRow[], vessels: VesselRow[]) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ingest_ais`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY!, "content-type": "application/json" },
    body: JSON.stringify({ p_positions: positions, p_vessels: vessels }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
}

const POSITION_TYPES = new Set(["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"]);

const files = process.argv.slice(2).length
  ? process.argv.slice(2).map((f) => f.replace(/^.*\//, ""))
  : readdirSync(SAMPLES_DIR).filter((f) => f.endsWith(".jsonl")).sort();

for (const file of files) {
  const vessels = new Map<number, VesselRow>();
  const positions: PositionRow[] = [];
  for (const line of readFileSync(join(SAMPLES_DIR, file), "utf8").split("\n")) {
    if (!line) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; } // a file still recording can end mid-line
    const type: string = msg.MessageType;
    const meta = msg.MetaData;
    if (!meta?.MMSI) continue;
    let v = vessels.get(meta.MMSI);
    if (!v) vessels.set(meta.MMSI, (v = { mmsi: meta.MMSI, name: null, cls: null, ship_type: null, length_m: null }));
    const metaName = typeof meta.ShipName === "string" ? meta.ShipName.trim() : "";
    if (metaName && !v.name) v.name = metaName;
    const body = msg.Message?.[type] ?? {};

    if (POSITION_TYPES.has(type)) {
      v.cls = type === "PositionReport" ? "A" : "B";
      if (typeof meta.latitude !== "number" || typeof meta.longitude !== "number") continue;
      positions.push({
        mmsi: meta.MMSI,
        t: parseAisTime(meta.time_utc) ?? Date.parse(msg.received_at) / 1000,
        lon: meta.longitude,
        lat: meta.latitude,
        sog: typeof body.Sog === "number" && body.Sog < 102.3 ? body.Sog : null,
        cog: typeof body.Cog === "number" && body.Cog < 360 ? body.Cog : null,
      });
      if (type === "ExtendedClassBPositionReport") {
        v.ship_type ??= body.Type ?? null;
        v.length_m ??= dimLength(body.Dimension);
      }
    } else if (type === "ShipStaticData") {
      v.cls ??= "A";
      v.name = (body.Name ?? "").trim() || v.name;
      v.ship_type = body.Type ?? v.ship_type;
      v.length_m = dimLength(body.Dimension) ?? v.length_m;
    } else if (type === "StaticDataReport") {
      v.cls ??= "B";
      if (body.ReportA?.Valid) v.name = (body.ReportA.Name ?? "").trim() || v.name;
      if (body.ReportB?.Valid) {
        v.ship_type = body.ReportB.ShipType || v.ship_type;
        v.length_m = dimLength(body.ReportB.Dimension) ?? v.length_m;
      }
    }
  }

  await ingest([], [...vessels.values()]);
  for (let i = 0; i < positions.length; i += BATCH) await ingest(positions.slice(i, i + BATCH), []);
  console.log(`${file}: ${positions.length} positions, ${vessels.size} vessels sent`);
}
