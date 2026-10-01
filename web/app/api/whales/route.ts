import { loadWhaleSightings } from "@/lib/acartia";

// GET /api/whales  -> Acartia whale sightings in the PNW, last 30 days, newest first
export async function GET() {
  try {
    return Response.json(await loadWhaleSightings());
  } catch (err) {
    // Live fetch failed and nothing has been saved yet.
    return Response.json({ error: `Whale sightings unavailable: ${String(err)}` }, { status: 502 });
  }
}
