# Whaleboat — Technical Spec

**Status:** Draft v0.4 · 2026-09-28
**Owner:** Anderson
**One-liner:** A mobile-first web app that tracks whale-watching boats (AIS) and whale sightings across Seattle → Camano Island. It shows them live, replays boat paths, and computes seasonal whale-activity hotspots from de-duplicated *encounters*.

> Items marked **⚠ VERIFY** are assumptions about third-party APIs, data formats, or licenses. Confirm them before building against them.

### Changelog
- **v0.4:** Applied review fixes. Exposure no longer depends on whales being found. Realtime broadcasts now enforce the disclosure policy. Corrected the storage estimate and added a retention plan. Trips can start or end at the region boundary. Handled Class B AIS. Capped encounter size. Hotspots are now scored at H3 r7 with fewer slices. Sightings are deduped across sources. Track simplification is now time-aware. Trip and loiter logic has one shared implementation. The ground-truth set moved into Phase 0.5.
- **v0.3:** Added a global **time window** (§8.5). The map defaults to the last 48 h and can go further back where data exists. Replay max raised to 48 h. Encounters for the trailing 48 h are now re-clustered every 15 min. Added `/api/coverage`.
- **v0.2:** Hotspots are now scored on encounters instead of raw events. Added historical sighting sources that need no approval. Added a Phase 0.5 signal spike. Scoring now uses Bayesian shrinkage. Added a now-cast. Added **boat path plotting and replay** (§8). Simplified storage. Filled schema gaps. Added an SRKW location-disclosure policy. Added a backlog.
- **v0.1:** Initial draft.

---

## 1. Goals and non-goals

### Goals
1. **Live map.** Show whale-watch boats, their trails, and recent sightings in near-real-time, readable on a phone on a ferry deck. By default the map shows the **last 48 h**, and the user can move the window further back wherever history exists (§8.5).
2. **Now-cast.** Show where licensed boats are clustered and slow right now. This is the earliest real-time signal of where whales are.
3. **Boat paths.** Plot and replay any vessel's track, or all vessels over a time window, with loiter periods highlighted and sightings synced to the same timeline.
4. **Hotspot map.** Show where whale activity concentrates, split by month and species, scored on de-duplicated encounters with uncertainty shown.
5. **History on day 1.** Backfill from archives so hotspots and replays work without waiting a season.
6. **Cheap to run:** about $30/mo at hobby scale (§11).

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

**Trips that cross the boundary:** some operators' home ports are outside the box. La Conner is at about 48.39°N, and Port Townsend and the San Juans are further out. Their boats enter the box partway through a trip, so crossing the box boundary counts as a trip boundary (§8.2). AIS is ingested over a slightly larger box (0.1° wider on each side) so that entries and exits are caught cleanly.

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
| **NOAA MarineCadastre** | Historical backfill (tracks and loiters) | Bulk daily national files | Months behind | Free | ⚠ VERIFY the current format (zipped CSV historically; possibly GeoParquet for newer years). Includes vessel type and length, which are used for registry discovery (§4.3). ⚠ VERIFY the sampling interval: older years were published downsampled to 1-minute fixes. If so, tune loiter thresholds on live data resampled to the same interval, so historical and live loiters stay comparable. |

**AISStream subscription:**

```json
{
  "APIKey": "<key>",
  "BoundingBoxes": [[[47.50, -122.65], [48.30, -122.20]]],
  "FiltersShipMMSI": ["<registry MMSIs…>"],
  "FilterMessageTypes": ["PositionReport", "StandardClassBPositionReport",
                         "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport"]
}
```

⚠ VERIFY `FiltersShipMMSI` naming and limits. Fallback: subscribe to the whole box and filter in the worker. Candidate discovery (§4.3) needs box-wide static data anyway.

**Class A vs Class B:** small passenger vessels often carry Class B transponders. Class B vessels send their static data (name, dimensions) in message 24 (`StaticDataReport`), not message 5. They also report far less often: every 30 s above 2 kn and **every 3 min below 2 kn**. A slow Class B boat therefore produces only 3–4 fixes in 10 min. Loiter detection (§7.2), the now-cast (§7.5) and the storage estimate (§6.1) account for this. Record `ais_class` for every vessel. ⚠ VERIFY the AISStream message-type names.

### 4.2 Whale sightings

| Source | Role | Access | Notes |
|---|---|---|---|
| **Acartia** | Primary live sightings | REST, bearer token (`acartia.io/register` → dashboard). `GET /api/v1/sightings/current` (~7-day window) | Aggregates Orca Network and others. Sightings lag 5–30 min, and some have no coordinates. **Historical endpoints are approval-gated.** ⚠ VERIFY the schema. |
| **salishsea-io DarwinCore Archive** | **Historical sightings, no approval needed** | Nightly DwC-A published by the salish-sea project | Curated marine-mammal record, same scope as Acartia. ⚠ VERIFY the URL, temporal depth, and license. |
| **GBIF / OBIS** | Historical backstop | Public occurrence APIs, filtered by taxon and bounding box | Mixed quality. Use as a supplement and dedupe against the DwC-A. ⚠ VERIFY coverage for the box. |
| **iNaturalist** | Verified photo observations | Public REST API | Low volume, high confidence. Useful for species validation. |
| **Orca Network viewpoints** | Observer-bias correction and map context | Location list (already used by salishsea-io) | Input to `observer_weight` (§7.4). |

**Cross-source dedupe:** the same report often arrives more than once. Acartia and the DwC-A both carry Orca Network records, and research-grade iNaturalist observations also appear in GBIF. Each sighting keeps its source-native id. A dedupe pass links a duplicate to its canonical row (`duplicate_of`) when the species is compatible and the two are within 30 min and 2 km, using matching observer or text where available. Only canonical rows feed clustering and counts. Priority: Acartia, then DwC-A, then iNaturalist, then GBIF/OBIS.

**Position uncertainty:** shore reports are often located at the observer's town or viewpoint, not at the whale. Each sighting gets a `position_uncertainty_m`. It comes from the source when given. Otherwise it is estimated: about 500 m for a report with precise coordinates, and 2–5 km for one geocoded to a place name. Clustering and scoring are weighted by it (§7.3, §7.4).

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

**Tide phases:** `high` and `low` mean within ±1 h of the predicted high or low at the nearest station. Everything else is `flood` or `ebb`.

### 4.5 Regulatory overlays

- **SRKW 1,000-yard buffer** (RCW 77.15.740, year-round). Used for:
  1. association distance in encounter clustering (boats sit about 0.5 nm off orcas),
  2. a "Be Whale Wise" ring layer in the UI.
- Rules are stored as data in `regulations` (§6.2), because WDFW updates them.
- ⚠ VERIFY the current WDFW rules on **commercial** viewing of SRKW. They have tightened in recent years. If licensed operators are restricted from approaching SRKW, the boat signal says little about SRKW, and SRKW hotspots would come almost entirely from sightings (§13, risk 8).

---

## 5. Mapping stack

| Layer | Choice | Why |
|---|---|---|
| Renderer | **MapLibre GL JS** (`react-map-gl/maplibre`) | Open source, no per-load fees, good on mobile |
| Basemap | **Protomaps PMTiles** on R2 (or OpenFreeMap) | Free vector tiles; a single file, no tile server |
| Nautical context (toggle) | NOAA chart tiles | ⚠ VERIFY the endpoint and terms. Optional. |
| Bathymetry (optional) | NOAA NCEI Puget Sound DEM → contours as vector tiles | Feeding-flat context. Generated once, offline. |
| Overlays | **deck.gl** via `@deck.gl/mapbox` (interleaved) | `H3HexagonLayer` (hotspots), `PathLayer` (static tracks), **`TripsLayer`** (animated replay), `ScatterplotLayer` (sightings and boats), `IconLayer` (vessel heading) |
| Spatial index | **H3** (`h3-js`): r7 (~5 km²) for hotspot scoring, r8 (~0.7 km²) for loiters and display, r9 for drill-down | Uniform cells, native deck.gl layer. Scoring uses r7 because sighting positions can be off by kilometres and loiters span up to 1.5 km, so r8 is finer than the data. |

**UI layers:**
1. Live boats (heading icon) plus live trail (§8.1)
2. **Now-cast clusters** (§7.5)
3. Sightings in the active time window (species color, fade by age relative to the window end)
4. SRKW buffer rings
5. **Tracks in the active time window, and replay** (§8)
6. Hotspot hexes (month slider, species filter or a separate tide view, credible-interval shading)
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
   │ • trip segmenter (sole writer of trips) • now-cast clusterer (30 s)   │
   │ • Realtime broadcast: public (policy-filtered, §10) + private         │
   └──────────────────────────────┬───────────────────────────────────────┘
                                  ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │ Supabase Postgres + PostGIS                                           │
   │ positions · trips · loiter_events · sightings · encounters            │
   │ effort_cells · hotspot_cells · registry · regulations · source_health │
   │ pg_cron: encounters, trailing 48 h (15 min),                          │
   │          encounters + hotspots (nightly)                              │
   └──────────┬───────────────────────────────────────┬───────────────────┘
              │                                       │
   ┌──────────▼────────────────┐        ┌─────────────▼─────────────────────┐
   │ Next.js (App Router)      │        │ Batch / notebooks                 │
   │ Vercel                    │        │ MarineCadastre + DwC-A → DuckDB → │
   │ • RSC pages, cached APIs  │        │ filter → tracks CLI → PG          │
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
| Live push | **Realtime Broadcast** from the worker on two channels: `public` (disclosure policy applied by the worker, §10) and `private` (Realtime Authorization, signed-in users) | Avoids CDC on a high-write table. Broadcasts never pass through the API layer, so the worker has to enforce the policy itself. |
| Storage | **Plain `positions` table + BRIN on `ts`**, no partitioning, **90-day retention** | At most ~58k fixes/day (20 vessels × 8 h × a fix every 10 s if every vessel is Class A; Class B vessels report less). That is ≈ 21M rows/yr, or ≈ 3–4 GB/yr with the primary-key index. It passes Supabase's free tier (500 MB) within the first couple of months, so plan on Pro, and keep raw positions for 90 days only. `trips` hold the long-term history (§6.2). Partition only if the region grows. |
| Track storage | **Precomputed `trips`** with `LineStringM` (M = epoch seconds) at two simplification tolerances | Replay and path queries read one row per trip instead of thousands of points (§8.2) |
| History | **DuckDB** over MarineCadastre and the DwC-A, loading only filtered rows | Never load national files raw. DuckDB only filters. Trip segmentation and loiter detection then run through the same code as live ingest (next row). |
| Shared track logic | **One TS package** (`@whaleboat/tracks`) for validation, trip segmentation, loiter detection and simplification. The worker uses it in streaming mode, and a backfill CLI replays historical fixes through it in time order. | Separate streaming (TS) and batch (SQL/Python) versions would drift apart, and backfilled and live loiters would stop being comparable |
| Trip ownership | **The worker** is the only writer of `trips`: it opens trips, rewrites live ones every 5 min, and closes them | One writer. pg_cron doesn't touch trips. |
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

create table disclosure_policy (           -- §10; exactly one active row
  id text primary key,                      -- 'v1_default'
  active boolean not null default false,
  delay_min int not null default 60,        -- public delay for SRKW-linked data
  snap_h3_res smallint not null default 7,  -- public SRKW sighting precision
  srkw_link_radius_m real not null default 4000
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
create index positions_ts_brin on positions using brin (ts);  -- 90-day retention

create table candidate_positions (          -- non-registry passenger vessels (§4.3)
  mmsi bigint not null, ts timestamptz not null,
  geom geometry(Point,4326) not null, sog_kn real,
  primary key (mmsi, ts)
);                                          -- purged after 14 days; never served

create table trips (                        -- one departure → return
  id uuid primary key default gen_random_uuid(),
  mmsi bigint references vessels(mmsi),
  region_id text references regions(id),
  start_ts timestamptz not null, end_ts timestamptz,   -- null = in progress
  status text check (status in ('live','complete','truncated','partial')),  -- partial: crossed the region box (§8.2)
  path_full geometry(MultiLineStringM,4326),    -- split at gaps; M = epoch s
  path_simple geometry(MultiLineStringM,4326),  -- ~20 m, time-aware (§8.2), for replay
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
  position_uncertainty_m real,              -- §4.2
  species species_t not null, pod text, count_est int,
  raw jsonb not null, h3_r8 text,
  duplicate_of text references sightings(id),  -- cross-source dedupe (§4.2)
  encounter_id uuid
);

create table encounters (                   -- the unit of counting
  id uuid primary key default gen_random_uuid(),
  region_id text references regions(id),
  start_ts timestamptz, end_ts timestamptz,
  centroid geometry(Point,4326), hull geometry(Polygon,4326),
  h3_r8 text, h3_r7 text,                   -- cells of centroid (display, scoring)
  provisional boolean default true,         -- false once finalized nightly (§7.3)
  species species_t,                        -- majority of linked sightings, else unknown
  n_sightings int, n_loiters int, n_vessels int,
  evidence text check (evidence in ('both','sightings_only','boats_only')),
  tide_height_m real, tide_phase text       -- flood | ebb | high | low
);

-- Normalization & output -----------------------------------------------
create table effort_cells (                 -- effort that doesn't depend on finding whales (§7.4)
  h3_r7 text, month date, operator_id uuid,
  transit_hours real,                       -- underway time, excluding loiters
  trips_passing int,                        -- trips whose track came within 5 km
  primary key (h3_r7, month, operator_id)
);

create table hotspot_cells (
  h3_r7 text, month_of_year smallint,
  species text,                             -- a species_t value, or 'all'
  tide_phase text,                          -- flood | ebb | high | low, or 'all'
  encounter_credit real, exposure real,     -- §7.4
  rate_mean real, rate_lo real, rate_hi real, -- posterior mean + 80% CI
  evidence_mix jsonb,                        -- {both, sightings_only, boats_only}
  years_covered int, refreshed_at timestamptz,
  primary key (h3_r7, month_of_year, species, tide_phase)
);
```

**Retention:** raw `positions` are deleted after **90 days**. `trips` keep `path_simple` and `path_overview` forever, which is all the history views need (§8.5). `path_full` is kept for 1 year and then set to null, and exports of older trips fall back to `path_simple`. `candidate_positions` are purged after 14 days. With these settings the database should stay well inside Supabase Pro's included 8 GB for several years. Historical backfill fixes stay in DuckDB/Parquet and never enter `positions`.

---

## 7. Algorithms

### 7.1 Ingest validation
- Reject invalid MMSIs (not 9 digits, or `000000000` / `111111111` / `123456789`).
- Reject impossible jumps: implied speed over 45 kn between consecutive fixes.
- Reject fixes more than 50 m inside the land mask, except within home geofences and marinas. Docked boats often plot on land because of GPS error and coastline resolution.
- Dedupe across sources on `(mmsi, ts ± 2 s, < 25 m)`. Priority: receiver, then AISStream, then AISHub.

### 7.2 Loiter detection (per MMSI, streaming)
A window counts as a loiter when the vessel is **outside** its home geofence and marinas, **SOG < 3 kn for ≥ 10 min** (tolerating spikes ≤ 6 kn lasting ≤ 60 s), and stays **within 1.5 km** of the running centroid.

Slow Class B boats report only every 3 min (§4.1), so the detector works on elapsed time, not fix counts. A loiter needs at least 3 fixes spanning ≥ 10 min. Confidence rises with duration and tightness. It falls when a gap is more than twice the vessel's expected reporting interval: 10 s for Class A, 30 s for Class B above 2 kn, and 3 min for Class B below 2 kn. Thresholds are provisional until tuned against the ground-truth set (Phase 0.5, §12).

### 7.3 Encounter clustering (every 15 min over the trailing 48 h, nightly for older data, plus streaming for the now-cast)
Space-time DBSCAN over the union of canonical sightings (with coordinates and `duplicate_of is null`, §4.2) and loiter centroids:
- Neighborhood: **≤ 3 km and ≤ 90 min** (widen distance to **4 km if any `srkw` sighting** is involved, because of the buffer).
- `minPts = 1`: a lone sighting or loiter is a valid encounter, it just carries less evidence.
- **Size caps:** with `minPts = 1`, clusters chain together. A pod reported every 30 min while travelling 20 km would become one encounter with its centroid in the middle. An encounter is therefore split when it lasts more than **3 h** or its members span more than **8 km**. Scoring also credits each member's own cell, not only the centroid's (§7.4).
- **Position uncertainty:** the distance test for a sighting uses the larger of 3 km and its `position_uncertainty_m`. In scoring, a sighting is weighted down when its uncertainty is larger than an r7 cell (edge ≈ 1.2 km).
- Species is the majority label of the linked sightings, otherwise `unknown_cetacean`.
- `evidence` = both / sightings_only / boats_only.
- Tag each encounter with the tide height and phase at the nearest CO-OPS station.
- **Recent window:** pg_cron re-clusters the trailing 48 h every 15 min, so the default map view (§8.5) always has current encounters. These rows are provisional: a re-run may merge or split them. The nightly job finalizes everything older than 48 h, after which encounters are stable.

### 7.4 Hotspot scoring (nightly)

**Slices.** Scoring every combination of month × species × tide phase would leave most cells with zero or one encounter. Only two cuts are scored:
- `(h3_r7, month_of_year, species)` with `tide_phase = 'all'`. `species` includes `'all'`.
- `(h3_r7, month_of_year, tide_phase)` with `species = 'all'`. This is the tide view.

For each slice:

1. **Encounter credit.** Each encounter spreads a credit of 1 across its members' r7 cells, with sightings weighted by position uncertainty (§7.3). A travelling pod therefore counts along its path, not only at its centroid. `boats_only` encounters count only toward `species = 'all'`, because they have no species.
2. **Exposure** `E` must not depend on whether whales were found. Operators go where whales have been reported, so hours spent in a cell partly measure the whales themselves. Dividing by those hours would flatten real hotspots. Instead:
   - **Boat exposure:** `transit_hours` from `effort_cells` (time underway, **excluding loiters**), or `trips_passing` (trips whose track came within 5 km of the cell). Compare both in Phase 0.5 and keep whichever scores better against the ground-truth set.
   - **Observer exposure:** `observer_weight` (kernel density of viewpoints, capped) × daylight hours.
   - Combined: `E = α·boat_exposure + (1-α)·observer_exposure`. `α` is fitted in Phase 0.5 by maximizing the held-out likelihood of the ground-truth labels (§12). Species slices get their own `α`, because their encounters come mostly from sightings.
3. **Poisson–Gamma shrinkage:** `rate ~ Gamma(a + credit, b + E)`. The prior `(a, b)` comes from the cell's **H3 k=1 ring and the region mean** in the same slice (empirical Bayes). Sparse cells pull toward their neighbors instead of spiking.
4. Store the posterior mean and an 80% credible interval. The UI **shades by the lower bound** by default, so a cell only looks hot when it is confidently hot.
5. `evidence_mix` keeps the both / sightings-only / boats-only breakdown for the disagreement layer.

### 7.5 Now-cast (worker, every 30 s)
- Over live positions of registry vessels: find clusters of **≥ 2 vessels within 1.5 km, all with SOG < 4 kn for ≥ 5 min**, outside home geofences. A slow Class B boat may send only one or two fixes in 5 min (§4.1), so it counts as slow if its last fix was under 4 kn and no faster fix has arrived within its expected reporting interval.
- Attach any Acartia sighting within 3 km and 2 h, and inherit its species.
- Broadcast clusters as `nowcast` events. The UI shows a pulsing ring with a vessel count and time since the cluster formed.
- Subject to the SRKW disclosure policy (§10), which the worker applies before broadcasting on the public channel.

---

## 8. Boat paths: plotting and replay

### 8.1 Live trails
- The client keeps a ring buffer of the last **30 min** of broadcast positions per vessel and renders it with `PathLayer`, fading by age (alpha ramps along the path).
- On first paint, `GET /api/live/trails?minutes=30` seeds the buffer. Realtime appends after that.
- Tapping a boat opens a bottom sheet with "Today's track", which loads the in-progress trip (§8.2).

### 8.2 Trip segmentation (worker)
A **trip** starts with a departure from a home geofence **or an entry into the region box**. It ends at the next return, an **exit from the box**, or more than 60 min of silence. A trip that starts or ends at the box boundary is `partial`, and one that ends in silence is `truncated`. (Some home ports, such as La Conner, are outside the box, §3.)
- **Gap handling:** a fix gap over **5 min**, or a straight line between consecutive fixes that crosses the land mask, starts a new line segment. That is why the path is a **MultiLineStringM**. The client draws gap joins as dashed lines (optional) and never as solid interpolation.
- **Build** (in the shared track package, §6.1): one line per segment with M set to epoch seconds, combined into a MultiLineStringM. In SQL terms, that is `ST_MakeLine(geom ORDER BY ts)` per segment, then `ST_Collect`/`ST_Multi`. Precompute distance (on `geography`), max SOG, and loiter minutes.
- **Simplification:** tolerances are in metres, so simplify in UTM 10N (EPSG:32610) and transform back. In EPSG:4326 the tolerance would be read as degrees.
  - `path_simple` (~20 m) must be **time-aware**. Plain Douglas–Peucker ignores time: a boat that stops for 30 min on a straight line would lose those points, and the replay would show it moving steadily through the stop. Use synchronized Euclidean distance (SED) simplification, or always keep vertices where speed changes by more than 2 kn and where a loiter starts or ends.
  - `path_overview` (~100 m) is only drawn statically, so plain Douglas–Peucker is fine there.
- **Live trips** (`status='live'`) are rewritten every 5 min by the worker, which is the only writer of `trips`. Completed trips are immutable.
- **Backfill:** the same segmenter code (the shared track package) runs over the MarineCadastre data, so years of historical trips exist on day 1.

### 8.3 Path views

| View | What it shows | deck.gl layer |
|---|---|---|
| **Vessel day** (`/vessel/[mmsi]?date=`) | Every trip that day. Colored by **speed** (continuous ramp) or **mode** (transit / loiter / gap). Loiter segments are thickened and numbered, and linked sightings are drawn as pins. | `PathLayer` with per-vertex color (`getColor` from segment attributes) |
| **Replay** (`/replay?from=&to=&operators=`) | All registry vessels over a window (max 48 h, default the last 48 h), animated with a time scrubber. Sightings pop in at their timestamps, and now-cast clusters appear as they form. Speeds: 1×, 60×, 300×, 1200×. | **`TripsLayer`** (`currentTime`, `trailLength` ≈ 20 min of sim time) + `ScatterplotLayer` for sightings, filtered by `currentTime` |
| **Encounter view** (`/encounter/[id]`) | Every boat path that converged on one encounter (±60 min), with the sightings and the SRKW buffer ring if one applies | `PathLayer`, with the encounter hull as a `PolygonLayer` |
| **Cell drill-down** (`/cell/[h3]`) | Overview paths of trips that loitered in the cell, month-filterable, drawn at low opacity as a "desire lines" density view | `PathLayer` using `path_overview` |

**Interaction details:**
- The scrubber is a thumb-friendly timeline with sunrise/sunset shading and tick marks at encounters. Tapping a tick jumps playback there.
- Long-press on a path shows the point readout: time, SOG, COG, and the distance to the nearest sighting at that moment.
- Filter chips by operator and by vessel. The color legend switches between speed, vessel and operator.
- **Export:** GPX and GeoJSON for any trip or replay window (derived from `path_full`).

### 8.4 Payload format and performance
- The API returns deck.gl-ready trips: `{ id, mmsi, color, path: [[lon,lat],…], timestamps: [s,…] }`, with timestamps **relative to the window start**, so they fit in float32 precision.
- **Encoding:** plain JSON, compressed with gzip/brotli by the CDN. At these payload sizes a custom encoding isn't worth it. Revisit delta-encoded integers decoded in a Web Worker only if replay misses its load target (§11).
- **Budget:** about 20 vessels × 8 h × one fix per 10 s ≈ 58k raw points per day at most (Class B vessels report less often). After 20 m simplification that is about 5–8k points per day, around 60–100 KB compressed, so the default 48 h window is about 120–200 KB. That is fine on a phone. Windows longer than 48 h use `path_overview` instead (§8.5).
- **Level of detail:** the replay, vessel-day and encounter views use `path_simple`. List and cell views use `path_overview`. `path_full` is used only for export.
- Completed trips are served with long cache headers (`s-maxage=86400`, immutable). Live trips use `s-maxage=15`.

### 8.5 Time window and history

The whole map shares one **time window**. The default is **the last 48 h, ending now**. The user can widen it or move it into the past wherever data exists.

**Control:** a compact chip on the map ("Last 48 h ▾") opens a bottom sheet with:
- Presets: **48 h** (default) · 7 d · 30 d · this season · custom range (date pickers).
- A "jump to date" picker that keeps the current window length.
- A **coverage strip** above the timeline showing where boat and sighting data exist (from `/api/coverage`). Ranges without data are greyed out and labelled, for example "Boat history not yet available: MarineCadastre lags about N months".
- A "Back to live" button whenever the window doesn't end now.

The window is stored in the URL (`?window=48h`, or `?from=&to=`) so views can be shared and bookmarked.

**How each layer uses the window:**

| Layer | Last 48 h (default) | Longer or older windows |
|---|---|---|
| Live boats and 30-min live trails | Shown | Hidden unless the window ends now |
| Now-cast clusters | Shown (live only) | Not shown. Past activity appears as encounters. |
| Boat tracks | Full tracks (`path_simple`), animatable in replay | ≤ 7 d: static `path_overview` tracks colored by day. > 7 d: a density ("desire lines") view instead of individual tracks. Tapping a day opens a 48 h replay there. |
| Sightings | Every sighting, fading by age | Shown as points, clustered at low zoom when there are many |
| Encounters | Provisional (15-min re-clustering, §7.3) | Final (nightly) |
| SRKW buffer rings | Around SRKW sightings in the last 2 h | Not shown |
| Hotspots | Unaffected: they aggregate by month across all years (§7.4) | Optional filter by year range |

**Where history exists:**
- *Boats:* from the start of live ingest, plus the MarineCadastre backfill (2–3 years, months behind). The gap between the backfill's end and the start of live ingest has no boat data, and the coverage strip shows it.
- *Sightings:* live Acartia (~7 days) plus the DwC-A, GBIF/OBIS and iNaturalist history.
- *Encounters:* wherever either of the above exists.

**Caching:** a rolling "last 48 h" window changes every second, so the API rounds `to` down to the nearest 5 min for cache keys. It returns completed trips by ID (immutable, cached for a day) and only the live tail uncached, so a 48 h view costs little more than a live one. Fixed past windows are cached for a day.

**Disclosure (§10):** the policy applies to the most recent 60 min of any window. Older data in the window is unrestricted.

---

## 9. Next.js app

**Stack:** Next.js (App Router, TS), Tailwind, `react-map-gl/maplibre` + deck.gl, TanStack Query, Supabase JS (Realtime), Zod, and a PWA manifest.

### 9.1 Routes

| Route | Purpose |
|---|---|
| `/` | Live map: boats, trails, now-cast, sightings and tracks for the time window (default last 48 h, §8.5), SRKW rings |
| `/replay` | Multi-vessel animated replay with time scrubber (§8.3) |
| `/hotspots` | Hex map (r7): month slider, species chips or a tide-phase view, confidence shading, disagreement toggle |
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
| `GET /api/sightings?from=&to=` | Normalized sightings in the window (default last 48 h; policy-filtered, §10) | 60 s rolling / 1 day for past windows |
| `GET /api/trips?from=&to=&mmsi=&operator=&bbox=` | Trip list with summary stats and `path_overview` | 5 min / 1 day if all complete |
| `GET /api/trips/[id]?lod=simple\|full` | One trip, deck.gl format | 15 s live / 1 day complete |
| `GET /api/replay?from=&to=&operators=` | All trips intersecting the window (≤ 48 h, default the last 48 h), clipped to it, plus sightings in the window | 1 day if the window has ended |
| `GET /api/history?from=&to=&layers=` | For windows longer than 48 h: overview tracks (≤ 7 d) or a track density grid (> 7 d), plus sightings and encounters | 1 day for past windows |
| `GET /api/coverage` | Date ranges with data for each source (live AIS, MarineCadastre, Acartia, DwC-A, …), for the coverage strip | 1 h |
| `GET /api/trips/[id]/export?fmt=gpx\|geojson` | File download | 1 day |
| `GET /api/encounters/[id]` | Encounter, linked sightings, linked loiters and their path slices | 1 h |
| `GET /api/hotspots?month=&species=&tide=` | `[{h3, rate_mean, rate_lo, rate_hi, n, evidence_mix}]` at r7. `species` and `tide` default to `all`, and at least one of them must be `all` (§7.4). | 1 h |
| `GET /api/cells/[h3]` | Drill-down time series and overview paths | 1 h |

**Caching and auth:** anything the CDN caches is the public, policy-filtered version. Signed-in requests use the same endpoints but get `Cache-Control: private, no-store` and are never stored at the CDN. Real-time SRKW data therefore can't leak into the shared cache.

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
| **Live boat positions and trails** of **every registry vessel in the same sub-region** as an active SRKW encounter | Delayed 60 min | Real-time |
| Other species | Real-time | Real-time |
| Historical replay and paths older than 60 min | Unrestricted | Unrestricted |

Note the third row: without it, live boat trails and now-cast clusters would leak the orcas' location, and the sighting delay would be pointless. It covers the whole sub-region, not only boats near the whales. If only nearby boats were delayed, the public would see known boats vanish from one spot, which would reveal the location just as well.

**Enforcement:** the settings live in `disclosure_policy` (§6.2). The policy is enforced **server-side, never in the client**, in two places:
1. **The worker**, for Realtime. Public-channel broadcasts are filtered and delayed before they are sent. Signed-in users subscribe to a private channel protected by Realtime Authorization.
2. **The API layer**, for everything else. CDN-cached responses are always the public version (§9.2).

Revisit the policy with Orca Network and Acartia maintainers before a public launch.

---

## 11. Non-functional

| Area | Target |
|---|---|
| Live latency | AIS fix to map in under 10 s (p95). Now-cast in under 60 s from cluster formation. |
| Replay load | Default 48 h window interactive in under 2 s on a mid-range phone over LTE. History windows up to 30 d in under 3 s. |
| Worker resilience | Exponential backoff and jitter on reconnect. Alert if no messages arrive for 15 min in daylight. |
| Source health | `source_health` table plus a UI status badge per feed |
| Observability | Structured logs (worker), Sentry (app and worker), counters for message rate, loiters, trips and encounters |
| Cost | Fly.io ~$5 + Supabase Pro $25 + Vercel hobby + R2 (PMTiles, free tier) ≈ **$30/mo**. Pro is needed once positions pass the free tier's 500 MB, within the first couple of months (§6.1). The budget has no headroom. |
| Secrets | Upstream keys only in the worker. The client never calls upstream APIs. |
| Attribution | Acartia/Orca Network, salishsea-io, AISStream, NOAA, basemap. ⚠ VERIFY each source's redistribution terms. |
| Privacy | Only registry vessels are displayed. Behavioral discovery needs positions of non-registry passenger vessels, so those go to `candidate_positions`, are purged after 14 days, and are never served by the API. All other non-registry vessels are dropped at ingest. |

---

## 12. Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Access** (week 1) | AISStream key; Acartia account + **historical access request**; WDFW public records request; bootstrap 5–10 operators and MMSIs; locate the DwC-A | Keys in hand; ≥ 5 vessels resolved; DwC-A downloaded |
| **0.5 — Signal spike** (~2 weeks) | 30–90 days of MarineCadastre data for the box → trips + loiter detector (shared track package) → overlay on DwC-A sightings; plot a few vessel-days. **Build the ground-truth set:** hand-label 10–15 days (whale present?, species). Use it to measure loiter precision and recall, compare the two boat-exposure measures, and fit `α` (§7.4). | **Go/no-go:** do loiters line up with sightings and the ground-truth labels well above chance? If not, reshape the product (for example, sightings-first with boats as context). |
| **1 — History + scoring** | Full backfill (2–3 yrs) of historical fixes → trips (raw fixes stay in DuckDB/Parquet) → loiters → encounters → effort → shrinkage scoring; tide tagging | Month slider shows plausible seasonality (gray whales in Saratoga Passage in spring; SRKW in the central Sound in fall), **and** boats-only and both-evidence encounters show seasonality too. The SRKW pattern may come almost entirely from sightings (§4.5), so on its own it doesn't show that the boat signal works. |
| **2 — App: live + paths** | Worker → Realtime; live trails; now-cast; 48 h default window and time control with coverage strip (§8.5); vessel-day, trip and replay views; hotspots UI; disclosure policy enforced | Replay of a known whale day is visually convincing on a phone |
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
8. **Boats may barely cover SRKW.** If commercial operators are restricted from viewing SRKW (§4.5), the boat signal is mostly Bigg's and humpbacks, and SRKW hotspots rest on sightings alone. Show this through the evidence mix instead of implying boat support.

---

## 14. Backlog (post-v1)

| # | Item | Notes |
|---|---|---|
| B1 | Orcasound hydrophone detections (Bush Point, Whidbey) as a third, observer-independent signal | ⚠ VERIFY detection API access |
| B2 | Proximity alerts ("now-cast or sighting within X km of me") | Web Push via PWA; subject to §10 |
| B3 | Widen the region to Admiralty Inlet and the San Juans | Region config; revisit partitioning then |
| B4 | Ground-truth set | Moved into Phase 0.5 (§12). It is needed to tune thresholds and fit `α`. |
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
