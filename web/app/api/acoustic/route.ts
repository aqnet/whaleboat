import { loadAcoustic } from "@/lib/orcasound";

// GET /api/acoustic  -> Orcasound hydrophones and the whale-call bouts its experts identified, last 30 days
export async function GET() {
  try {
    return Response.json(await loadAcoustic());
  } catch (err) {
    // Live fetch failed and there is no earlier copy in memory.
    return Response.json({ error: `Hydrophone reports unavailable: ${String(err)}` }, { status: 502 });
  }
}
