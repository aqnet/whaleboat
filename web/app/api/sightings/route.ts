import { loadSightings } from "@/lib/sightings";

// GET /api/sightings  -> Western Prince's daily sighting log (all seasons on the page)
export async function GET() {
  try {
    return Response.json(await loadSightings());
  } catch (err) {
    // Live fetch failed and there is no snapshot yet.
    return Response.json({ error: `Sighting log unavailable: ${String(err)}` }, { status: 502 });
  }
}
