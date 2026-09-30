-- Whale-watch boats known by MMSI (web/lib/whaleWatch.ts is the source; keep
-- the two in step). Seeded 2026-09-30 from the operators' sites and a one-time
-- pull of https://whales.lovejoydiver.net/api/fleet.
--
-- These boats always get 30-day retention and are never dropped by the
-- vessel-type filter, whatever type they broadcast (small tour boats often
-- report "pleasure craft" or nothing).

create table if not exists public.whale_watch_vessels (
  mmsi bigint primary key,
  name text not null,
  operator text not null
);
alter table public.whale_watch_vessels enable row level security;

insert into public.whale_watch_vessels (mmsi, name, operator) values
  (338519000, 'Swiftsure', 'Puget Sound Express'),
  (368023510, 'Saratoga', 'Puget Sound Express'),
  (367121000, 'Glacier Spirit', 'Puget Sound Express'),
  (366889850, 'Red Head', 'Puget Sound Express'),
  (367156000, 'Chilkat Express', 'Puget Sound Express'),
  (368616000, 'Blackfish VI', 'Outer Island Expeditions'),
  (367784930, 'Blackfish IV', 'Outer Island Expeditions'),
  (367524220, 'Blackfish II', 'Outer Island Expeditions'),
  (367679690, 'Triton', 'Outer Island Expeditions'),
  (367679710, 'Blackfish', 'Outer Island Expeditions'),
  (368026630, 'Western Explorer II', 'Western Prince'),
  (338562000, 'Western Prince II', 'Western Prince'),
  (369264000, 'Island Explorer 5', 'Island Adventures'),
  (367161570, 'Island Explorer 3', 'Island Adventures'),
  (368177750, 'Halcyon', 'Island Adventures'),
  (368295070, 'Sounder', 'Blue Kingdom'),
  (368400660, 'Wake', 'Blue Kingdom'),
  (338542989, 'Spirit of Orca II', 'Spirit of Orca'),
  (368111540, 'Peniel', 'All Aboard Sailing'),
  (316023189, 'BC Tika', 'BC Whale Tours'),
  (366801000, 'Island Whaler', 'Deception Pass Tours'),
  (368355000, 'Pelagic II', 'Deer Harbor Charters'),
  (367631000, 'Squito', 'Deer Harbor Charters'),
  (316028179, '4 Ever Wild', 'Eagle Wing Tours'),
  (316007107, 'Goldwing', 'Eagle Wing Tours'),
  (316008468, 'Serengeti', 'Eagle Wing Tours'),
  (316034816, 'Wild 4 Whales', 'Eagle Wing Tours'),
  (316051368, 'Wildcat 4', 'Eagle Wing Tours'),
  (316008708, 'Kuluta', 'Five Star Whale Watching'),
  (316037728, 'Salish Shadow', 'Five Star Whale Watching'),
  (316003705, 'Supercat', 'Five Star Whale Watching'),
  (368457860, 'Emerald Clipper', 'FRS Clipper'),
  (366902890, 'San Juan Clipper', 'FRS Clipper'),
  (367742760, 'J1', 'Maya''s Legacy'),
  (368032220, 'J2', 'Maya''s Legacy'),
  (338393768, 'Mystic Sea', 'Mystic Sea Charters'),
  (316041457, 'Onyx', 'Ocean EcoVentures'),
  (316049389, 'Prowler', 'Ocean EcoVentures'),
  (316009175, 'Sonic', 'Ocean EcoVentures'),
  (316028008, 'Catalina Adventure', 'Orca Spirit Adventures'),
  (316006859, 'Haisla Explorer', 'Orca Spirit Adventures'),
  (316029172, 'Orca Mist', 'Orca Spirit Adventures'),
  (316005064, 'Orca Spirit', 'Orca Spirit Adventures'),
  (316018618, 'Orca Spirit II', 'Orca Spirit Adventures'),
  (316010956, 'Pacific Explorer I', 'Orca Spirit Adventures'),
  (316006789, 'Ocean Magic', 'Prince of Whales'),
  (316008331, 'Ocean Magic II', 'Prince of Whales'),
  (316032858, 'Salish Sea Dream', 'Prince of Whales'),
  (316039686, 'Salish Sea Eclipse', 'Prince of Whales'),
  (316042213, 'Salish Sea Freedom', 'Prince of Whales'),
  (316059231, 'Salish Sea Glory', 'Prince of Whales'),
  (368643000, 'Rosario', 'San Juan Cruises'),
  (369329000, 'Salish Express', 'San Juan Cruises'),
  (367395870, 'Salish Sea', 'San Juan Cruises'),
  (367091440, 'Victoria Star 2', 'San Juan Cruises'),
  (367351090, 'Odyssey', 'San Juan Excursions'),
  (367014000, 'Kestrel', 'San Juan Safaris'),
  (338576000, 'Osprey', 'San Juan Safaris'),
  (338191000, 'Sea Lion', 'San Juan Safaris'),
  (316009443, 'Sea King', 'SeaKing Adventures'),
  (316004946, 'Marauder IV', 'SpringTide'),
  (316006213, 'Springtide I', 'SpringTide'),
  (316034303, 'Seabreeze I', 'Steveston Seabreeze Adventures'),
  (316007866, 'Triple 8', 'Steveston Seabreeze Adventures'),
  (316036809, 'Cascadia', 'Vancouver Island Whale Watch'),
  (316036225, 'Keta', 'Vancouver Island Whale Watch'),
  (316042661, 'Kula', 'Vancouver Island Whale Watch'),
  (316008045, 'Explorathor Express', 'Vancouver Whale Watch'),
  (316008046, 'Explorathor II', 'Vancouver Whale Watch'),
  (316014609, 'Lightship 1', 'Vancouver Whale Watch'),
  (316035167, 'Strider I', 'Vancouver Whale Watch'),
  (316041693, 'Spartan 01', 'White Rock Sea Tours'),
  (316050913, 'Spartan 2', 'White Rock Sea Tours'),
  (316040487, 'Aurora I', 'Wild Whales Vancouver'),
  (316040366, 'Aurora II', 'Wild Whales Vancouver'),
  (316034894, 'Eagle Eyes', 'Wild Whales Vancouver'),
  (316032442, 'Jing Yu', 'Wild Whales Vancouver'),
  (368406750, 'Peregrine', 'Operator unknown')
on conflict (mmsi) do update set name = excluded.name, operator = excluded.operator;

-- Registry boats first, then passenger types, then the name patterns kept for
-- fleet boats whose MMSI isn't known yet.
drop function if exists public.keeps_30_days(text, smallint);
create or replace function public.keeps_30_days(p_mmsi bigint, name text, ais_type smallint)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.whale_watch_vessels w where w.mmsi = p_mmsi)
      or coalesce(ais_type between 60 and 69, false)
      or coalesce(upper(name) ~ '^(BLACKFISH|ISLAND EXPLORER|WESTERN EXPLORER|SPIRIT OF ORCA|GLACIER SPIRIT|CHILKAT EXPRESS)', false);
$$;
revoke execute on function public.keeps_30_days(bigint, text, smallint) from public, anon, authenticated;

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

select cron.schedule(
  'positions-retention',
  '17 * * * *',
  $cron$
  delete from public.positions where ts < now() - interval '30 days';
  delete from public.positions p using public.vessels v
    where v.mmsi = p.mmsi and public.ais_type_excluded(v.ais_type)
      and not exists (select 1 from public.whale_watch_vessels w where w.mmsi = p.mmsi);
  delete from public.positions p
    where p.ts < now() - interval '48 hours'
      and not exists (
        select 1 from public.vessels v where v.mmsi = p.mmsi and public.keeps_30_days(v.mmsi, v.name, v.ais_type));
  $cron$
);
