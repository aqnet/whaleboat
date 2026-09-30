-- AIS positions for the map prototype (spec §6.2, trimmed).
--
-- Prototype decisions (2026-09-29), departing from the spec:
--   * All vessels are stored, not only registry vessels (§11), so the map can
--     show Class A/B traffic around the whale-watch boats.
--   * Raw positions are kept on a rolling 30-day window (spec: 90 days),
--     trimmed hourly by pg_cron.
--
-- Only the server (secret key, which bypasses RLS) reads or writes these
-- tables. RLS is on with no policies, so the publishable key sees nothing.

create extension if not exists postgis with schema extensions;
create extension if not exists pg_cron;

create table if not exists public.vessels (
  mmsi bigint primary key,
  name text,
  ais_class char(1) check (ais_class in ('A', 'B')),
  ais_type smallint,
  length_m numeric,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

create table if not exists public.positions (
  mmsi bigint not null,
  ts timestamptz not null,
  lon double precision not null,
  lat double precision not null,
  geom extensions.geometry(Point, 4326)
    generated always as (extensions.st_setsrid(extensions.st_makepoint(lon, lat), 4326)) stored,
  sog_kn real,
  cog_deg real,
  source text not null default 'aisstream',
  primary key (mmsi, ts)
);
create index if not exists positions_ts_brin on public.positions using brin (ts);

alter table public.vessels enable row level security;
alter table public.positions enable row level security;

-- One batch from the sampler. Vessel fields merge (a message without a name
-- doesn't erase a known one); repeated position reports are ignored.
create or replace function public.ingest_ais(p_positions jsonb, p_vessels jsonb)
returns void
language sql
set search_path = ''
as $$
  insert into public.vessels as v (mmsi, name, ais_class, ais_type, length_m, last_seen)
  select mmsi, nullif(name, ''), cls, ship_type, length_m, now()
  from jsonb_to_recordset(p_vessels) as x(mmsi bigint, name text, cls char(1), ship_type smallint, length_m numeric)
  on conflict (mmsi) do update set
    name = coalesce(excluded.name, v.name),
    ais_class = coalesce(excluded.ais_class, v.ais_class),
    ais_type = coalesce(excluded.ais_type, v.ais_type),
    length_m = coalesce(excluded.length_m, v.length_m),
    last_seen = now();

  insert into public.positions (mmsi, ts, lon, lat, sog_kn, cog_deg)
  select mmsi, to_timestamp(t), lon, lat, sog, cog
  from jsonb_to_recordset(p_positions) as x(mmsi bigint, t double precision, lon double precision, lat double precision, sog real, cog real)
  on conflict do nothing;
$$;

revoke execute on function public.ingest_ais(jsonb, jsonb) from public, anon, authenticated;

-- Everything in a time window, as one JSON value: one row per call, so it is
-- not cut off by PostgREST's max-rows limit. Fixes are compact arrays
-- [mmsi, epoch_s, lon, lat, sog, cog] to keep the payload small.
create or replace function public.tracks_window(since timestamptz, until timestamptz default now())
returns json
language sql
stable
set search_path = ''
as $$
  with p as (
    select * from public.positions where ts >= since and ts <= until
  )
  select json_build_object(
    'vessels', coalesce((
      select json_agg(json_build_object(
        'mmsi', v.mmsi, 'name', v.name, 'cls', v.ais_class, 'shipType', v.ais_type, 'lengthM', v.length_m))
      from public.vessels v
      where v.mmsi in (select distinct mmsi from p)
    ), '[]'::json),
    'fixes', coalesce((
      select json_agg(json_build_array(mmsi, extract(epoch from ts), lon, lat, sog_kn, cog_deg) order by mmsi, ts)
      from p
    ), '[]'::json)
  );
$$;

revoke execute on function public.tracks_window(timestamptz, timestamptz) from public, anon, authenticated;

-- Rolling 30-day retention.
select cron.schedule(
  'positions-retention-30d',
  '17 * * * *',
  $$delete from public.positions where ts < now() - interval '30 days'$$
);
