// Download water-depth data for the map's Depth basemap from NOAA ENC Direct
// (the vector data behind NOAA's electronic charts; public domain).
//
//   node scripts/depth-fetch.ts [--band coastal|harbour]
//
// Writes web/public/depth/areas.geojson (depth-area polygons; DRVAL1/DRVAL2 =
// shallowest/deepest depth in meters, negative = dries at low tide) and
// contours.geojson (depth contour lines; VALDCO = depth in meters).
// Not for navigation.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// West, south, east, north. Covers every region in scripts/ais-sample.ts:
// Port Angeles and the San Juans down to Tacoma.
const BBOX = [-123.7, 47.0, -122.1, 48.9];

const BASE = "https://encdirect.noaa.gov/arcgis/rest/services/encdirect";
// Chart scale bands. Coastal is complete for the region and small; harbour is
// far more detailed (and ~8x the features) but only exists near ports.
const BANDS = {
  coastal: { service: "enc_coastal", areas: 166, contours: 82 },
  harbour: { service: "enc_harbour", areas: 227, contours: 104 },
} as const;

const PAGE = 1000; // the service's maxRecordCount

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

type Feature = { type: "Feature"; geometry: unknown; properties: Record<string, number | null> };

async function fetchLayer(service: string, layer: number, fields: string[]): Promise<Feature[]> {
  const features: Feature[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const params = new URLSearchParams({
      geometry: BBOX.join(","),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      where: "1=1",
      outFields: fields.join(","),
      orderByFields: "OBJECTID",
      resultOffset: String(offset),
      resultRecordCount: String(PAGE),
      geometryPrecision: "5", // ~1 m
      f: "geojson",
    });
    const res = await fetch(`${BASE}/${service}/MapServer/${layer}/query?${params}`);
    if (!res.ok) throw new Error(`${service}/${layer}: ${res.status} ${res.statusText}`);
    const body = await res.json();
    if (body.error) throw new Error(`${service}/${layer}: ${JSON.stringify(body.error)}`);
    const page: Feature[] = body.features ?? [];
    for (const f of page) {
      if (!f.geometry) continue;
      // Keep only the styling fields.
      features.push({ type: "Feature", geometry: f.geometry, properties: Object.fromEntries(fields.map((k) => [k, f.properties[k] ?? null])) });
    }
    console.log(`  ${service}/${layer}: ${features.length} features`);
    if (!body.exceededTransferLimit || page.length === 0) return features;
  }
}

const bandId = arg("band", "coastal") as keyof typeof BANDS;
const band = BANDS[bandId];
if (!band) {
  console.error(`Unknown band "${bandId}". Options: ${Object.keys(BANDS).join(", ")}`);
  process.exit(1);
}

const outDir = join("web", "public", "depth");
mkdirSync(outDir, { recursive: true });

const write = (name: string, features: Feature[]) => {
  const path = join(outDir, name);
  const text = JSON.stringify({ type: "FeatureCollection", features });
  writeFileSync(path, text);
  console.log(`${path}: ${features.length} features, ${(text.length / 1e6).toFixed(1)} MB`);
};

console.log(`Fetching ${bandId} depth data for ${BBOX.join(", ")} from NOAA ENC Direct…`);
write("areas.geojson", await fetchLayer(band.service, band.areas, ["DRVAL1", "DRVAL2"]));
write("contours.geojson", await fetchLayer(band.service, band.contours, ["VALDCO"]));
