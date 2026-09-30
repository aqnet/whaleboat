// End-to-end tests for the recorder: runs the real process against stand-in
// AISStream (WebSocket) and Supabase (HTTP) servers. No network, no secrets.
//
//   node --test services/recorder/
//
// Uses only Node built-ins, like the recorder itself. Takes ~20 s: the
// recorder flushes every 5 s.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const RECORDER = join(import.meta.dirname, "recorder.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// --- Stand-in servers ------------------------------------------------------------

type Batch = { apikey: string | undefined; p_positions: Record<string, unknown>[]; p_vessels: Record<string, unknown>[] };

class Stub {
  server: Server;
  port = 0;
  sockets: Duplex[] = [];
  subscriptions: Record<string, unknown>[] = [];
  batches: Batch[] = [];
  failNextWrites = 0;

  constructor() {
    this.server = createServer((req, res) => this.http(req, res));
    this.server.on("upgrade", (req, socket) => this.upgrade(req, socket));
  }

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
  }

  stop() {
    for (const s of this.sockets) s.destroy();
    this.server.close();
  }

  private http(req: IncomingMessage, res: import("node:http").ServerResponse) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url !== "/rest/v1/rpc/ingest_ais") return void res.writeHead(404).end();
      if (this.failNextWrites > 0) {
        this.failNextWrites--;
        return void res.writeHead(500).end("simulated failure");
      }
      this.batches.push({ apikey: req.headers.apikey as string | undefined, ...JSON.parse(body) });
      res.writeHead(204).end();
    });
  }

  private upgrade(req: IncomingMessage, socket: Duplex) {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("error", () => {});
    socket.once("data", (frame: Buffer) => this.subscriptions.push(JSON.parse(unmask(frame))));
    this.sockets.push(socket);
  }

  /** Sends a text frame on the newest connection. */
  send(obj: unknown) {
    const b = Buffer.from(JSON.stringify(obj));
    const head = b.length < 126 ? Buffer.from([0x81, b.length]) : Buffer.from([0x81, 126, b.length >> 8, b.length & 255]);
    this.sockets.at(-1)!.write(Buffer.concat([head, b]));
  }

  positions() {
    return this.batches.flatMap((b) => b.p_positions);
  }
}

// Client frames are masked (RFC 6455 §5.3).
function unmask(frame: Buffer): string {
  let len = frame[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    len = frame.readUInt16BE(2);
    off = 4;
  }
  const mask = frame.subarray(off, off + 4);
  const data = frame.subarray(off + 4, off + 4 + len);
  return Buffer.from(data.map((b, i) => b ^ mask[i % 4])).toString();
}

// --- AISStream messages --------------------------------------------------------------

const position = (mmsi: number, sec: number, sog: number, name = "") => ({
  MessageType: "PositionReport",
  MetaData: { MMSI: mmsi, ShipName: name, latitude: 48.1, longitude: -122.5, time_utc: `2026-09-30 17:00:${String(sec).padStart(2, "0")}.123456789 +0000 UTC` },
  Message: { PositionReport: { Sog: sog, Cog: 90 } },
});

const staticData = (mmsi: number, name: string, type: number) => ({
  MessageType: "ShipStaticData",
  MetaData: { MMSI: mmsi, ShipName: name },
  Message: { ShipStaticData: { Name: `${name}  `, Type: type, Dimension: { A: 20, B: 11 } } },
});

// --- Recorder process --------------------------------------------------------------

function startRecorder(env: Record<string, string>) {
  const logs: Record<string, unknown>[] = [];
  const child = spawn(process.execPath, [RECORDER], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  child.stdout!.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        logs.push(JSON.parse(line));
      } catch {
        logs.push({ message: line });
      }
    }
  });
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { child, logs, exited };
}

const secretsDir = mkdtempSync(join(tmpdir(), "recorder-test-"));
function secretFile(name: string, value: string) {
  const p = join(secretsDir, name);
  writeFileSync(p, `${value}\n`);
  return p;
}

// --- Tests -------------------------------------------------------------------------

describe("recorder", () => {
  const stub = new Stub();
  let rec: { child: ChildProcess; logs: Record<string, unknown>[]; exited: Promise<number | null> };
  let healthPort: number;

  before(async () => {
    await stub.start();
    stub.failNextWrites = 1;
    healthPort = stub.port + 1;
    rec = startRecorder({
      // Secrets as files, the way the VM hands them over.
      AISSTREAM_API_KEY_FILE: secretFile("ais", "test-ais-key"),
      SUPABASE_URL_FILE: secretFile("url", `http://127.0.0.1:${stub.port}`),
      SUPABASE_SECRET_KEY_FILE: secretFile("key", "test-secret"),
      AISSTREAM_URL: `ws://127.0.0.1:${stub.port}/ws`,
      AIS_BBOX: "47.2,-123.6,48.8,-122.1",
      PORT: String(healthPort),
    });
    await until(() => stub.subscriptions.length === 1, 5000, "the subscription");
  });

  after(() => {
    rec.child.kill("SIGKILL");
    stub.stop();
  });

  it("subscribes with the API key, bounding box and message types", () => {
    const sub = stub.subscriptions[0] as { APIKey: string; BoundingBoxes: number[][][]; FilterMessageTypes: string[] };
    assert.equal(sub.APIKey, "test-ais-key"); // read from the file, trailing newline trimmed
    assert.deepEqual(sub.BoundingBoxes, [[[47.2, -123.6], [48.8, -122.1]]]);
    assert.ok(sub.FilterMessageTypes.includes("PositionReport"));
    assert.ok(sub.FilterMessageTypes.includes("StaticDataReport"));
  });

  it("retries a failed write and stores the batch once the database recovers", { timeout: 20_000 }, async () => {
    stub.send(staticData(368457860, "EMERALD CLIPPER", 60));
    stub.send(position(368457860, 1, 12.5));
    stub.send(position(368457860, 2, 102.3)); // "speed not available"
    // First flush fails (failNextWrites = 1); the retry 5 s later succeeds.
    await until(() => stub.positions().length >= 2, 15_000, "the retried batch");
    assert.equal(stub.batches[0].apikey, "test-secret");
    const [p1, p2] = stub.positions();
    assert.deepEqual(p1, { mmsi: 368457860, t: Date.UTC(2026, 8, 30, 17, 0, 1, 123) / 1000, lon: -122.5, lat: 48.1, sog: 12.5, cog: 90 });
    assert.equal(p2.sog, null);
    const vessel = stub.batches.flatMap((b) => b.p_vessels).find((v) => v.mmsi === 368457860);
    assert.deepEqual(vessel, { mmsi: 368457860, name: "EMERALD CLIPPER", cls: "A", ship_type: 60, length_m: 31 });
    assert.ok(rec.logs.some((l) => l.severity === "ERROR" && l.message === "Supabase write failed"));
  });

  it("serves a health check while the feed is live", async () => {
    const res = await fetch(`http://127.0.0.1:${healthPort}/`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).healthy, true);
  });

  it("reconnects when the stream drops", { timeout: 15_000 }, async () => {
    stub.sockets.at(-1)!.destroy();
    await until(() => stub.subscriptions.length === 2, 10_000, "a second subscription");
    assert.ok(rec.logs.some((l) => l.message === "AISStream socket closed; reconnecting"));
  });

  it("flushes what it holds and exits cleanly on SIGTERM", { timeout: 10_000 }, async () => {
    const before = stub.positions().length;
    stub.send(position(338000001, 30, 4, "LATE ARRIVAL"));
    await sleep(300); // received, not yet flushed
    rec.child.kill("SIGTERM");
    assert.equal(await rec.exited, 0);
    assert.equal(stub.positions().length, before + 1);
    assert.equal(stub.positions().at(-1)!.mmsi, 338000001);
  });
});

describe("recorder configuration", () => {
  it("exits with an error when a required key is missing", async () => {
    const r = startRecorder({ SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SECRET_KEY: "x" });
    assert.equal(await r.exited, 1);
    assert.ok(r.logs.some((l) => l.severity === "ERROR" && String(l.message).includes("AISSTREAM_API_KEY")));
  });

  it("rejects a malformed bounding box", async () => {
    const r = startRecorder({ AISSTREAM_API_KEY: "k", SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SECRET_KEY: "x", AIS_BBOX: "48.8,-122,47.2,-123" });
    assert.equal(await r.exited, 1);
    assert.ok(r.logs.some((l) => String(l.message).includes("AIS_BBOX")));
  });
});
