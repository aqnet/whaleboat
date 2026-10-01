-- Whale sightings reported to community networks (web/lib/acartia.ts).
-- Acartia's public feed only covers about the last 7 days, so each fetch is
-- upserted here and the map serves up to 30 days from this table. One row per
-- report; the id is the source's own (Acartia's entry_id).
--
-- A few hundred rows a month at most, so nothing is pruned.
--
-- Server-only, like the AIS tables: RLS on, no policies.

create table if not exists public.whale_sightings (
  id text primary key,
  source text not null,                  -- 'acartia'
  seen_at timestamptz not null,
  species text not null,                 -- Orca | Humpback | Gray whale | Other
  label text not null,                   -- species as reported
  count integer,
  lat double precision not null,
  lon double precision not null,
  verified boolean not null default false,
  comments text not null default '',
  photo_url text
);

create index if not exists whale_sightings_seen_at on public.whale_sightings (source, seen_at desc);

alter table public.whale_sightings enable row level security;
