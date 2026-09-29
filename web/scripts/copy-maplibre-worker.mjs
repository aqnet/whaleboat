// MapLibre 6 runs its worker as a separate ES module that imports
// ./maplibre-gl-shared.mjs. The Next.js bundler can't resolve that worker URL,
// so serve both files from public/maplibre/ and point setWorkerUrl() at them
// (components/BoatMap.tsx). Runs before dev and build to stay in sync with the
// installed version.
import { copyFileSync, mkdirSync } from "node:fs";

const src = "node_modules/maplibre-gl/dist";
const dest = "public/maplibre";
mkdirSync(dest, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(`${src}/${f}`, `${dest}/${f}`);
