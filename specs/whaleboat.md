# Whaleboat — Technical Spec

**Status:** Draft v0.2 · 2026-09-28
**Owner:** Anderson
**One-liner:** A mobile-first web app that tracks whale-watching boats (AIS) and whale sightings across Seattle → Camano Island. It shows them live, replays boat paths, and computes seasonal whale-activity hotspots from de-duplicated *encounters*.

> Items marked **⚠ VERIFY** are assumptions about third-party APIs, data formats, or licenses. Confirm them before building against them.

### Changelog
- **v0.2:** Hotspots are now scored on encounters instead of raw events. Added historical sighting sources that need no approval. Added a Phase 0.5 signal spike. Scoring now uses Bayesian shrinkage. Added a now-cast. Added **boat path plotting and replay** (§8). Simplified storage. Filled schema gaps. Added an SRKW location-disclosure policy. Added a backlog.
- **v0.1:** Initial draft.

---

## 1. Goals and non-goals

### Goals
1. **Live map.** Show whale-watch boats, their trails, and recent sightings in near-real-time, readable on a phone on a ferry deck.
2. **Now-cast.** Show where licensed boats are clustered and slow right now. This is the earliest real-time signal of where whales are.
3. **Boat paths.** Plot and replay any vessel's track, or all vessels over a time window, with loiter periods highlighted and sightings synced to the same timeline.
4. **Hotspot map.** Show where whale activity concentrates, split by month and species, scored on de-duplicated encounters with uncertainty shown.
5. **History on day 1.** Backfill from archives so hotspots and replays work without waiting a season.
6. **Cheap to run:** under $30/mo at hobby scale.

### Non-goals (v1)
- Coverage outside the bounding box in §3.
- Tracking recreational (non-registry) vessels. They aren't stored or displayed.
- Predictive models.
- User-submitted sightings. Send users to Orca Network or the Whale Alert app.

---

## 2. Core thesis

Neither signal is trustworthy alone:

| Signal | What it actually measures | Main bias |
|---|---|---|
| **Sightings** | Where people *reported* whales | Observer density, and repeat reports of the same animals |
| **Boat loitering** (AIS) | Where licensed operators *slowed and stayed* | Operator effort (home ports, range), and several boats on the same whale |

Therefore:
1. **Raw events are grouped into encounters** (§7.3). One pod seen by 20 people and 3 boats counts as one encounter.
2. **A hotspot is a cell where encounter rates are elevated after effort normalization and shrinkage.** Cells where the two sources disagree get their own layer.

---

## 3. Geography

**Primary bounding box (v1):** `SW 47.50, -122.65` → `NE 48.30, -122.20`
This covers Elliott Bay, the central Sound to Edmonds, Possession Sound, Saratoga Passage, Port Susan, and southern Skagit Bay.

The box is config-driven (`regions` table), so it can be widened later without a code change.

**Named sub-regions** (polygons): Elliott Bay, Central Sound, Possession Sound, Saratoga Passage, Port Susan, Skagit Bay (S).

**Land mask:** a high-resolution coastline polygon (from the basemap source or OSM coastlines). It is used to split tracks at gaps that would otherwise draw across land (§8.2) and to sanity-check fixes.

---

## 4. Data sources

### 4.1 Vessel positions (AIS)

| Source | Role | Access | Latency | Cost | Notes |
|---|---|---|---|---|---|
| **AISStream.io** | Primary live feed | WebSocket `wss://stream.aisstream.io/v0/stream`, API key | Seconds | Free | Community terrestrial receivers, no SLA. |
| **Own receiver** (Phase 3) | Gap-fill and redundancy | RTL-SDR v4 or dAISy + AIS-catcher → UDP to the worker | ~0 | ~$200 one-time | Antenna height dominates range. A Camano site sees Saratoga Passage *or* Port Susan. |
| **AISHub** (Phase 3) | Secondary feed | Requires contributing a receiver | Seconds–min | Free | Only once the receiver is running. |
| **NOAA MarineCadastre** | Historical backfill (tracks and loiters) | Bulk daily national files | Months behind | Free | ⚠ VERIFY the current format (zipped CSV historically; possibly GeoParquet for newer years). Includes vessel type and length, which are used for registry discovery (§4.3). |

**AISStream subscription:**

```json
{
  "APIKey": "<key>",
  "BoundingBoxes": [[[47.50, -122.65], [48.30, -122.20]]],
  "FiltersShipMMSI": ["<registry MMSIs…>"],
  "FilterMessageTypes": ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"]
}
```

⚠ VERIFY `FiltersShipMMSI` naming and limits. Fallback: subscribe to the whole box and filter in the worker. Candidate discovery (§4.3) needs box-wide static data anyway.

### 4.2 Whale sightings

| Source | Role | Access | Notes |
|---|---|---|---|
| **Acartia** | Primary live sightings | REST, bearer token (`acartia.io/register` → dashboard). `GET /api/v1/sightings/current` (~7-day window) | Aggregates Orca Network and others. Sightings lag 5–30 min, and some have no coordinates. **Historical endpoints are approval-gated.** ⚠ VERIFY the schema. |
| **salishsea-io DarwinCore Archive** | **Historical sightings, no approval needed** | Nightly DwC-A published by the salish-sea project | Curated marine-mammal record, same scope as Acartia. ⚠ VERIFY the URL, temporal depth, and license. |
| **GBIF / OBIS** | Historical backstop | Public occurrence APIs, filtered by taxon and bounding box | Mixed quality. Use as a supplement and dedupe against the DwC-A. ⚠ VERIFY coverage for the box. |
| **iNaturalist** | Verified photo observations | Public REST API | Low volume, high confidence. Useful for species validation. |
| **Orca Network viewpoints** | Observer-bias correction and map context | Location list (already used by salishsea-io) | Input to `observer_weight` (§7.4). |

**Species vocabulary** (Postgres enum `species_t`):
`srkw` · `biggs` · `humpback` · `gray` · `minke` · `harbor_porpoise` · `dalls_porpoise` · `unknown_cetacean`, plus an optional `pod` (J/K/L) for `srkw`.

### 4.3 Operator and vessel registry

The registry decides what the entire AIS layer shows. Build it in three tracks:

1. **Source of truth:** a WDFW **public records request** for the licensed whale-watch vessel list.
2. **Manual bootstrap:** operators out of Edmonds, Everett, Seattle and La Conner. Vessel names come from their websites; resolve names to MMSIs via `ShipStaticData`.
3. **Behavioral discovery** (semi-automated, from MarineCadastre and live data). Flag MMSIs that match:
   - passenger vessel type (AIS types 60–69), length about 15–35 m,
   - a same-day out-and-back trip from a known port,
   - at least one off-shipping-lane loiter (§7.2) per trip.

   Candidates go to a **review queue**. They are never auto-added.

### 4.4 Environmental covariates (Phase 2)

| Source | Use |
|---|---|
| **NOAA CO-OPS tides API** (Seattle, Everett and nearby stations) | Tag every encounter with tide height and phase. Gray whales feed on the shrimp flats around high tide. |
| Sunrise/sunset (computed) | Effort normalization: boats run in daylight, and observers mostly watch then too. |

### 4.5 Regulatory overlays

- **SRKW 1,000-yard buffer** (RCW 77.15.740, year-round). Used for:
  1. association distance in encounter clustering (boats sit about 0.5 nm off orcas),
  2. a "Be Whale Wise" ring layer in the UI.
- Rules are stored as data in `regulations` (§6.2), because WDFW updates them.

---

## 5. Mapping stack

| Layer | Choice | Why |
|---|---|---|
| Renderer | **MapLibre GL JS** (`react-map-gl/maplibre`) | Open source, no per-load fees, good on mobile |
| Basemap | **Protomaps PMTiles** on R2 (or OpenFreeMap) | Free vector tiles; a single file, no tile server |
| Nautical context (toggle) | NOAA chart tiles | ⚠ VERIFY the endpoint and terms. Optional. |
| Bathymetry (optional) | NOAA NCEI Puget Sound DEM → contours as vector tiles | Feeding-flat context. Generated once, offline. |
| Overlays | **deck.gl** via `@deck.gl/mapbox` (interleaved) | `H3HexagonLayer` (hotspots), `PathLayer` (static tracks), **`TripsLayer`** (animated replay), `ScatterplotLayer` (sightings and boats), `IconLayer` (vessel heading) |
| Spatial index | **H3** (`h3-js`), r8 (~0.7 km²) for hotspots, r9 for drill-down | Uniform cells, native deck.gl layer |

**UI layers:**
1. Live boats (heading icon) plus live trail (§8.1)
2. **Now-cast clusters** (§7.5)
3. Recent sightings (species color, fade over 0–6 h)
4. SRKW buffer rings
5. **Historical tracks and replay** (§8)
6. Hotspot hexes (month/species/tide filters, credible-interval shading)
7. Disagreement hexes
8. Viewpoints

---

## 6. Architecture

```
   ┌───────────────────────┐   ┌───────────────────┐   ┌───────────────────┐
   │ AISStream (WebSocket) │   │ Acartia (poll 5m) │   │ NOAA CO-OPS tides │
   └──────────┬────────────┘   └─────────┬─────────┘   └─────────┬─────────┘
  receiver ─UDP┐│                        │                       │
               ▼▼                        ▼                       ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │ Ingest Worker (Node/TS, long-running) — Fly.io, NOT Vercel            │
   │ • normalize → validate → dedupe • loiter detector (per-MMSI state)    │
   │ • trip segmenter (per-MMSI state) • now-cast clusterer (every 30 s)   │
   │ • Realtime broadcast: latest positions + now-cast                     │
   └──────────────────────────────┬───────────────────────────────────────┘
                                  ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │ Supabase Postgres + PostGIS                                           │
   │ positions · trips · loiter_events · sightings · encounters            │
   │ effort_cells · hotspot_cells · registry · regulations · source_health │
   │ pg_cron: trip finalize (5 min), encounters + hotspots (nightly)       │
   └──────────┬───────────────────────────────────────┬───────────────────┘
              │                                       │
   ┌──────────▼────────────────┐        ┌─────────────▼─────────────────────┐
   │ Next.js (App Router)      │        │ Batch / notebooks                 │
   │ Vercel                    │        │ MarineCadastre + DwC-A → DuckDB → │
   │ • RSC pages, cached APIs  │        │ filter → COPY into PG             │
   │ • MapLibre + deck.gl      │        │ Phase 0.5 spike, ground-truth eval│
   │ • Realtime subscription   │        └───────────────────────────────────┘
   └───────────────────────────┘
```

### 6.1 Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Live ingest | **Separate long-running worker** (Fly.io, ~$2–5/mo) | Vercel and Supabase Edge Functions can't hold a persistent WebSocket |
| Database | **Supabase Postgres + PostGIS** | Fits the familiar stack. PostGIS handles geofences, buffers and track geometry. |
| H3 | Computed in the worker and batch jobs (`h3-js`), stored as `text` | ⚠ VERIFY Supabase `h3` extension support; don't depend on it |
| Live push | **Realtime Broadcast** from the worker | Avoids CDC on a high-write table |
| Storage | **Plain `positions` table + BRIN on `ts`**, no partitioning | About 20 vessels × a fix every 10 s × daylight hours is well under 1 GB/yr. Partition only if the region grows. |
| Track storage | **Precomputed `trips`** with `LineStringM` (M = epoch seconds) at two simplification tolerances | Replay and path queries read one row per trip instead of thousands of points (§8.2) |
| History | **DuckDB** over MarineCadastre and the DwC-A, loading only filtered rows | Never load national files raw |
| Aggregation | pg_cron nightly, plus on-demand refresh | Hotspots change slowly. The client reads small, cacheable payloads. |

### 6.2 Data model

```sql
create type species_t as enum ('srkw','biggs','humpback','gray','minke',
  'harbor_porpoise','dalls_porpoise','unknown_cetacean');

-- Reference ------------------------------------------------------------
create table regions (
  id text primary key, name text not null,
  bbox geometry(Polygon,4326) not null
);

create table operators (
  id uuid primary key default gen_random_uuid(),
  region_id text references regions(id),
  name text not null, home_port text, website text,
  home_geofence geometry(Polygon,4326),     -- excluded from loiter; trip start/end
  wdfw_licensed boolean default false,
  source text check (source in ('wdfw_prr','manual','discovered'))
);

create table vessels (
  mmsi bigint primary key,
  operator_id uuid references operators(id),
  name text, length_m numeric, ais_type smallint, ais_class char(1),
  status text default 'active' check (status in ('active','candidate','ignored')),
  discovery_reason jsonb,                   -- why flagged, for review queue
  first_seen timestamptz, last_seen timestamptz
);

create table regulations (
  id text primary key,                      -- 'srkw_buffer_2025'
  species species_t, buffer_m real,
  effective_from date, effective_to date,
  citation text, notes text
);

create table source_health (
  source text primary key,                  -- aisstream | acartia | receiver | tides
  last_message_at timestamptz, messages_last_hour int,
  status text, updated_at timestamptz
);

-- Positions & tracks ---------------------------------------------------
create table positions (
  mmsi bigint not null, ts timestamptz not null,
  geom geometry(Point,4326) not null,
  sog_kn real, cog_deg real, heading_deg real, nav_status smallint,
  source text not null, h3_r9 text,
  primary key (mmsi, ts)
);
create index positions_ts_brin on positions using brin (ts);

create table trips (                        -- one departure → return
  id uuid primary key default gen_random_uuid(),
  mmsi bigint references vessels(mmsi),
  region_id text references regions(id),
  start_ts timestamptz not null, end_ts timestamptz,   -- null = in progress
  status text check (status in ('live','complete','truncated')),
  path_full geometry(MultiLineStringM,4326),    -- split at gaps; M = epoch s
  path_simple geometry(MultiLineStringM,4326),  -- ~20 m tolerance, for replay
  path_overview geometry(MultiLineString,4326), -- ~100 m, for list thumbnails
  distance_nm real, max_sog_kn real, n_fixes int,
  loiter_minutes real, bbox geometry(Polygon,4326)
);
create index trips_time on trips (start_ts, end_ts);
create index trips_bbox on trips using gist (bbox);

-- Events ---------------------------------------------------------------
create table loiter_events (
  id uuid primary key default gen_random_uuid(),
  mmsi bigint references vessels(mmsi),
  trip_id uuid references trips(id),
  start_ts timestamptz not null, end_ts timestamptz not null,
  centroid geometry(Point,4326) not null, h3_r8 text not null,
  duration_min real not null, max_radius_m real, confidence real,
  encounter_id uuid                         -- set by clustering
);

create table sightings (
  id text primary key,                      -- source-native id
  source text not null,                     -- acartia | dwca | gbif | inat
  region_id text references regions(id),
  ts timestamptz not null,
  geom geometry(Point,4326),                -- nullable
  species species_t not null, pod text, count_est int,
  raw jsonb not null, h3_r8 text,
  encounter_id uuid
);

create table encounters (                   -- the unit of counting
  id uuid primary key default gen_random_uuid(),
  region_id text references regions(id),
  start_ts timestamptz, end_ts timestamptz,
  centroid geometry(Point,4326), hull geometry(Polygon,4326),
  h3_r8 text,                               -- cell of centroid
  species species_t,                        -- majority of linked sightings, else unknown
  n_sightings int, n_loiters int, n_vessels int,
  evidence text check (evidence in ('both','sightings_only','boats_only')),
  tide_height_m real, tide_phase text       -- flood | ebb | high | low
);

-- Normalization & output -----------------------------------------------
create table effort_cells (
  h3_r8 text, month date, operator_id uuid,
  hours_underway real,
  primary key (h3_r8, month, operator_id)
);

create table hotspot_cells (
  h3_r8 text, month_of_year smallint, species species_t, tide_phase text,
  encounters_n int, effort_hours real,
  rate_mean real, rate_lo real, rate_hi real, -- posterior mean + 80% CI
  evidence_mix jsonb,                        -- {both, sightings_only, boats_only}
  years_covered int, refreshed_at timestamptz,
  primary key (h3_r8, month_of_year, species, tide_phase)
);
```

**Retention:** keep `positions` forever at full resolution, since the volume is small (§6.1). Revisit if the region grows.

---

## 7. Algorithms

### 7.1 Ingest validation
- Reject invalid MMSIs (not 9 digits, or `000000000` / `111111111` / `123456789`).
- Reject impossible jumps: implied speed over 45 kn between consecutive fixes.
- Reject fixes inside the land mask by more than 50 m.
- Dedupe across sources on `(mmsi, ts ± 2 s, < 25 m)`. Priority: receiver, then AISStream, then AISHub.

### 7.2 Loiter detection (per MMSI, streaming)
A window counts as a loiter when the vessel is **outside** its home geofence and marinas, **SOG < 3 kn for ≥ 10 min** (tolerating spikes ≤ 6 kn lasting ≤ 60 s), and stays **within 1.5 km** of the running centroid.

Confidence rises with duration and tightness and falls when fix gaps exceed 5 min. Thresholds are provisional until tuned against the ground-truth set (Backlog B4).

### 7.3 Encounter clustering (nightly, plus streaming for the now-cast)
Space-time DBSCAN over the union of sightings (with coordinates) and loiter centroids:
- Neighborhood: **≤ 3 km and ≤ 90 min** (widen distance to **4 km if any `srkw` sighting** is involved, because of the buffer).
- `minPts = 1`: a lone sighting or loiter is a valid encounter, it just carries less evidence.
- Species is the majority label of the linked sightings, otherwise `unknown_cetacean`.
- `evidence` = both / sightings_only / boats_only.
- Tag each encounter with the tide height and phase at the nearest CO-OPS station.

### 7.4 Hotspot scoring (nightly)
For each `(h3_r8, month_of_year, species, tide_phase)`:

1. **Exposure** `E` = operator effort hours in the cell (from `effort_cells`), combined with observer exposure (`observer_weight`: kernel density of viewpoints, capped). Put both on one scale: `E = α·boat_hours + (1-α)·observer_weight·daylight_hours`, with `α` fitted in the Phase 0.5 notebook.
2. **Poisson–Gamma shrinkage:** `rate ~ Gamma(a + encounters, b + E)`. The prior `(a, b)` comes from the cell's **H3 k=1 ring and the region mean** (empirical Bayes). Sparse cells pull toward their neighbors instead of spiking.
3. Store the posterior mean and an 80% credible interval. The UI **shades by the lower bound** by default, so a cell only looks hot when it is confidently hot.
4. `evidence_mix` keeps the both / sightings-only / boats-only breakdown for the disagreement layer.

### 7.5 Now-cast (worker, every 30 s)
- Over live positions of registry vessels: find clusters of **≥ 2 vessels within 1.5 km, all with SOG < 4 kn for ≥ 5 min**, outside home geofences.
- Attach any Acartia sighting within 3 km and 2 h, and inherit its species.
- Broadcast clusters as `nowcast` events. The UI shows a pulsing ring with a vessel count and time since the cluster formed.
- Subject to the SRKW disclosure policy (§10).

---

## 8. Boat paths: plotting and replay

### 8.1 Live trails
- The client keeps a ring buffer of the last **30 min** of broadcast positions per vessel and renders it with `PathLayer`, fading by age (alpha ramps along the path).
- On first paint, `GET /api/live/trails?minutes=30` seeds the buffer. Realtime appends after that.
- Tapping a boat opens a bottom sheet with "Today's track", which loads the in-progress trip (§8.2).

### 8.2 Trip segmentation (worker + pg_cron)
A **trip** is a departure from a home geofence to the next return, or to more than 60 min of silence, which marks it `truncated`.
- **Gap handling:** a fix gap over **5 min**, or a straight line between consecutive fixes that crosses the land mask, starts a new line segment. That is why the path is a **MultiLineStringM**. The client draws gap joins as dashed lines (optional) and never as solid interpolation.
- **Build:** `ST_MakeLine(geom ORDER BY ts)` per segment, with M set to epoch seconds, then `ST_SimplifyPreserveTopology` at about 20 m (`path_simple`) and about 100 m (`path_overview`). Precompute distance, max SOG, and loiter minutes.
- **Live trips** (`status='live'`) are re-materialized every 5 min by pg_cron. Completed trips are immutable.
- **Backfill:** the same segmenter runs over the MarineCadastre data, so years of historical trips exist on day 1.

### 8.3 Path views

| View | What it shows | deck.gl layer |
|---|---|---|
| **Vessel day** (`/vessel/[mmsi]?date=`) | Every trip that day. Colored by **speed** (continuous ramp) or **mode** (transit / loiter / gap). Loiter segments are thickened and numbered, and linked sightings are drawn as pins. | `PathLayer` with per-vertex color (`getColor` from segment attributes) |
| **Replay** (`/replay?from=&to=&operators=`) | All registry vessels over a window (max 24 h), animated with a time scrubber. Sightings pop in at their timestamps, and now-cast clusters appear as they form. Speeds: 1×, 60×, 300×, 1200×. | **`TripsLayer`** (`currentTime`, `trailLength` ≈ 20 min of sim time) + `ScatterplotLayer` for sightings, filtered by `currentTime` |
| **Encounter view** (`/encounter/[id]`) | Every boat path that converged on one encounter (±60 min), with the sightings and the SRKW buffer ring if one applies | `PathLayer`, with the encounter hull as a `PolygonLayer` |
| **Cell drill-down** (`/cell/[h3]`) | Overview paths of trips that loitered in the cell, month-filterable, drawn at low opacity as a "desire lines" density view | `PathLayer` using `path_overview` |

**Interaction details:**
- The scrubber is a thumb-friendly timeline with sunrise/sunset shading and tick marks at encounters. Tapping a tick jumps playback there.
- Long-press on a path shows the point readout: time, SOG, COG, and the distance to the nearest sighting at that moment.
- Filter chips by operator and by vessel. The color legend switches between speed, vessel and operator.
- **Export:** GPX and GeoJSON for any trip or replay window (derived from `path_full`).

### 8.4 Payload format and performance
- The API returns deck.gl-ready trips: `{ id, mmsi, color, path: [[lon,lat],…], timestamps: [s,…] }`, with timestamps **relative to the window start**, so they fit in float32 precision.
- **Encoding:** delta-encoded integer coordinates (1e-5°) and timestamps, gzip/brotli via the CDN, decoded in a Web Worker on the client.
- **Budget:** about 20 vessels × 8 h × one fix per 10 s ≈ 58k raw points per day. After 20 m simplification that is about 5–8k points per day, around 60–100 KB compressed. That comfortably supports 24 h replay windows on a phone.
- **Level of detail:** the replay, vessel-day and encounter views use `path_simple`. List and cell views use `path_overview`. `path_full` is used only for export.
- Completed trips are served with long cache headers (`s-maxage=86400`, immutable). Live trips use `s-maxage=15`.

---

## 9. Next.js app

**Stack:** Next.js (App Router, TS), Tailwind, `react-map-gl/maplibre` + deck.gl, TanStack Query, Supabase JS (Realtime), Zod, and a PWA manifest.

### 9.1 Routes

| Route | Purpose |
|---|---|
| `/` | Live map: boats, trails, now-cast, sightings (last 6 h), SRKW rings |
| `/replay` | Multi-vessel animated replay with time scrubber (§8.3) |
| `/hotspots` | Hex map: month slider, species and tide-phase chips, confidence shading, disagreement toggle |
| `/vessel/[mmsi]` | Vessel card, day picker, trip list, vessel-day path view |
| `/trip/[id]` | Single-trip view and export |
| `/encounter/[id]` | Converging paths, sightings, buffer |
| `/cell/[h3]` | Cell drill-down: seasonality sparkline, encounter list, desire lines |
| `/admin/vessels` | Registry CRUD plus the candidate review queue (auth-gated) |

### 9.2 API (route handlers, CDN-cached)

| Endpoint | Returns | Cache |
|---|---|---|
| `GET /api/live/snapshot` | Latest position per active vessel, plus active now-cast clusters | 5 s |
| `GET /api/live/trails?minutes=30` | Seed trails for all active vessels | 5 s |
| `GET /api/sightings?since=` | Normalized sightings (policy-filtered, §10) | 60 s |
| `GET /api/trips?from=&to=&mmsi=&operator=&bbox=` | Trip list with summary stats and `path_overview` | 5 min / 1 day if all complete |
| `GET /api/trips/[id]?lod=simple\|full` | One trip, deck.gl format | 15 s live / 1 day complete |
| `GET /api/replay?from=&to=&operators=` | All trips intersecting the window (≤ 24 h), clipped to it, plus sightings in the window | 1 day if the window has ended |
| `GET /api/trips/[id]/export?fmt=gpx\|geojson` | File download | 1 day |
| `GET /api/encounters/[id]` | Encounter, linked sightings, linked loiters and their path slices | 1 h |
| `GET /api/hotspots?month=&species=&tide=` | `[{h3, rate_mean, rate_lo, rate_hi, n, evidence_mix}]` | 1 h |
| `GET /api/cells/[h3]` | Drill-down time series and overview paths | 1 h |

### 9.3 Mobile UX
- Full-screen map with a bottom sheet for details. Filters sit within thumb reach.
- "Near me" centers the map and lists the nearest viewpoints and active now-cast clusters.
- Sunlight-legible, high-contrast theme. No hover-only interactions. Replay controls sized for thumbs.
- A service worker caches the regional basemap, the last hotspot payload, and recently viewed trips.

---

## 10. SRKW location-disclosure policy

**The problem:** real-time positions of an endangered population on a public map can draw recreational boats onto the whales. That undercuts the 1,000-yard rule the app itself displays.

**The steel-manned counter-argument:** operators and Orca Network already publish this information in near-real-time, so the marginal harm is small, and delaying it degrades the product for shore watchers.

**Decision (v1 default):**
| Data | Public view | Signed-in / admin |
|---|---|---|
| SRKW sightings | Delayed **60 min**, snapped to an **H3 r7 cell (~5 km²)** | Real-time |
| Now-cast clusters with an SRKW link, **or** within 4 km of an SRKW sighting in the last 2 h | Suppressed until the delay elapses | Real-time |
| **Live boat positions and trails** within 4 km of an active SRKW encounter | Delayed 60 min | Real-time |
| Other species | Real-time | Real-time |
| Historical replay and paths older than 60 min | Unrestricted | Unrestricted |

Note the third row: without it, live boat trails and now-cast clusters would leak the orcas' location, and the sighting delay would be pointless. The policy lives in `regulations`/config and is enforced **server-side** in the API layer, never in the client. Revisit it with Orca Network and Acartia maintainers before a public launch.

---

## 11. Non-functional

| Area | Target |
|---|---|
| Live latency | AIS fix to map in under 10 s (p95). Now-cast in under 60 s from cluster formation. |
| Replay load | 24 h window interactive in under 2 s on a mid-range phone over LTE |
| Worker resilience | Exponential backoff and jitter on reconnect. Alert if no messages arrive for 15 min in daylight. |
| Source health | `source_health` table plus a UI status badge per feed |
| Observability | Structured logs (worker), Sentry (app and worker), counters for message rate, loiters, trips and encounters |
| Cost | Fly.io ~$5 + Supabase free/Pro + Vercel hobby + R2 (PMTiles) ≈ **under $30/mo** |
| Secrets | Upstream keys only in the worker. The client never calls upstream APIs. |
| Attribution | Acartia/Orca Network, salishsea-io, AISStream, NOAA, basemap. ⚠ VERIFY each source's redistribution terms. |
| Privacy | Registry vessels only. Non-registry MMSIs are kept only as candidate metadata and never displayed. |

---

## 12. Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Access** (week 1) | AISStream key; Acartia account + **historical access request**; WDFW public records request; bootstrap 5–10 operators and MMSIs; locate the DwC-A | Keys in hand; ≥ 5 vessels resolved; DwC-A downloaded |
| **0.5 — Signal spike** (notebook, ~1 week) | 30–90 days of MarineCadastre data for the box → trips + loiter detector → overlay on DwC-A sightings; plot a few vessel-days | **Go/no-go:** do loiters line up with sightings well above chance? If not, reshape the product (for example, sightings-first with boats as context). |
| **1 — History + scoring** | Full backfill (2–3 yrs) of positions → trips → loiters → encounters → effort → shrinkage scoring; tide tagging | Month slider shows plausible seasonality (gray whales in Saratoga Passage in spring; SRKW in the central Sound in fall) |
| **2 — App: live + paths** | Worker → Realtime; live trails; now-cast; vessel-day, trip and replay views; hotspots UI; disclosure policy enforced | Replay of a known whale day is visually convincing on a phone |
| **3 — Coverage** | Own receiver (Camano), AISHub, multi-source dedupe | Measurable gap reduction in the chosen channel |
| **4 — Polish** | PWA/offline, encounter and cell drill-downs, admin review queue, proximity alerts, exports | Daily-usable |

---

## 13. Risks and open questions

1. **The signal may not exist.** Phase 0.5 is the gate. Don't build UI before it passes.
2. **Registry coverage.** The boat layer is only as good as the registry. The WDFW request and behavioral discovery are both on the critical path.
3. **Few operator trips in Saratoga Passage.** Expect sightings to dominate there. The shrinkage and evidence-mix design handles the asymmetry honestly instead of hiding it.
4. **Loitering isn't always whales** (sea lions, eagles, lunch, breakdowns). Encounter linkage and confidence scoring mitigate this. Never label a boats-only encounter with a species.
5. **Feed reliability.** AISStream has no SLA. Keep ingest source-agnostic, and add the receiver in Phase 3.
6. **Terms of use.** Confirm that AISStream, Acartia and the DwC-A allow public redistribution. If they don't, gate the app behind auth or show only aggregates.
7. **Disclosure policy acceptance** (§10). Get community input before a public launch.

---

## 14. Backlog (post-v1)

| # | Item | Notes |
|---|---|---|
| B1 | Orcasound hydrophone detections (Bush Point, Whidbey) as a third, observer-independent signal | ⚠ VERIFY detection API access |
| B2 | Proximity alerts ("now-cast or sighting within X km of me") | Web Push via PWA; subject to §10 |
| B3 | Widen the region to Admiralty Inlet and the San Juans | Region config; revisit partitioning then |
| B4 | **Ground-truth set:** hand-label 10–15 days (whale present?, species) and track loiter precision and recall | Do this during Phase 0.5–1; it is what makes threshold tuning finishable |
| B5 | Operator scorecards (trips per week, loiter rate, compliance with buffers) | Sensitive: operators are also data partners. Keep internal. |
| B6 | Predictive "where tomorrow" model | Only after 2+ seasons of encounter data |

---

## 15. Reference links
- AISStream: https://aisstream.io
- Acartia: https://acartia.io · https://github.com/salish-sea/acartia
- Salish Sea data explorer (TS/Supabase prior art, DwC-A): https://github.com/salish-sea/salishsea-io
- NOAA MarineCadastre AIS: https://marinecadastre.gov/ais/
- NOAA CO-OPS API: https://api.tidesandcurrents.noaa.gov
- WDFW commercial whale watching: https://wdfw.wa.gov/licenses/commercial/whale-watching
- MapLibre · deck.gl `TripsLayer` · H3 · Protomaps: https://maplibre.org · https://deck.gl · https://h3geo.org · https://protomaps.com
