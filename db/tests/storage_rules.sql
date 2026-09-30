-- Tests for the storage rules in db/migrations (ingest_ais, retention, the
-- whale-watch registry). Everything runs in one transaction that is rolled
-- back, using made-up MMSIs (999xxxxxx), so it is safe against the live
-- database. The final SELECT lists each check with pass = true/false.
--
-- Run it with the Supabase MCP `execute_sql` tool, or:
--   psql "$DATABASE_URL" -f db/tests/storage_rules.sql

begin;

create temp table results (n serial, name text, pass boolean, detail text) on commit drop;

-- Fixtures ------------------------------------------------------------------------
-- 999000001 tug (excluded type)           999000002 tug, but in the registry
-- 999000003 pleasure craft, moored        999000004 passenger vessel
-- 999000005 pleasure craft, BLACKFISH name pattern
insert into public.whale_watch_vessels (mmsi, name, operator) values (999000002, 'Test Registry Tug', 'Test Operator');

select public.ingest_ais('[]'::jsonb, '[
  {"mmsi": 999000001, "name": "TEST TUG", "cls": "A", "ship_type": 52, "length_m": 20},
  {"mmsi": 999000002, "name": "TEST REGISTRY TUG", "cls": "A", "ship_type": 52, "length_m": 20},
  {"mmsi": 999000003, "name": "TEST PLEASURE", "cls": "B", "ship_type": 37, "length_m": 10},
  {"mmsi": 999000004, "name": "TEST FERRY", "cls": "A", "ship_type": 60, "length_m": 50},
  {"mmsi": 999000005, "name": "BLACKFISH TEST", "cls": "B", "ship_type": 37, "length_m": 12}
]'::jsonb);

-- t0 = one hour ago, as epoch seconds.
create temp table t0 on commit drop as select extract(epoch from now() - interval '1 hour')::double precision as t;

-- Type filter ----------------------------------------------------------------------
select public.ingest_ais(jsonb_build_array(
  jsonb_build_object('mmsi', 999000001, 't', (select t from t0), 'lon', -122.5, 'lat', 48.1, 'sog', 8, 'cog', 90),
  jsonb_build_object('mmsi', 999000002, 't', (select t from t0), 'lon', -122.5, 'lat', 48.1, 'sog', 8, 'cog', 90)
), '[]'::jsonb);
insert into results (name, pass) values
  ('excluded type (tug) is not stored', not exists (select 1 from public.positions where mmsi = 999000001)),
  ('registry boat is stored even with an excluded type', exists (select 1 from public.positions where mmsi = 999000002));

-- Stationary thinning (15 min) -------------------------------------------------------------
select public.ingest_ais(jsonb_build_array(
  jsonb_build_object('mmsi', 999000003, 't', (select t from t0), 'lon', -122.6, 'lat', 48.2, 'sog', 0, 'cog', 0)), '[]'::jsonb);
select public.ingest_ais(jsonb_build_array(
  jsonb_build_object('mmsi', 999000003, 't', (select t from t0) + 300, 'lon', -122.6, 'lat', 48.2, 'sog', 0.2, 'cog', 0)), '[]'::jsonb);
select public.ingest_ais(jsonb_build_array(
  jsonb_build_object('mmsi', 999000003, 't', (select t from t0) + 360, 'lon', -122.6, 'lat', 48.2, 'sog', 5, 'cog', 0)), '[]'::jsonb);
select public.ingest_ais(jsonb_build_array(
  jsonb_build_object('mmsi', 999000003, 't', (select t from t0) + 420, 'lon', -122.6, 'lat', 48.2, 'sog', null, 'cog', null)), '[]'::jsonb);
select public.ingest_ais(jsonb_build_array(
  jsonb_build_object('mmsi', 999000003, 't', (select t from t0) + 1380, 'lon', -122.6, 'lat', 48.2, 'sog', 0, 'cog', 0)), '[]'::jsonb);
select public.ingest_ais(jsonb_build_array(
  jsonb_build_object('mmsi', 999000003, 't', (select t from t0) + 1380 + 600, 'lon', -122.6, 'lat', 48.2, 'sog', 0, 'cog', 0)), '[]'::jsonb);
select public.ingest_ais(jsonb_build_array(
  jsonb_build_object('mmsi', 999000003, 't', (select t from t0) + 1380 + 901, 'lon', -122.6, 'lat', 48.2, 'sog', 0, 'cog', 0)), '[]'::jsonb);
-- Offsets (s): 0 kept (first) · 300 dropped (still, 5 min after 0) · 360 kept (moving)
-- · 420 kept (speed unknown) · 1380 kept (16 min after 420) · 1980 dropped
-- (10 min after 1380) · 2281 kept (15 min 1 s after 1380).
insert into results (name, pass, detail)
select 'stationary thinning keeps first, moving, unknown-speed, and 15-min-apart fixes',
  array_agg(round(extract(epoch from ts) - (select t from t0))::int order by ts) = array[0, 360, 420, 1380, 2281],
  array_agg(round(extract(epoch from ts) - (select t from t0))::int order by ts)::text
from public.positions where mmsi = 999000003;

-- Duplicates and vessel merging -------------------------------------------------------
select public.ingest_ais(jsonb_build_array(
  jsonb_build_object('mmsi', 999000004, 't', (select t from t0), 'lon', -122.4, 'lat', 48.0, 'sog', 10, 'cog', 180),
  jsonb_build_object('mmsi', 999000004, 't', (select t from t0), 'lon', -122.4, 'lat', 48.0, 'sog', 10, 'cog', 180)
), '[{"mmsi": 999000004, "name": null, "cls": null, "ship_type": null, "length_m": null}]'::jsonb);
insert into results (name, pass) values
  ('a repeated position is stored once', (select count(*) = 1 from public.positions where mmsi = 999000004)),
  ('a vessel update with nulls keeps the known fields',
    (select name = 'TEST FERRY' and ais_type = 60 and ais_class = 'A' and length_m = 50 from public.vessels where mmsi = 999000004));

-- Helper functions ---------------------------------------------------------------------
insert into results (name, pass) values
  ('ais_type_excluded: tug/cargo/tanker/military/pilot yes',
    public.ais_type_excluded(31::smallint) and public.ais_type_excluded(52::smallint) and public.ais_type_excluded(70::smallint)
    and public.ais_type_excluded(89::smallint) and public.ais_type_excluded(35::smallint) and public.ais_type_excluded(50::smallint)),
  ('ais_type_excluded: passenger/fishing/pleasure/sailing/unknown no',
    not (public.ais_type_excluded(60::smallint) or public.ais_type_excluded(30::smallint) or public.ais_type_excluded(37::smallint)
         or public.ais_type_excluded(36::smallint) or public.ais_type_excluded(90::smallint) or public.ais_type_excluded(null))),
  ('keeps_30_days: registry, passenger, and fleet-name boats', public.keeps_30_days(999000002, 'X', 52::smallint)
    and public.keeps_30_days(999000004, 'X', 60::smallint) and public.keeps_30_days(999000005, 'BLACKFISH TEST', 37::smallint)),
  ('keeps_30_days: other boats no', not public.keeps_30_days(999000003, 'TEST PLEASURE', 37::smallint));

-- Retention: run the scheduled job's own command ---------------------------------------
insert into public.positions (mmsi, ts, lon, lat, sog_kn) values
  (999000003, now() - interval '3 days', -122.6, 48.2, 5),    -- background, older than 48 h: goes
  (999000004, now() - interval '3 days', -122.4, 48.0, 10),   -- passenger: stays
  (999000002, now() - interval '3 days', -122.5, 48.1, 8),    -- registry: stays
  (999000005, now() - interval '3 days', -122.7, 48.3, 6),    -- fleet name: stays
  (999000004, now() - interval '31 days', -122.4, 48.0, 10),  -- older than 30 days: goes
  (999000001, now() - interval '10 minutes', -122.5, 48.1, 8);-- excluded type that slipped in: goes

do $$ begin execute (select command from cron.job where jobname = 'positions-retention'); end $$;

insert into results (name, pass) values
  ('retention: background traffic older than 48 h is deleted',
    not exists (select 1 from public.positions where mmsi = 999000003 and ts < now() - interval '48 hours')),
  ('retention: background traffic newer than 48 h is kept',
    exists (select 1 from public.positions where mmsi = 999000003 and ts > now() - interval '48 hours')),
  ('retention: passenger, registry and fleet-name boats keep 3-day-old positions',
    (select count(*) = 3 from public.positions where mmsi in (999000002, 999000004, 999000005) and ts < now() - interval '48 hours')),
  ('retention: nothing older than 30 days survives', not exists (select 1 from public.positions where mmsi = 999000004 and ts < now() - interval '30 days')),
  ('retention: excluded types are removed', not exists (select 1 from public.positions where mmsi = 999000001)),
  ('retention job is scheduled hourly', exists (select 1 from cron.job where jobname = 'positions-retention' and schedule = '17 * * * *' and active));

-- Read path -----------------------------------------------------------------------------
insert into results (name, pass)
select 'tracks_window returns the window''s fixes as [mmsi, t, lon, lat, sog, cog]',
  exists (select 1 from jsonb_array_elements(w -> 'fixes') f
          where (f ->> 0)::bigint = 999000004 and abs((f ->> 1)::float - (select t from t0)) < 0.001
            and (f ->> 2)::float = -122.4 and (f ->> 3)::float = 48.0 and (f ->> 4)::float = 10 and (f ->> 5)::float = 180)
  and (w -> 'vessels') @> '[{"mmsi": 999000004, "name": "TEST FERRY", "cls": "A", "shipType": 60}]'::jsonb
from (select public.tracks_window(now() - interval '2 hours')::jsonb as w) x;

-- Access ---------------------------------------------------------------------------------
insert into results (name, pass) values
  ('anonymous and signed-in roles cannot call the functions',
    not has_function_privilege('anon', 'public.ingest_ais(jsonb, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.ingest_ais(jsonb, jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.tracks_window(timestamptz, timestamptz)', 'execute')),
  ('row-level security is on for every whaleboat table',
    (select bool_and(relrowsecurity) from pg_class
     where oid in ('public.positions'::regclass, 'public.vessels'::regclass, 'public.sighting_logs'::regclass, 'public.whale_watch_vessels'::regclass)));

select n, name, pass, detail from results order by n;

rollback;
