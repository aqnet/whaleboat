-- Last good copy of each operator's published sighting log (web/lib/sightings.ts).
-- One row per operator, replaced on every successful fetch. Kept in the
-- database because Cloud Run containers have no durable disk.
--
-- Server-only, like the AIS tables: RLS on, no policies.

create table if not exists public.sighting_logs (
  operator_id text primary key,          -- matches an operator id in web/lib/whaleWatch.ts
  source text not null,
  fetched_at timestamptz not null,
  seasons jsonb not null                 -- SightingSeason[]
);

alter table public.sighting_logs enable row level security;
