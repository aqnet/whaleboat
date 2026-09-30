-- Fix: positions with an unknown speed were thinned like stationary ones.
--
-- In ingest_ais(), `x.sog < 0.5` is null when the speed is unknown (AIS "not
-- available", common on Class B), which made the thinning condition null and
-- dropped the row whenever the vessel had another position in the last 15
-- minutes. The intent was always that an unknown speed counts as moving.
-- Found by db/tests/storage_rules.sql on 2026-09-30.

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
    -- Excluded types, unless it's a registry boat.
    not exists (
      select 1 from public.vessels v
      where v.mmsi = x.mmsi and public.ais_type_excluded(v.ais_type)
        and not exists (select 1 from public.whale_watch_vessels w where w.mmsi = x.mmsi))
    -- Not moving (under 0.5 kn), and already has a position in the last 15 min.
    -- An unknown speed counts as moving: without the coalesce, a null speed
    -- made this whole condition null and the row was dropped.
    and not (
      coalesce(x.sog < 0.5, false)
      and exists (
        select 1 from public.positions p
        where p.mmsi = x.mmsi
          and p.ts >= to_timestamp(x.t) - interval '15 minutes'
          and p.ts < to_timestamp(x.t)))
  on conflict do nothing;
$$;
revoke execute on function public.ingest_ais(jsonb, jsonb) from public, anon, authenticated;
