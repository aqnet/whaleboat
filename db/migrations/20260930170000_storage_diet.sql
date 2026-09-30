-- Cut what `positions` stores, to stay inside Supabase's free 500 MB.
-- Measured on 2026-09-30: ~11k rows/hour, ~80% of them from boats that
-- weren't moving; at that rate 30 days is ~1.3 GB.
--
--   1. Vessel types nobody needs on the map are not stored at all.
--   2. A boat that isn't moving is stored at most once every 15 minutes.
--   3. Background traffic is kept 48 h (the map's window). Passenger vessels
--      and the named whale-watch boats are kept 30 days.
--   4. The generated `geom` column goes: nothing reads it yet. Re-add it when
--      PostGIS queries (geofences, encounters; spec §7) need it.
--
-- All of this is enforced here, in ingest_ais() and the hourly job, so it
-- holds for every writer (the recorder and scripts/ais-sample.ts).

alter table public.positions drop column if exists geom;

-- AIS ship types that are never stored: towing/tugs (31, 32, 52), military
-- (35), pilot, SAR, port tender, anti-pollution, law enforcement, medical
-- (50, 51, 53, 54, 55, 58), cargo (70-79) and tankers (80-89).
-- Kept: passenger, fishing, sailing, pleasure craft, and unknown.
create or replace function public.ais_type_excluded(t smallint)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(t in (31, 32, 52, 35, 50, 51, 53, 54, 55, 58) or t between 70 and 89, false);
$$;

-- Vessels whose positions are kept 30 days instead of 48 h: anything
-- broadcasting a passenger type (60-69), plus the whale-watch fleet names
-- that are distinctive enough to match without a type. Keep the name list in
-- step with web/lib/whaleWatch.ts (the names marked `generic` there are
-- covered by the passenger rule).
create or replace function public.keeps_30_days(name text, ais_type smallint)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(ais_type between 60 and 69, false)
      or coalesce(upper(name) ~ '^(BLACKFISH|ISLAND EXPLORER|WESTERN EXPLORER|SPIRIT OF ORCA|GLACIER SPIRIT|CHILKAT EXPRESS)', false);
$$;

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
  select x.mmsi, to_timestamp(x.t), x.lon, x.lat, x.sog, x.cog
  from jsonb_to_recordset(p_positions) as x(mmsi bigint, t double precision, lon double precision, lat double precision, sog real, cog real)
  where
    -- 1. Excluded types. A vessel's type arrives separately from its position,
    --    so a new vessel is stored until its type is known; the hourly job
    --    removes what slipped through.
    not exists (
      select 1 from public.vessels v where v.mmsi = x.mmsi and public.ais_type_excluded(v.ais_type))
    -- 2. Not moving (under 0.5 kn), and already has a position in the last 15 min.
    --    An unknown speed counts as moving.
    and not (
      x.sog < 0.5
      and exists (
        select 1 from public.positions p
        where p.mmsi = x.mmsi
          and p.ts >= to_timestamp(x.t) - interval '15 minutes'
          and p.ts < to_timestamp(x.t)))
  on conflict do nothing;
$$;

revoke execute on function public.ingest_ais(jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.ais_type_excluded(smallint) from public, anon, authenticated;
revoke execute on function public.keeps_30_days(text, smallint) from public, anon, authenticated;

-- Hourly retention. Replaces the single 30-day rule from the first migration.
select cron.unschedule('positions-retention-30d');
select cron.schedule(
  'positions-retention',
  '17 * * * *',
  $$
  delete from public.positions where ts < now() - interval '30 days';
  delete from public.positions p using public.vessels v
    where v.mmsi = p.mmsi and public.ais_type_excluded(v.ais_type);
  delete from public.positions p
    where p.ts < now() - interval '48 hours'
      and not exists (
        select 1 from public.vessels v where v.mmsi = p.mmsi and public.keeps_30_days(v.name, v.ais_type));
  $$
);

-- Apply the type rule to what is already stored.
delete from public.positions p using public.vessels v
  where v.mmsi = p.mmsi and public.ais_type_excluded(v.ais_type);
