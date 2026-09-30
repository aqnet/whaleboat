// Long-running AIS recorder: AISStream WebSocket -> Supabase.
//
// The always-on counterpart of scripts/ais-sample.ts. Runs in Docker on the
// free-tier VM (deploy/vm/, specs/deployment-plan.md); also works as a Cloud
// Run service. It holds one outbound WebSocket,
// batches position reports and vessel details, and writes them with the
// ingest_ais() function (db/migrations/*_ais_positions.sql).
//
//   node services/recorder/recorder.ts
//
// Environment:
//   AISSTREAM_API_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY   required; or
//              *_FILE variants pointing at files that hold the values
//   AIS_BBOX   "south,west,north,east"; default is the puget-sound box plus
//              the whale-watch box from scripts/ais-sample.ts
//   PORT       if set (Cloud Run *service*), serves a health check on it
//   AISSTREAM_URL   override the stream endpoint (tests)
//
// No dependencies: Node >= 22.18 runs this file directly and has WebSocket
// and fetch built in. Logs are JSON lines, which Cloud Logging parses.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";

type BBox = [[number, number], [number, number]]; // [[lat, lon] SW, [lat, lon] NE]

// Port Angeles east to Everett, Tacoma north to the San Juans.
const DEFAULT_BBOX: BBox = [[47.22, -123.6], [48.8, -122.15]];

const MESSAGE_TYPES = [
  "PositionReport",
  "StandardClassBPositionReport",
  "ExtendedClassBPositionReport",
  "ShipStaticData",
  "StaticDataReport",
];

const FLUSH_MS = 5_000;
const HEARTBEAT_MS = 5 * 60_000;
// AISStream can go quiet without closing the socket. Traffic in this box never
// stops for this long, so silence means the connection is dead.
const STALE_MS = 3 * 60_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
// Bounds memory if Supabase is unreachable: oldest positions are dropped first.
const MAX_PENDING = 50_000;

function log(severity: "INFO" | "WARNING" | "ERROR", message: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ severity, message, ...extra, time: new Date().toISOString() }));
}

// NAME_FILE (a path) takes precedence over NAME, so a host can hand secrets
// over as files in memory rather than as container environment variables,
// which Docker writes to disk.
function required(name: string): string {
  const file = process.env[`${name}_FILE`];
  const v = file ? readFileSync(file, "utf8").trim() : process.env[name];
  if (!v) {
    log("ERROR", `Missing environment variable ${name}`);
    process.exit(1);
  }
  return v;
}

function parseBBox(s: string | undefined): BBox {
  if (!s) return DEFAULT_BBOX;
  const [south, west, north, east] = s.split(",").map(Number);
  if ([south, west, north, east].some(Number.isNaN) || south >= north || west >= east) {
    log("ERROR", `AIS_BBOX must be "south,west,north,east", got "${s}"`);
    process.exit(1);
  }
  return [[south, west], [north, east]];
}

const AIS_KEY = required("AISSTREAM_API_KEY");
const SUPABASE_URL = required("SUPABASE_URL");
const SUPABASE_KEY = required("SUPABASE_SECRET_KEY");
const BBOX = parseBBox(process.env.AIS_BBOX);

// --- State --------------------------------------------------------------------

type PositionRow = { mmsi: number; t: number; lon: number; lat: number; sog: number | null; cog: number | null };
type VesselRow = { mmsi: number; name: string | null; cls: "A" | "B" | null; ship_type: number | null; length_m: number | null };

let pending: PositionRow[] = [];
// Only vessels with something new to say since the last flush. ingest_ais()
// merges fields, so a row of nulls never erases what the database knows.
let dirty = new Map<number, VesselRow>();

const stats = { messages: 0, stored: 0, dropped: 0, writeErrors: 0, reconnects: 0 };
let lastMessageAt = 0;
let lastStoreOkAt = 0;

// "2026-09-29 14:51:42.593229588 +0000 UTC" -> epoch seconds
function parseAisTime(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)?/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}${(m[3] ?? "").slice(0, 4)}Z`);
  return Number.isNaN(ms) ? null : ms / 1000;
}

function dimLength(d: { A?: number; B?: number } | undefined): number | null {
  const len = (d?.A ?? 0) + (d?.B ?? 0);
  return len > 0 ? len : null;
}

function vessel(mmsi: number): VesselRow {
  let v = dirty.get(mmsi);
  if (!v) dirty.set(mmsi, (v = { mmsi, name: null, cls: null, ship_type: null, length_m: null }));
  return v;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw AISStream JSON; fields are checked where used
function handle(msg: any) {
  const type: string = msg.MessageType;
  const meta = msg.MetaData ?? {};
  const mmsi: number = meta.MMSI;
  if (!mmsi) return;
  const v = vessel(mmsi);
  const metaName = typeof meta.ShipName === "string" ? meta.ShipName.trim() : "";
  if (metaName) v.name ??= metaName;
  const body = msg.Message?.[type] ?? {};

  if (type === "PositionReport" || type === "StandardClassBPositionReport" || type === "ExtendedClassBPositionReport") {
    v.cls = type === "PositionReport" ? "A" : "B";
    if (typeof meta.latitude === "number" && typeof meta.longitude === "number") {
      pending.push({
        mmsi,
        t: parseAisTime(meta.time_utc) ?? Date.now() / 1000,
        lon: meta.longitude,
        lat: meta.latitude,
        sog: typeof body.Sog === "number" && body.Sog < 102.3 ? body.Sog : null,
        cog: typeof body.Cog === "number" && body.Cog < 360 ? body.Cog : null,
      });
    }
    if (type === "ExtendedClassBPositionReport") {
      v.ship_type ??= body.Type || null;
      v.length_m ??= dimLength(body.Dimension);
    }
  } else if (type === "ShipStaticData") {
    v.cls ??= "A";
    v.name = (body.Name ?? "").trim() || v.name;
    v.ship_type = body.Type || v.ship_type;
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

// --- Supabase -----------------------------------------------------------------

let flushing = false;

async function flush() {
  if (flushing || (!pending.length && !dirty.size)) return;
  flushing = true;
  const positions = pending;
  const vessels = dirty;
  pending = [];
  dirty = new Map();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ingest_ais`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "content-type": "application/json" },
      body: JSON.stringify({ p_positions: positions, p_vessels: [...vessels.values()] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
    stats.stored += positions.length;
    lastStoreOkAt = Date.now();
  } catch (err) {
    // Put the batch back for the next attempt, newest data winning if memory is tight.
    stats.writeErrors++;
    pending = positions.concat(pending);
    if (pending.length > MAX_PENDING) {
      stats.dropped += pending.length - MAX_PENDING;
      pending = pending.slice(-MAX_PENDING);
    }
    for (const [mmsi, v] of vessels) if (!dirty.has(mmsi)) dirty.set(mmsi, v);
    log("ERROR", "Supabase write failed", { error: String(err), pending: pending.length });
  } finally {
    flushing = false;
  }
}

// --- AISStream ------------------------------------------------------------------

let ws: WebSocket | null = null;
let backoff = BACKOFF_MIN_MS;
let stopping = false;
const decoder = new TextDecoder();

function connect() {
  if (stopping) return;
  const socket = new WebSocket(process.env.AISSTREAM_URL ?? "wss://stream.aisstream.io/v0/stream");
  socket.binaryType = "arraybuffer";
  ws = socket;
  const openedAt = Date.now();

  socket.addEventListener("open", () => {
    // AISStream closes the socket if the subscription isn't sent within 3 s.
    socket.send(JSON.stringify({ APIKey: AIS_KEY, BoundingBoxes: [BBOX], FilterMessageTypes: MESSAGE_TYPES }));
    lastMessageAt = Date.now();
    log("INFO", "Connected to AISStream", { bbox: BBOX });
  });

  socket.addEventListener("message", (ev) => {
    const text = typeof ev.data === "string" ? ev.data : decoder.decode(ev.data as ArrayBuffer);
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.error) {
      log("ERROR", "AISStream error", { error: msg.error });
      socket.close();
      return;
    }
    stats.messages++;
    lastMessageAt = Date.now();
    handle(msg);
  });

  socket.addEventListener("error", (ev) => {
    log("WARNING", "WebSocket error", { error: (ev as ErrorEvent).message ?? ev.type });
  });

  socket.addEventListener("close", (ev) => {
    if (ws !== socket) return;
    ws = null;
    if (stopping) return;
    // A connection that lasted a while was healthy: start the backoff over.
    if (Date.now() - openedAt > 60_000) backoff = BACKOFF_MIN_MS;
    const wait = Math.round(backoff * (0.5 + Math.random()));
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    stats.reconnects++;
    log("WARNING", "AISStream socket closed; reconnecting", { code: ev.code, reason: ev.reason, wait_ms: wait });
    setTimeout(connect, wait);
  });
}

// --- Timers -------------------------------------------------------------------

setInterval(flush, FLUSH_MS);

setInterval(() => {
  if (ws && lastMessageAt && Date.now() - lastMessageAt > STALE_MS) {
    log("WARNING", "No AIS messages recently; forcing a reconnect", { quiet_s: Math.round((Date.now() - lastMessageAt) / 1000) });
    ws.close();
  }
}, 30_000);

// The alert policy in the deployment plan fires when these stop arriving.
setInterval(() => {
  log("INFO", "heartbeat", {
    ...stats,
    pending: pending.length,
    last_message_age_s: lastMessageAt ? Math.round((Date.now() - lastMessageAt) / 1000) : null,
    last_store_age_s: lastStoreOkAt ? Math.round((Date.now() - lastStoreOkAt) / 1000) : null,
  });
}, HEARTBEAT_MS);

// Cloud Run sends SIGTERM, then SIGKILL 10 s later.
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log("INFO", `${signal} received; flushing and exiting`, { pending: pending.length });
  try {
    ws?.close();
  } catch {}
  const deadline = Date.now() + 8_000;
  while (flushing && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  await flush();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// A Cloud Run service (unlike a worker pool) must listen on PORT. The check
// fails while the feed is stale, so a stuck instance gets replaced.
if (process.env.PORT) {
  createServer((_req, res) => {
    const healthy = lastMessageAt > 0 && Date.now() - lastMessageAt < STALE_MS * 2;
    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ healthy, ...stats, pending: pending.length }));
  }).listen(Number(process.env.PORT));
}

log("INFO", "Recorder starting", { bbox: BBOX });
connect();
