"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MapGL, { Layer, Source, NavigationControl, ScaleControl, type MapRef } from "react-map-gl/maplibre";
import { MapboxOverlay, type MapboxOverlayProps } from "@deck.gl/mapbox";
import { IconLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import { GeolocateControl, setWorkerUrl, type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Fix, SampleFile, SampleSummary, VesselTrack } from "@/lib/ais";

// Mirrors WINDOW_ID in lib/ais.ts, which can't be imported here (it uses node:fs).
const WINDOW_ID = "last-48h";
import { OPERATORS } from "@/lib/whaleWatch";
import SightingsPanel from "./SightingsPanel";
import type { WhaleSighting } from "@/lib/acartia";
import type { Bout, Hydrophone } from "@/lib/orcasound";
import WhalesPanel, {
  SPECIES_COLORS,
  ago,
  boutsInWindow,
  filterSightings,
  useAcoustic,
  useWhaleSightings,
  windowLabel,
  type WhaleFilters,
  type WhaleView,
} from "./WhalesPanel";

// Served from public/ by scripts/copy-maplibre-worker.mjs; the bundler can't resolve it.
setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

// ---------------------------------------------------------------------------
// Basemaps: OpenFreeMap (free, no key) + optional NOAA chart overlay (WMS).

const BASEMAPS = {
  light: { label: "Light", url: "https://tiles.openfreemap.org/styles/positron", dark: false },
  streets: { label: "Streets", url: "https://tiles.openfreemap.org/styles/liberty", dark: false },
  dark: { label: "Dark", url: "https://tiles.openfreemap.org/styles/dark", dark: true },
  depth: { label: "Depth", url: "https://tiles.openfreemap.org/styles/positron", dark: false },
} as const;
type BasemapId = keyof typeof BASEMAPS;

// Depth basemap: NOAA chart depth areas and contours, downloaded by
// `npm run depth:fetch` into public/depth/. Bands follow the charts' fathom
// steps (3, 10, 20, 50, 100 fathoms), keyed on each area's shallowest depth.
// The blues stay pale so the Class A/B track colors still read on top.
const DEPTH_BANDS = [
  { min: -Infinity, label: "Dries at low tide", color: "#e8e2cf" },
  { min: 0, label: "0–5 m", color: "#e6f1f8" },
  { min: 5.4, label: "5–18 m", color: "#d3e6f3" },
  { min: 18.2, label: "18–37 m", color: "#bfd9ec" },
  { min: 36.5, label: "37–91 m", color: "#a9cae3" },
  { min: 91.4, label: "91–183 m", color: "#94bad8" },
  { min: 182.8, label: "183 m +", color: "#80a9cb" },
];
// ["step", input, color0, stop1, color1, ...]
const DEPTH_FILL = [
  "step",
  ["coalesce", ["get", "DRVAL1"], 0],
  DEPTH_BANDS[0].color,
  ...DEPTH_BANDS.slice(1).flatMap((b) => [b.min, b.color]),
] as unknown as string;
// Draw right above the basemap's own water, so land use, roads and labels stay on top.
const DEPTH_BEFORE = "landcover_ice_shelf";

const NOAA_WMS =
  "https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/WMSServer" +
  "?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=0,1,2,3,4,5,6,7&STYLES=&CRS=EPSG:3857" +
  "&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true";

const INITIAL_VIEW = { longitude: -122.55, latitude: 48.14, zoom: 9.2 };

// ---------------------------------------------------------------------------
// Color (dataviz reference palette). Class: categorical slots 1–2, validated
// light + dark. Speed: single-hue blue ramp, light → dark with magnitude.

type RGB = [number, number, number];
type RGBA = [number, number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const CLASS_COLORS = {
  light: { A: hex("#2a78d6"), B: hex("#eb6834"), "?": hex("#898781") },
  dark: { A: hex("#3987e5"), B: hex("#d95926"), "?": hex("#898781") },
};
const SPEED_RAMP = ["#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"].map(hex); // steps 300 → 700
const SPEED_STOPS_KN = [0, 2, 6, 12, 20];
const SURFACE = { light: hex("#fcfcfb"), dark: hex("#1a1a19") };
const INK = { light: hex("#0b0b0b"), dark: hex("#ffffff") };

function speedColor(sog: number | null): RGB {
  if (sog == null) return hex("#898781");
  const i = SPEED_STOPS_KN.findIndex((s) => sog < s);
  if (i === -1) return SPEED_RAMP.at(-1)!;
  if (i === 0) return SPEED_RAMP[0];
  const t = (sog - SPEED_STOPS_KN[i - 1]) / (SPEED_STOPS_KN[i] - SPEED_STOPS_KN[i - 1]);
  const a = SPEED_RAMP[i - 1];
  const b = SPEED_RAMP[i];
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t)) as RGB;
}

type ColorMode = "class" | "speed";
type PanelTab = "ais" | "sightings" | "whales";

// ---------------------------------------------------------------------------

// deck.gl draws on its own WebGL canvas above the map. The overlay is attached
// by hand, once per map instance, in the map's load handler: react-map-gl's
// useControl created a duplicate overlay under React Strict Mode.
//
// If the browser drops deck's WebGL context, the boats vanish with no error.
// That happens on low-memory GPUs (the VMware dev VM) and on phones when a tab
// is backgrounded, so the overlay is recreated when its context is lost.
// Interleaved mode (one shared context) would avoid it, but deck.gl <= 9.4
// reads MapLibre internals that MapLibre 6 made private.
type AttachedOverlay = { map: MapLibreMap; overlay: MapboxOverlay; retries: number };
const MAX_DECK_RETRIES = 5;

type FixDatum = Fix & { vessel: VesselTrack };
type HydrophoneDatum = Hydrophone & { bouts: Bout[] };

// Hydrophone marker: a diamond, tinted per layer (mask).
const DIAMOND = {
  id: "diamond",
  url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M16 1 31 16 16 31 1 16Z" fill="#fff"/></svg>')}`,
  width: 32,
  height: 32,
  mask: true,
};
type PathDatum = { vessel: VesselTrack; path: [number, number][]; sogs: (number | null)[] };

const fmtDate = (t: number) => new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function shipTypeLabel(t: number | null): string {
  if (t == null) return "type unknown";
  if (t >= 60 && t <= 69) return "passenger";
  if (t >= 70 && t <= 79) return "cargo";
  if (t >= 80 && t <= 89) return "tanker";
  if (t === 30) return "fishing";
  if (t === 31 || t === 32 || t === 52) return "tug";
  if (t === 36) return "sailing";
  if (t === 37) return "pleasure";
  return `type ${t}`;
}

export default function BoatMap() {
  const mapRef = useRef<MapRef>(null);
  const [samples, setSamples] = useState<SampleFile[]>([]);
  const [file, setFile] = useState<string | null>(WINDOW_ID);
  const [data, setData] = useState<SampleSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<BasemapId>("streets");
  const [noaa, setNoaa] = useState(false);
  // True once the loaded base style contains the layer the depth layers sit
  // under. Switching basemaps swaps styles asynchronously, so for a moment
  // the old style is still the one on the map.
  const [depthAnchorReady, setDepthAnchorReady] = useState(false);
  const [colorMode, setColorMode] = useState<ColorMode>("class");
  const [movingOnly, setMovingOnly] = useState(false);
  // The map opens on the whale-watch fleet; the chip turns it off to show all traffic.
  const [whaleOnly, setWhaleOnly] = useState(true);
  const [tab, setTab] = useState<PanelTab>("ais");
  const [selected, setSelected] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const whales = useWhaleSightings();
  const acoustic = useAcoustic();
  const [whaleFilters, setWhaleFilters] = useState<WhaleFilters>({
    days: 7,
    species: new Set(),
    verifiedOnly: false,
    onMap: true,
    hydrophonesOnMap: true,
  });
  const [whaleView, setWhaleView] = useState<WhaleView>("seen");
  const [selectedWhale, setSelectedWhale] = useState<string | null>(null);
  const [selectedHydrophone, setSelectedHydrophone] = useState<string | null>(null);
  // Shown briefly when the location button can't find the user.
  const [locateError, setLocateError] = useState<string | null>(null);
  const locateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deckRef = useRef<AttachedOverlay | null>(null);
  const [, setDeckAttached] = useState(0);

  const theme = BASEMAPS[basemap].dark ? "dark" : "light";

  useEffect(() => {
    load(WINDOW_ID);
  }, []);

  // Messages shown to people using the map. Details go to the console only.
  const NO_DATA = "No data samples available. Please refresh.";
  const LOAD_FAILED = "Couldn't load boat data. Please refresh.";

  // Local sample files only exist in development, where they fill the picker.
  // In production the list is empty and the map reads from the database, so
  // an empty list is not an error. Re-listing on each load picks up a pull
  // started after the page opened.
  function load(f: string) {
    fetch("/api/samples")
      .then((r) => r.json())
      .then((list: SampleFile[]) => setSamples(Array.isArray(list) ? list : []))
      .catch(() => setSamples([]));
    fetch(f === WINDOW_ID ? "/api/tracks" : `/api/tracks?file=${encodeURIComponent(f)}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? r.statusText);
        setData(body);
        setError(body.positionReports ? null : NO_DATA);
      })
      .catch((e) => {
        console.error("tracks:", e);
        setError(LOAD_FAILED);
      });
  }

  const vessels = useMemo(
    () => (data?.vessels ?? []).filter((v) => (!movingOnly || v.moving) && (!whaleOnly || v.whaleWatch)),
    [data, movingOnly, whaleOnly],
  );
  const whaleCount = data?.vessels.filter((v) => v.whaleWatch).length ?? 0;

  const paths = useMemo<PathDatum[]>(
    () =>
      vessels.flatMap((v) =>
        v.segments.map((s) => ({
          vessel: v,
          path: s.path,
          sogs: s.timestamps.map((t) => v.fixes.find((f) => f.t === t)?.sog ?? null),
        })),
      ),
    [vessels],
  );
  const fixes = useMemo<FixDatum[]>(() => vessels.flatMap((v) => v.fixes.map((f) => ({ ...f, vessel: v }))), [vessels]);

  const whaleMarks = useMemo(
    () => (whaleFilters.onMap && whales.data ? filterSightings(whales.data.sightings, whaleFilters, Date.parse(whales.data.fetchedAt) / 1000) : []),
    [whales.data, whaleFilters],
  );

  // Hydrophones with the bouts heard on each in the time range, newest first.
  const hydrophoneMarks = useMemo<HydrophoneDatum[]>(() => {
    if (!whaleFilters.hydrophonesOnMap || !acoustic.data) return [];
    const recent = boutsInWindow(acoustic.data.bouts, whaleFilters.days, Date.parse(acoustic.data.fetchedAt) / 1000);
    return acoustic.data.hydrophones.map((h) => ({ ...h, bouts: recent.filter((b) => b.hydrophoneId === h.id) }));
  }, [acoustic.data, whaleFilters]);

  const alphaFor = (mmsi: number) => (selected == null || selected === mmsi ? 255 : 70);
  const classColor = (v: VesselTrack) => CLASS_COLORS[theme][v.cls];

  const layers = [
    new PathLayer<PathDatum>({
      id: "tracks",
      data: paths,
      getPath: (d) => d.path,
      getColor: (d) =>
        colorMode === "class"
          ? [...classColor(d.vessel), alphaFor(d.vessel.mmsi)]
          : // Per-vertex colors: PathLayer accepts an array of colors, one per vertex.
            (d.sogs.map((s) => [...speedColor(s), alphaFor(d.vessel.mmsi)]) as unknown as RGBA),
      getWidth: (d) => (d.vessel.mmsi === selected ? 4 : d.vessel.whaleWatch ? 3 : 2),
      widthUnits: "pixels",
      capRounded: true,
      jointRounded: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 90],
      onClick: ({ object }) => object && setSelected(object.vessel.mmsi),
      updateTriggers: { getColor: [colorMode, selected, theme], getWidth: [selected] },
    }),
    new ScatterplotLayer<FixDatum>({
      id: "fixes",
      data: fixes,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => (d.vessel.mmsi === selected ? 5 : d.vessel.whaleWatch ? 5 : 4),
      radiusUnits: "pixels",
      stroked: true,
      lineWidthUnits: "pixels",
      // Whale-watch boats get an ink outline so they stand out among Class A/B traffic.
      getLineWidth: (d) => (d.vessel.whaleWatch ? 2 : 1.5),
      getLineColor: (d) => (d.vessel.whaleWatch ? [...INK[theme], 230] : [...SURFACE[theme], 230]),
      getFillColor: (d) =>
        colorMode === "class" ? [...classColor(d.vessel), alphaFor(d.vessel.mmsi)] : [...speedColor(d.sog), alphaFor(d.vessel.mmsi)],
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 120],
      onClick: ({ object }) => object && setSelected(object.vessel.mmsi),
      updateTriggers: { getFillColor: [colorMode, selected, theme], getRadius: [selected], getLineColor: [theme] },
    }),
    // Hydrophones: a diamond (on a surface-colored diamond, so it reads over
    // tracks), ringed in the species color of the latest call heard there.
    new ScatterplotLayer<HydrophoneDatum>({
      id: "hydrophone-rings",
      data: hydrophoneMarks.filter((h) => h.bouts.length),
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 13,
      radiusUnits: "pixels",
      filled: false,
      stroked: true,
      lineWidthUnits: "pixels",
      getLineWidth: 3,
      getLineColor: (d) => {
        const c = SPECIES_COLORS[theme][d.bouts[0].species];
        return c ? [...hex(c), 255] : [...INK[theme], 255];
      },
      updateTriggers: { getLineColor: [theme] },
    }),
    new IconLayer<HydrophoneDatum>({
      id: "hydrophone-halo",
      data: hydrophoneMarks,
      getPosition: (d) => [d.lon, d.lat],
      getIcon: () => DIAMOND,
      getSize: (d) => (d.id === selectedHydrophone ? 24 : 19),
      getColor: () => [...SURFACE[theme], 240],
      updateTriggers: { getColor: [theme], getSize: [selectedHydrophone] },
    }),
    new IconLayer<HydrophoneDatum>({
      id: "hydrophones",
      data: hydrophoneMarks,
      getPosition: (d) => [d.lon, d.lat],
      getIcon: () => DIAMOND,
      getSize: (d) => (d.id === selectedHydrophone ? 18 : 14),
      getColor: (d) => (d.bouts.length ? [...INK[theme], 255] : [137, 135, 129, 255]),
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 120],
      onClick: ({ object }) => {
        if (!object) return;
        setSelectedHydrophone(object.id);
        setWhaleView("heard");
        setTab("whales");
        setPanelOpen(true);
      },
      updateTriggers: { getColor: [theme], getSize: [selectedHydrophone] },
    }),
    // Whale reports sit on top of the boats: bigger dots, colored by species,
    // fading with age. "Other" species have no hue and are drawn as rings.
    new ScatterplotLayer<WhaleSighting>({
      id: "whales",
      data: whaleMarks,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => (d.id === selectedWhale ? 11 : 8),
      radiusUnits: "pixels",
      stroked: true,
      lineWidthUnits: "pixels",
      getLineWidth: (d) => (d.id === selectedWhale ? 3 : 2),
      getFillColor: (d) => {
        const c = SPECIES_COLORS[theme][d.species];
        return c ? [...hex(c), whaleAlpha(d.t)] : [0, 0, 0, 0];
      },
      getLineColor: (d) =>
        d.id === selectedWhale || !SPECIES_COLORS[theme][d.species] ? [...INK[theme], whaleAlpha(d.t)] : [...SURFACE[theme], 230],
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 120],
      onClick: ({ object }) => object && setSelectedWhale(object.id),
      updateTriggers: { getFillColor: [theme], getLineColor: [theme, selectedWhale], getRadius: [selectedWhale], getLineWidth: [selectedWhale] },
    }),
  ];

  const getTooltip = ({ object, layer }: PickingInfo) => {
    if (!object) return null;
    if (layer?.id === "hydrophones") {
      const h = object as HydrophoneDatum;
      const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
      const span = windowLabel(whaleFilters.days);
      const latest = h.bouts[0];
      return {
        html:
          `<b>${esc(h.name)}</b> · hydrophone<br/>` +
          (latest
            ? `Whale calls heard ${h.bouts.length} time${h.bouts.length === 1 ? "" : "s"} in the last ${span}<br/>Latest: ${esc(latest.name)}, ${ago(latest.start)}`
            : `No whale calls identified in the last ${span}`),
        style: tooltipStyle(theme),
      };
    }
    if (layer?.id === "whales") {
      const w = object as WhaleSighting;
      const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
      return {
        html:
          `<b>${esc(w.label)}${w.count && w.count > 1 ? ` × ${w.count}` : ""}</b>${w.verified ? " · verified" : ""}` +
          `<br/>${fmtDate(w.t)} · ${ago(w.t)}` +
          (w.comments ? `<br/><span style="display:inline-block;max-width:260px;white-space:normal">${esc(w.comments)}</span>` : ""),
        style: tooltipStyle(theme),
      };
    }
    const v: VesselTrack = object.vessel;
    const ww = v.whaleWatch ? `<br/>Whale watch · ${v.whaleWatch.operator}${v.whaleWatch.confirmed ? "" : " (unconfirmed)"}` : "";
    const head = `<b>${v.name || "(no name)"}</b>${ww}<br/>MMSI ${v.mmsi} · Class ${v.cls} · ${shipTypeLabel(v.shipType)}${v.lengthM ? ` · ${v.lengthM} m` : ""}`;
    if (layer?.id === "fixes") {
      const f = object as FixDatum;
      return {
        html: `${head}<br/>${fmtDate(f.t)} · ${f.sog != null ? `${f.sog.toFixed(1)} kn` : "speed —"}${f.cog != null ? ` · ${Math.round(f.cog)}°` : ""}`,
        style: tooltipStyle(theme),
      };
    }
    return {
      html: `${head}<br/>${v.fixes.length} fixes · ${v.distanceNm.toFixed(1)} nm · max ${v.maxSog.toFixed(1)} kn`,
      style: tooltipStyle(theme),
    };
  };

  const deckProps: MapboxOverlayProps = {
    layers,
    getTooltip,
    // Clicking empty map clears the selection; clicks on marks are handled per layer.
    onClick: (info) => {
      if (info.object) return;
      setSelected(null);
      setSelectedWhale(null);
      setSelectedHydrophone(null);
    },
  };

  // Push the current layers to the attached overlay after every render.
  useEffect(() => {
    deckRef.current?.overlay.setProps(deckProps);
    if (process.env.NODE_ENV !== "production") (window as unknown as { __wb: unknown }).__wb = { deckRef, mapRef };
  });

  const attachDeck = (map: MapLibreMap, retries = 0) => {
    // A new map instance means the previous one (and its controls) was removed.
    if (deckRef.current?.map === map && retries === 0) return;
    const overlay = new MapboxOverlay({ interleaved: false });
    map.addControl(overlay);
    deckRef.current = { map, overlay, retries };
    setDeckAttached((n) => n + 1); // re-render so the effect above pushes layers

    const canvas = map.getContainer().querySelector<HTMLCanvasElement>("canvas#deckgl-overlay");
    if (!canvas) return;
    let replaced = false;
    const replace = () => {
      if (replaced || deckRef.current?.overlay !== overlay || retries >= MAX_DECK_RETRIES) return;
      replaced = true;
      console.warn(`deck.gl WebGL context lost; recreating the overlay (attempt ${retries + 1})`);
      map.removeControl(overlay);
      // A GPU reset also takes MapLibre's context down. MapLibre restores itself,
      // but the overlay can only be re-added once the map is rendering again.
      const reattach = () => attachDeck(map, retries + 1);
      if (!map.getCanvas().getContext("webgl2")?.isContextLost() && map.isStyleLoaded()) reattach();
      else map.once("idle", reattach);
    };
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      // Give the browser a moment before asking for a new context.
      setTimeout(replace, 500);
    });
    // A context can also be lost before the listener is attached.
    setTimeout(() => {
      if (canvas.isConnected && canvas.getContext("webgl2")?.isContextLost()) replace();
    }, 2000);
  };

  // Location button, below the zoom buttons. Nothing is asked for until it is
  // tapped. Like Google and Apple Maps, the first tap centers on the user and
  // follows them; panning away stops following (the dot stays); tapping again
  // re-centers. Added by hand once per map, like the deck overlay: under
  // Strict Mode react-map-gl's <GeolocateControl> re-adds the same control,
  // which attaches two click handlers and a tap turns it on and off again.
  const locateMap = useRef<MapLibreMap | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const attachLocate = (map: MapLibreMap) => {
    if (locateMap.current === map) return;
    locateMap.current = map;
    const control = new GeolocateControl({
      trackUserLocation: true,
      showAccuracyCircle: true,
      positionOptions: { enableHighAccuracy: true, timeout: 10_000 },
    });
    // Center the dot in the part of the map the panel doesn't cover (the
    // bottom sheet on phones). Read on every camera move, so it follows the
    // panel being hidden or resized.
    Object.defineProperty(control.options, "fitBoundsOptions", {
      get: () => {
        const r = panelRef.current?.getBoundingClientRect();
        const m = 40;
        if (!r) return { maxZoom: 13 };
        const phone = window.innerWidth < 640;
        return {
          maxZoom: 13,
          padding: phone
            ? { top: m, left: m, right: m, bottom: Math.max(m, window.innerHeight - r.top + 16) }
            : { top: m, right: m, bottom: m, left: Math.max(m, r.right + 16) },
        };
      },
    });
    control.on("geolocate", () => setLocateError(null));
    control.on("error", (e) => {
      console.warn("geolocate:", e.code, e.message);
      setLocateError(
        e.code === 1
          ? "Location access is off for this site. Allow it in your browser settings to see where you are."
          : "Couldn't find your location right now. Please try again.",
      );
      if (locateTimer.current) clearTimeout(locateTimer.current);
      locateTimer.current = setTimeout(() => setLocateError(null), 6000);
    });
    map.addControl(control, "top-right");
  };

  const focusVessel = (v: VesselTrack) => {
    setSelected(v.mmsi);
    if (!v.fixes.length) return;
    const lons = v.fixes.map((f) => f.lon);
    const lats = v.fixes.map((f) => f.lat);
    const [w, e, s, n] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
    if (e - w < 0.005 && n - s < 0.005) mapRef.current?.flyTo({ center: [w, s], zoom: 14 });
    else mapRef.current?.fitBounds([[w, s], [e, n]], { padding: 80, maxZoom: 14 });
  };

  const focusHydrophone = (h: Hydrophone) => {
    setSelectedHydrophone(h.id);
    if (!whaleFilters.hydrophonesOnMap) setWhaleFilters({ ...whaleFilters, hydrophonesOnMap: true });
    mapRef.current?.flyTo({ center: [h.lon, h.lat], zoom: Math.max(mapRef.current.getZoom(), 11) });
  };

  const focusWhale = (w: WhaleSighting) => {
    setSelectedWhale(w.id);
    if (!whaleFilters.onMap) setWhaleFilters({ ...whaleFilters, onMap: true });
    mapRef.current?.flyTo({ center: [w.lon, w.lat], zoom: Math.max(mapRef.current.getZoom(), 11) });
  };

  // The newest day on the map, in local (Pacific) time: sighting logs are kept by day.
  const sampleDate = data?.end ? new Date(data.end * 1000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) : null;

  const movingCount = data?.vessels.filter((v) => v.moving).length ?? 0;
  const ink = theme === "dark" ? "text-white" : "text-[#0b0b0b]";
  const panelBg = theme === "dark" ? "bg-[#1a1a19]/95 border-white/10" : "bg-[#fcfcfb]/95 border-black/10";
  const secondary = theme === "dark" ? "text-[#c3c2b7]" : "text-[#52514e]";

  return (
    <div className="relative h-dvh w-full">
      <MapGL
        ref={mapRef}
        initialViewState={INITIAL_VIEW}
        mapStyle={BASEMAPS[basemap].url}
        style={{ width: "100%", height: "100%" }}
        onLoad={(e) => {
          attachDeck(e.target);
          attachLocate(e.target);
        }}
        onStyleData={(e) => setDepthAnchorReady(Boolean(e.target.getLayer(DEPTH_BEFORE)))}
      >
        {basemap === "depth" && depthAnchorReady && (
          <>
            <Source id="depth-areas" type="geojson" data="/depth/areas.geojson" attribution="Depths: NOAA ENC · not for navigation">
              <Layer id="depth-areas" type="fill" beforeId={DEPTH_BEFORE} paint={{ "fill-color": DEPTH_FILL, "fill-antialias": false }} />
            </Source>
            <Source id="depth-contours" type="geojson" data="/depth/contours.geojson">
              <Layer
                id="depth-contours"
                type="line"
                beforeId={DEPTH_BEFORE}
                paint={{ "line-color": "#5f86a8", "line-opacity": 0.45, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.4, 13, 1] }}
              />
              <Layer
                id="depth-contour-labels"
                type="symbol"
                minzoom={11}
                layout={{
                  "symbol-placement": "line",
                  "text-field": ["concat", ["to-string", ["round", ["get", "VALDCO"]]], " m"],
                  "text-font": ["Noto Sans Regular"],
                  "text-size": 10,
                  "symbol-spacing": 350,
                }}
                paint={{ "text-color": "#41637f", "text-halo-color": "#e6f1f8", "text-halo-width": 1.2 }}
              />
            </Source>
          </>
        )}
        {noaa && (
          <Source id="noaa-chart" type="raster" tiles={[NOAA_WMS]} tileSize={256} attribution="Charts: NOAA Office of Coast Survey">
            <Layer id="noaa-chart" type="raster" paint={{ "raster-opacity": 0.9 }} />
          </Source>
        )}
        <NavigationControl position="top-right" />
        <ScaleControl position="bottom-right" unit="nautical" />
      </MapGL>

      {locateError && (
        <p
          role="status"
          className={`absolute right-14 top-3 z-20 max-w-64 rounded-lg border px-3 py-2 text-sm shadow-lg ${panelBg} ${ink}`}
        >
          {locateError}
        </p>
      )}

      {/* Control panel: top-left on desktop, bottom sheet on phones */}
      <div
        ref={panelRef}
        className={`absolute z-10 flex flex-col border shadow-lg backdrop-blur ${panelBg} ${ink}
          inset-x-2 bottom-2 max-h-[55dvh] rounded-2xl
          sm:inset-x-auto sm:bottom-auto sm:left-3 sm:top-3 sm:w-80 sm:max-h-[calc(100dvh-1.5rem)]`}
      >
        <button
          className="flex items-center justify-between px-4 py-3 text-left"
          onClick={() => setPanelOpen((o) => !o)}
          aria-expanded={panelOpen}
        >
          <span className="text-base font-semibold">Whaleboat</span>
          <span className={`text-sm ${secondary}`}>{panelOpen ? "Hide" : "Show"}</span>
        </button>

        {panelOpen && (
          <div role="tablist" aria-label="Panel" className="flex gap-4 border-b border-current/10 px-4 text-sm">
            <Tab id="ais" active={tab === "ais"} onClick={() => setTab("ais")} secondary={secondary}>
              AIS
            </Tab>
            <Tab id="sightings" active={tab === "sightings"} onClick={() => setTab("sightings")} secondary={secondary}>
              Sightings
            </Tab>
            <Tab id="whales" active={tab === "whales"} onClick={() => setTab("whales")} secondary={secondary}>
              Whale Location
            </Tab>
          </div>
        )}

        {panelOpen && tab === "sightings" && (
          <div role="tabpanel" id="panel-sightings" aria-labelledby="tab-sightings" className="flex min-h-0 flex-col px-4 pb-4 pt-3 text-sm">
            <SightingsPanel sampleDate={sampleDate} theme={theme} secondary={secondary} />
          </div>
        )}

        {panelOpen && tab === "whales" && (
          <div role="tabpanel" id="panel-whales" aria-labelledby="tab-whales" className="flex min-h-0 flex-col px-4 pb-4 pt-3 text-sm">
            <WhalesPanel
              sightings={whales}
              acoustic={acoustic}
              view={whaleView}
              setView={setWhaleView}
              selectedHydrophone={selectedHydrophone}
              setSelectedHydrophone={setSelectedHydrophone}
              onFocusHydrophone={focusHydrophone}
              filters={whaleFilters}
              setFilters={setWhaleFilters}
              selected={selectedWhale}
              onFocus={focusWhale}
              theme={theme}
              secondary={secondary}
            />
          </div>
        )}

        {panelOpen && tab === "ais" && (
          <div role="tabpanel" id="panel-ais" aria-labelledby="tab-ais" className="flex min-h-0 flex-col gap-3 overflow-hidden px-4 pb-4 pt-3 text-sm">
            {samples.length > 0 ? (
            <label className="flex flex-col gap-1">
              <span className={secondary}>Sample</span>
              <div className="flex gap-2">
                <select
                  className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-2 py-1.5"
                  value={file ?? ""}
                  onChange={(e) => {
                    setSelected(null);
                    setFile(e.target.value);
                    load(e.target.value);
                  }}
                >
                  <option value={WINDOW_ID} className="text-black">
                    Last 48 hours
                  </option>
                  {samples.map((s) => (
                    <option key={s.file} value={s.file} className="text-black">
                      {s.file.replace(/^ais-/, "").replace(/\.jsonl$/, "")} ({Math.round(s.bytes / 1024)} KB)
                    </option>
                  ))}
                </select>
                <button
                  className="rounded-lg border border-current/20 px-2.5"
                  onClick={() => file && load(file)}
                  title="Refresh"
                  aria-label="Refresh"
                >
                  ↻
                </button>
              </div>
            </label>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">Last 48 hours</span>
                <button
                  className="rounded-lg border border-current/20 px-2.5 py-1"
                  onClick={() => load(WINDOW_ID)}
                  title="Refresh"
                  aria-label="Refresh"
                >
                  ↻
                </button>
              </div>
            )}

            {error && <p className="rounded-lg bg-[#d03b3b]/15 px-3 py-2">⚠ {error}</p>}

            {data && data.positionReports > 0 && (
              <p className={secondary}>
                {data.start && data.end ? `${fmtDate(data.start)} – ${fmtDate(data.end)} · ` : ""}
                {data.positionReports.toLocaleString()} positions · {data.vessels.length.toLocaleString()} vessels · {movingCount} moving
              </p>
            )}

            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(BASEMAPS) as BasemapId[]).map((id) => (
                <Chip key={id} active={basemap === id} onClick={() => setBasemap(id)}>
                  {BASEMAPS[id].label}
                </Chip>
              ))}
              <Chip active={noaa} onClick={() => setNoaa((n) => !n)}>
                NOAA chart
              </Chip>
              {noaa && <span className={`w-full text-xs ${secondary}`}>NOAA renders tiles on demand; each can take 10–40 s.</span>}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className={secondary}>Color by</span>
              <Chip active={colorMode === "class"} onClick={() => setColorMode("class")}>
                Class
              </Chip>
              <Chip active={colorMode === "speed"} onClick={() => setColorMode("speed")}>
                Speed
              </Chip>
              <Chip active={movingOnly} onClick={() => setMovingOnly((m) => !m)}>
                Moving only
              </Chip>
              <Chip
                active={whaleOnly}
                onClick={() => {
                  setSelected(null);
                  setWhaleOnly((w) => !w);
                }}
              >
                Whale watch ({whaleCount})
              </Chip>
            </div>

            <Legend mode={colorMode} theme={theme} secondary={secondary} />
            {basemap === "depth" && <DepthLegend secondary={secondary} />}

            {whaleOnly ? (
              <WhaleWatchRoster vessels={vessels} selected={selected} onFocus={focusVessel} theme={theme} secondary={secondary} />
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-lg border border-current/10">
                <table className="w-full table-fixed text-left tabular-nums">
                  <thead className={`sticky top-0 ${panelBg} ${secondary}`}>
                    <tr>
                      <th className="px-2 py-1.5 font-normal">Vessel</th>
                      <th className="w-14 px-2 py-1.5 text-right font-normal">Fixes</th>
                      <th className="w-12 px-2 py-1.5 text-right font-normal">nm</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vessels.map((v) => (
                      <tr
                        key={v.mmsi}
                        onClick={() => focusVessel(v)}
                        className={`cursor-pointer border-t border-current/5 ${v.mmsi === selected ? "bg-current/10" : "hover:bg-current/5"}`}
                      >
                        <td className="px-2 py-1.5">
                          <span className="flex items-center gap-2">
                            <span
                              className="inline-block size-2.5 shrink-0 rounded-full"
                              style={{ background: `rgb(${CLASS_COLORS[theme][v.cls].join(",")})` }}
                              aria-label={`Class ${v.cls}`}
                            />
                            <span className="truncate">{v.name || v.mmsi}</span>
                            {v.whaleWatch && (
                              <span className="shrink-0 rounded-full border border-current/30 px-1.5 text-xs" title={v.whaleWatch.operator}>
                                {v.whaleWatch.confirmed ? "whale watch" : "whale watch?"}
                              </span>
                            )}
                            {v.moving && <span className={`text-xs ${secondary}`}>moving</span>}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right">{v.fixes.length}</td>
                        <td className="px-2 py-1.5 text-right">{v.distanceNm ? v.distanceNm.toFixed(1) : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {selected != null && (
              <button className={`self-start underline ${secondary}`} onClick={() => setSelected(null)}>
                Clear selection
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Every registry boat grouped by operator; boats not in the sample are listed
// but dimmed, so gaps in coverage are visible rather than silently missing.
function WhaleWatchRoster({
  vessels,
  selected,
  onFocus,
  theme,
  secondary,
}: {
  vessels: VesselTrack[];
  selected: number | null;
  onFocus: (v: VesselTrack) => void;
  theme: "light" | "dark";
  secondary: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-lg border border-current/10">
      {OPERATORS.map((op) => (
        <div key={op.id} className="border-t border-current/5 first:border-t-0">
          {op.url ? (
            <a href={op.url} target="_blank" rel="noreferrer" className={`block px-2 pb-0.5 pt-2 text-xs hover:underline ${secondary}`}>
              {op.name}
            </a>
          ) : (
            <span className={`block px-2 pb-0.5 pt-2 text-xs ${secondary}`}>{op.name}</span>
          )}
          {op.vessels.map((rv) => {
            const seen = vessels.filter((v) => v.whaleWatch?.operatorId === op.id && v.whaleWatch.vessel === rv.name);
            if (!seen.length) {
              return (
                <div key={rv.name} className="flex items-center justify-between gap-2 px-2 py-1 opacity-50">
                  <span className="truncate">
                    {rv.name}
                    {rv.homePort && <span className="text-xs"> · {rv.homePort}</span>}
                  </span>
                  <span className="shrink-0 text-xs">not seen</span>
                </div>
              );
            }
            return seen.map((v) => (
              <button
                key={v.mmsi}
                onClick={() => onFocus(v)}
                className={`flex w-full items-center justify-between gap-2 px-2 py-1 text-left tabular-nums ${v.mmsi === selected ? "bg-current/10" : "hover:bg-current/5"}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="inline-block size-2.5 shrink-0 rounded-full"
                    style={{ background: `rgb(${CLASS_COLORS[theme][v.cls].join(",")})` }}
                    aria-label={`Class ${v.cls}`}
                  />
                  <span className="truncate font-medium">{rv.name}</span>
                  {!v.whaleWatch?.confirmed && (
                    <span className={`text-xs ${secondary}`} title="Matched by name only; this may be a different boat">
                      unconfirmed
                    </span>
                  )}
                  {v.moving && <span className={`text-xs ${secondary}`}>moving</span>}
                </span>
                <span className={`shrink-0 text-xs ${secondary}`}>
                  {v.fixes.length} fixes · {v.distanceNm.toFixed(1)} nm
                </span>
              </button>
            ));
          })}
        </div>
      ))}
    </div>
  );
}

// Today's reports are solid; a month-old one is faint.
function whaleAlpha(t: number): number {
  const days = (Date.now() / 1000 - t) / 86400;
  return Math.round(255 - Math.min(1, Math.max(0, (days - 1) / 29)) * 135);
}

function tooltipStyle(theme: "light" | "dark") {
  return {
    background: theme === "dark" ? "#262625" : "#ffffff",
    color: theme === "dark" ? "#ffffff" : "#0b0b0b",
    border: `1px solid ${theme === "dark" ? "rgba(255,255,255,0.1)" : "rgba(11,11,11,0.1)"}`,
    borderRadius: "8px",
    padding: "8px 10px",
    fontSize: "13px",
    lineHeight: "1.4",
    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
  };
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

function Tab({
  id,
  active,
  onClick,
  secondary,
  children,
}: {
  id: PanelTab;
  active: boolean;
  onClick: () => void;
  secondary: string;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      id={`tab-${id}`}
      aria-selected={active}
      aria-controls={`panel-${id}`}
      onClick={onClick}
      className={`-mb-px border-b-2 py-2 ${active ? "border-current font-medium" : `border-transparent ${secondary} hover:border-current/30`}`}
    >
      {children}
    </button>
  );
}

function DepthLegend({ secondary }: { secondary: string }) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex">
        {DEPTH_BANDS.map((b) => (
          <span key={b.label} className="h-2.5 flex-1 first:rounded-l last:rounded-r" style={{ background: b.color }} title={b.label} />
        ))}
      </div>
      {/* One label per swatch: the depth where that band starts. */}
      <div className={`flex ${secondary}`}>
        {["flat", "0", "5", "18", "37", "91", "183 m"].map((l) => (
          <span key={l} className="flex-1">
            {l}
          </span>
        ))}
      </div>
      <span className={secondary}>Water depth from NOAA charts · not for navigation</span>
    </div>
  );
}

function Legend({ mode, theme, secondary }: { mode: ColorMode; theme: "light" | "dark"; secondary: string }) {
  if (mode === "class") {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {(["A", "B"] as const).map((c) => (
          <span key={c} className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="inline-block h-0.5 w-5 rounded" style={{ background: `rgb(${CLASS_COLORS[theme][c].join(",")})` }} />
            Class {c}
          </span>
        ))}
        <span className={`w-full ${secondary}`}>A: ships and commercial · B: small craft</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className={secondary}>0 kn</span>
      <span
        className="h-2 flex-1 rounded"
        style={{ background: `linear-gradient(to right, ${SPEED_RAMP.map((c) => `rgb(${c.join(",")})`).join(",")})` }}
      />
      <span className={secondary}>20+ kn</span>
    </div>
  );
}
