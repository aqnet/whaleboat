"use client";

import { useEffect, useState } from "react";
import type { Species, WhaleSighting, WhaleSightings } from "@/lib/acartia";
import type { Acoustic, Bout, Hydrophone } from "@/lib/orcasound";

// Mirrors SPECIES in lib/acartia.ts, which can't be imported here (it uses node:fs).
export const SPECIES_ORDER: Species[] = ["Orca", "Humpback", "Gray whale", "Other"];

// Categorical slots chosen to stay clear of the AIS class colors (blue,
// orange) underneath, validated all-pairs in both modes (dataviz palette:
// violet, green, magenta). "Other" has no hue: it is drawn as a hollow ring.
export const SPECIES_COLORS: Record<Theme, Record<Species, string | null>> = {
  light: { Orca: "#4a3aa7", Humpback: "#008300", "Gray whale": "#e87ba4", Other: null },
  dark: { Orca: "#9085e9", Humpback: "#008300", "Gray whale": "#d55181", Other: null },
};

export const WINDOWS = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;

type Theme = "light" | "dark";

export type WhaleFilters = {
  days: number;
  species: Set<Species>; // hidden species
  verifiedOnly: boolean;
  onMap: boolean;
  hydrophonesOnMap: boolean;
};

export type WhaleView = "seen" | "heard";

function useJson<T>(url: string, unavailable: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    fetch(url)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? r.statusText);
        setData(body);
        setError(null);
      })
      .catch((e) => {
        console.error(`${url}:`, e);
        setError(unavailable);
      });
  }, [url, unavailable, nonce]);
  return { data, error, reload: () => setNonce((n) => n + 1) };
}

export const useWhaleSightings = () => useJson<WhaleSightings>("/api/whales", "Whale reports aren't available right now. Please refresh.");
export const useAcoustic = () => useJson<Acoustic>("/api/acoustic", "Hydrophone reports aren't available right now. Please refresh.");

export const boutsInWindow = (bouts: Bout[], days: number, now: number) => bouts.filter((b) => b.end >= now - days * 86400);

export const windowLabel = (days: number) => (days === 1 ? "24 hours" : `${days} days`);

export function filterSightings(all: WhaleSighting[], f: WhaleFilters, now = Date.now() / 1000): WhaleSighting[] {
  const since = now - f.days * 86400;
  return all.filter((s) => s.t >= since && !f.species.has(s.species) && (!f.verifiedOnly || s.verified));
}

export function ago(t: number, now = Date.now() / 1000): string {
  const m = Math.max(0, Math.round((now - t) / 60));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function SpeciesDot({ species, theme }: { species: Species; theme: Theme }) {
  const c = SPECIES_COLORS[theme][species];
  return (
    <span
      className="inline-block size-2.5 shrink-0 rounded-full"
      style={c ? { background: c } : { boxShadow: "inset 0 0 0 1.5px currentColor" }}
      aria-hidden
    />
  );
}

type Loaded<T> = { data: T | null; error: string | null; reload: () => void };

// The "Whale Location" tab: whales people saw (Acartia) and whales the
// hydrophones heard (Orcasound), over one shared time range.
export default function WhalesPanel({
  sightings,
  acoustic,
  view,
  setView,
  filters,
  setFilters,
  selected,
  onFocus,
  selectedHydrophone,
  setSelectedHydrophone,
  onFocusHydrophone,
  theme,
  secondary,
}: {
  sightings: Loaded<WhaleSightings>;
  acoustic: Loaded<Acoustic>;
  view: WhaleView;
  setView: (v: WhaleView) => void;
  filters: WhaleFilters;
  setFilters: (f: WhaleFilters) => void;
  selected: string | null;
  onFocus: (s: WhaleSighting) => void;
  selectedHydrophone: string | null;
  setSelectedHydrophone: (id: string | null) => void;
  onFocusHydrophone: (h: Hydrophone) => void;
  theme: Theme;
  secondary: string;
}) {
  const fetchedAt = sightings.data?.fetchedAt ?? acoustic.data?.fetchedAt;
  // Times are relative to the fetch, so lists don't shift between renders.
  const now = fetchedAt ? Date.parse(fetchedAt) / 1000 : null;
  const nSeen = sightings.data && now != null ? filterSightings(sightings.data.sightings, filters, now).length : null;
  const nHeard = acoustic.data && now != null ? boutsInWindow(acoustic.data.bouts, filters.days, now).length : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {WINDOWS.map((w) => (
            <Chip key={w.days} active={filters.days === w.days} onClick={() => setFilters({ ...filters, days: w.days })}>
              {w.label}
            </Chip>
          ))}
        </div>
        <button
          className="shrink-0 rounded-lg border border-current/20 px-2.5 py-1"
          onClick={() => {
            sightings.reload();
            acoustic.reload();
          }}
          title="Refresh"
          aria-label="Refresh"
        >
          ↻
        </button>
      </div>

      <div role="radiogroup" aria-label="Report type" className="flex rounded-lg border border-current/20 p-0.5">
        {(
          [
            ["seen", "Sightings", nSeen],
            ["heard", "Hydrophones", nHeard],
          ] as const
        ).map(([id, label, n]) => (
          <button
            key={id}
            role="radio"
            aria-checked={view === id}
            onClick={() => setView(id)}
            className={`flex-1 rounded-md px-2 py-1 ${view === id ? "bg-current/10 font-medium" : secondary}`}
          >
            {label}
            {n != null && <span className={`ml-1.5 tabular-nums ${secondary}`}>{n}</span>}
          </button>
        ))}
      </div>

      {view === "seen" ? (
        <SightingsView {...sightings} filters={filters} setFilters={setFilters} selected={selected} onFocus={onFocus} theme={theme} secondary={secondary} />
      ) : (
        <HydrophonesView
          {...acoustic}
          filters={filters}
          setFilters={setFilters}
          selected={selectedHydrophone}
          setSelected={setSelectedHydrophone}
          onFocus={onFocusHydrophone}
          theme={theme}
          secondary={secondary}
        />
      )}
    </div>
  );
}

function SightingsView({
  data,
  error,
  filters,
  setFilters,
  selected,
  onFocus,
  theme,
  secondary,
}: {
  data: WhaleSightings | null;
  error: string | null;
  filters: WhaleFilters;
  setFilters: (f: WhaleFilters) => void;
  selected: string | null;
  onFocus: (s: WhaleSighting) => void;
  theme: Theme;
  secondary: string;
}) {
  if (error && !data) return <p className="rounded-lg bg-[#d03b3b]/15 px-3 py-2">⚠ {error}</p>;
  if (!data) return <p className={secondary}>Loading whale reports…</p>;

  // Times are relative to the fetch, so the list doesn't shift between renders.
  const now = Date.parse(data.fetchedAt) / 1000;
  const inWindow = data.sightings.filter((s) => s.t >= now - filters.days * 86400 && (!filters.verifiedOnly || s.verified));
  const shown = filterSightings(data.sightings, filters, now);
  const toggleSpecies = (sp: Species) => {
    const hidden = new Set(filters.species);
    if (hidden.has(sp)) hidden.delete(sp);
    else hidden.add(sp);
    setFilters({ ...filters, species: hidden });
  };

  return (
    <>
      <p className={secondary}>
        Community reports from Orca Network and partners, shared through{" "}
        <a href={data.source} target="_blank" rel="noreferrer" className="underline">
          Acartia
        </a>
        {data.stale && " · may be out of date"}
      </p>

      {/* Species chips double as the map legend; click one to hide or show it. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {SPECIES_ORDER.map((sp) => {
          const n = inWindow.filter((s) => s.species === sp).length;
          const on = !filters.species.has(sp);
          return (
            <button
              key={sp}
              onClick={() => toggleSpecies(sp)}
              aria-pressed={on}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 ${on ? "border-current/40" : "border-current/15 opacity-50"}`}
            >
              <SpeciesDot species={sp} theme={theme} />
              {sp} <span className={`tabular-nums ${secondary}`}>{n}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Chip active={filters.verifiedOnly} onClick={() => setFilters({ ...filters, verifiedOnly: !filters.verifiedOnly })}>
          Verified only
        </Chip>
        <Chip active={filters.onMap} onClick={() => setFilters({ ...filters, onMap: !filters.onMap })}>
          Show on map
        </Chip>
      </div>

      {shown.length === 0 ? (
        <p className={secondary}>No whale reports in this time range.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-lg border border-current/10">
          {shown.map((s) => (
            <li key={s.id} className="border-t border-current/5 first:border-t-0">
              <button
                onClick={() => onFocus(s)}
                className={`flex w-full flex-col gap-0.5 px-2 py-1.5 text-left ${s.id === selected ? "bg-current/10" : "hover:bg-current/5"}`}
              >
                <span className="flex items-center gap-2">
                  <SpeciesDot species={s.species} theme={theme} />
                  <span className="truncate font-medium">
                    {s.label}
                    {s.count && s.count > 1 ? ` × ${s.count}` : ""}
                  </span>
                  {s.verified && <span className="shrink-0 rounded-full border border-current/30 px-1.5 text-xs">verified</span>}
                  <span className={`ml-auto shrink-0 text-xs ${secondary}`}>{ago(s.t, now)}</span>
                </span>
                {s.comments && <span className={`line-clamp-2 text-xs ${secondary}`}>{s.comments}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className={`text-xs ${secondary}`}>Reported sightings only; whales nobody reported won&apos;t appear.</p>
    </>
  );
}

function HydrophonesView({
  data,
  error,
  filters,
  setFilters,
  selected,
  setSelected,
  onFocus,
  theme,
  secondary,
}: {
  data: Acoustic | null;
  error: string | null;
  filters: WhaleFilters;
  setFilters: (f: WhaleFilters) => void;
  selected: string | null;
  setSelected: (id: string | null) => void;
  onFocus: (h: Hydrophone) => void;
  theme: Theme;
  secondary: string;
}) {
  if (error && !data) return <p className="rounded-lg bg-[#d03b3b]/15 px-3 py-2">⚠ {error}</p>;
  if (!data) return <p className={secondary}>Loading hydrophone reports…</p>;

  const now = Date.parse(data.fetchedAt) / 1000;
  const recent = boutsInWindow(data.bouts, filters.days, now);
  const byId = new Map(data.hydrophones.map((h) => [h.id, h]));
  const at = selected ? byId.get(selected) : undefined;
  const shown = at ? recent.filter((b) => b.hydrophoneId === at.id) : recent;
  const mins = (b: Bout) => Math.max(1, Math.round((b.end - b.start) / 60));

  return (
    <>
      <p className={secondary}>
        Whale calls picked out by experts on{" "}
        <a href={data.source} target="_blank" rel="noreferrer" className="underline">
          Orcasound
        </a>
        &apos;s live hydrophones{data.stale && " · may be out of date"}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        <Chip active={filters.hydrophonesOnMap} onClick={() => setFilters({ ...filters, hydrophonesOnMap: !filters.hydrophonesOnMap })}>
          Show on map
        </Chip>
        {at && (
          <button className={`underline ${secondary}`} onClick={() => setSelected(null)}>
            Showing {at.name} · show all
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-lg border border-current/10">
        {shown.length === 0 ? (
          <p className={`px-2 py-2 ${secondary}`}>No whale calls identified in the last {windowLabel(filters.days)}.</p>
        ) : (
          <ul>
            {shown.map((b) => {
              const h = byId.get(b.hydrophoneId)!;
              return (
                <li key={b.id} className="flex items-start gap-2 border-t border-current/5 px-2 py-1.5 first:border-t-0">
                  <button onClick={() => onFocus(h)} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                    <span className="flex items-center gap-2">
                      <SpeciesDot species={b.species} theme={theme} />
                      <span className="truncate font-medium">{b.name}</span>
                    </span>
                    <span className={`text-xs ${secondary}`}>
                      {b.ecotype && `${b.ecotype} orcas · `}
                      {h.name} · {mins(b)} min · {ago(b.start, now)}
                    </span>
                  </button>
                  <a href={b.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs underline" title="Hear the recording on Orcasound">
                    Listen
                  </a>
                </li>
              );
            })}
          </ul>
        )}

        {/* Every hydrophone, so quiet ones are visible rather than missing. */}
        <div className={`border-t border-current/10 px-2 pb-0.5 pt-2 text-xs ${secondary}`}>Hydrophones</div>
        <ul>
          {data.hydrophones.map((h) => {
            const n = recent.filter((b) => b.hydrophoneId === h.id).length;
            return (
              <li key={h.id} className={`flex items-center gap-2 px-2 py-1 ${h.id === selected ? "bg-current/10" : ""}`}>
                <button onClick={() => onFocus(h)} className={`flex min-w-0 flex-1 items-center gap-2 text-left ${n ? "" : "opacity-60"}`}>
                  <span aria-hidden className="text-xs">◆</span>
                  <span className="truncate">{h.name}</span>
                  <span className={`ml-auto shrink-0 text-xs tabular-nums ${secondary}`}>{n ? `${n} heard` : "quiet"}</span>
                </button>
                <a href={h.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs underline" title="Listen live on Orcasound">
                  Live
                </a>
              </li>
            );
          })}
        </ul>
      </div>
      <p className={`text-xs ${secondary}`}>Hydrophones only hear whales close by; quiet doesn&apos;t mean no whales.</p>
    </>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 ${active ? "border-current bg-current/10 font-medium" : "border-current/20"}`}
    >
      {children}
    </button>
  );
}
