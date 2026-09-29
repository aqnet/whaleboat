"use client";

import { useEffect, useMemo, useState } from "react";
import type { SightingLog, SightingSeason } from "@/lib/sightings";

// Sequential blue (dataviz reference ramp, steps 300 → 700). On dark the ramp
// runs the other way so the highest rates have the most contrast.
const RAMP = ["#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const NONE = { light: "#f0efec", dark: "#383835" };
const BINS = [0.2, 0.4, 0.6, 0.8]; // upper bounds of the first four steps

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Theme = "light" | "dark";
type MonthCell = { month: number; tourDays: number; seenDays: number };

function rateColor(rate: number, theme: Theme): string {
  if (rate === 0) return NONE[theme];
  const i = BINS.findIndex((b) => rate <= b);
  const ramp = theme === "dark" ? [...RAMP].reverse() : RAMP;
  return ramp[i === -1 ? ramp.length - 1 : i];
}

const fmtDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });

function monthly(season: SightingSeason, species: string): MonthCell[] {
  const byMonth = new Map<number, MonthCell>();
  for (const d of season.days) {
    const month = Number(d.date.slice(5, 7)) - 1;
    const cell = byMonth.get(month) ?? { month, tourDays: 0, seenDays: 0 };
    if (d.toured) {
      cell.tourDays++;
      if (d.seen.includes(species)) cell.seenDays++;
    }
    byMonth.set(month, cell);
  }
  return [...byMonth.values()].sort((a, b) => a.month - b.month);
}

export default function SightingsPanel({
  sampleDate,
  theme,
  secondary,
}: {
  sampleDate: string | null; // YYYY-MM-DD, Pacific
  theme: Theme;
  secondary: string;
}) {
  const [log, setLog] = useState<SightingLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/sightings")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? r.statusText);
        setLog(body);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  const sampleYear = sampleDate ? Number(sampleDate.slice(0, 4)) : null;
  const season = log?.seasons.find((s) => s.year === (year ?? sampleYear)) ?? log?.seasons[0] ?? null;
  const grid = useMemo(() => season?.species.map((sp) => ({ species: sp, months: monthly(season, sp) })) ?? [], [season]);

  if (error) return <p className="rounded-lg bg-[#d03b3b]/15 px-3 py-2">⚠ {error}</p>;
  if (!log || !season) return <p className={secondary}>Loading sighting log…</p>;

  const tourDays = season.days.filter((d) => d.toured).length;
  const orcaDays = season.days.filter((d) => d.toured && d.seen.includes("Orca")).length;
  const sampleDay = sampleDate ? log.seasons.flatMap((s) => s.days).find((d) => d.date === sampleDate) : undefined;
  const months = grid[0]?.months.map((m) => m.month) ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden">
      <p className={secondary}>
        Daily log from{" "}
        <a href={log.source} target="_blank" rel="noreferrer" className="underline">
          Western Prince
        </a>{" "}
        (Friday Harbor){log.stale && " · offline copy"}
      </p>

      {sampleDate && (
        <div className="rounded-lg border border-current/10 px-3 py-2">
          <div className={`text-xs ${secondary}`}>Sample day · {fmtDay(sampleDate)}</div>
          {!sampleDay ? (
            <div>Not reported yet</div>
          ) : !sampleDay.toured ? (
            <div>No tours that day</div>
          ) : sampleDay.seen.length ? (
            <div className="font-medium">{sampleDay.seen.join(", ")}</div>
          ) : (
            <div>Toured, nothing logged</div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {log.seasons.map((s) => (
          <button
            key={s.year}
            onClick={() => setYear(s.year)}
            aria-pressed={s.year === season.year}
            className={`rounded-full border px-3 py-1 ${s.year === season.year ? "border-current bg-current/10 font-medium" : "border-current/20"}`}
          >
            {s.year}
          </button>
        ))}
      </div>

      <div>
        <div className="text-2xl font-semibold tabular-nums">{tourDays ? Math.round((orcaDays / tourDays) * 100) : 0}%</div>
        <div className={secondary}>
          of tour days with orcas · {orcaDays} of {tourDays}
          {season.reportedThrough && ` · through ${fmtDay(season.reportedThrough)}`}
        </div>
      </div>

      {/* Species × month: share of tour days the species was logged. */}
      <div role="table" aria-label={`${season.year} sighting rate by species and month`} className="flex flex-col gap-0.5 text-xs">
        <div role="row" className="flex items-center gap-0.5">
          <span className="w-16 shrink-0" />
          {months.map((m) => (
            <span key={m} role="columnheader" className={`flex-1 text-center ${secondary}`}>
              {MONTH_ABBR[m].slice(0, 1)}
            </span>
          ))}
        </div>
        {grid.map((row) => (
          <div key={row.species} role="row" className="flex items-center gap-0.5">
            <span role="rowheader" className="w-16 shrink-0 truncate">
              {row.species}
            </span>
            {row.months.map((c) => {
              const rate = c.tourDays ? c.seenDays / c.tourDays : 0;
              const label = c.tourDays
                ? `${row.species} · ${MONTH_ABBR[c.month]} ${season.year}: ${c.seenDays} of ${c.tourDays} tour days (${Math.round(rate * 100)}%)`
                : `${row.species} · ${MONTH_ABBR[c.month]} ${season.year}: no tours`;
              return (
                <span
                  key={c.month}
                  role="cell"
                  aria-label={label}
                  title={label}
                  onPointerEnter={() => setHover(label)}
                  onPointerLeave={() => setHover(null)}
                  className="h-5 flex-1 rounded-[3px]"
                  style={
                    c.tourDays
                      ? { background: rateColor(rate, theme) }
                      : { boxShadow: "inset 0 0 0 1px currentColor", opacity: 0.15 }
                  }
                />
              );
            })}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className={secondary}>0%</span>
        <span className="flex h-2 flex-1 overflow-hidden rounded">
          {[0, 0.1, 0.3, 0.5, 0.7, 0.9].map((r) => (
            <span key={r} className="flex-1" style={{ background: rateColor(r, theme) }} />
          ))}
        </span>
        <span className={secondary}>100% of tour days</span>
      </div>
      <p className={`min-h-4 text-xs ${secondary}`}>{hover ?? "Hover a cell for counts."}</p>
    </div>
  );
}
