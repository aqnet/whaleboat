import type { NextRequest } from "next/server";
import { listSamples, loadSample } from "@/lib/ais";

// GET /api/tracks?file=<sample.jsonl>  (defaults to the newest sample)
export async function GET(request: NextRequest) {
  const samples = await listSamples();
  const requested = request.nextUrl.searchParams.get("file");
  // Only serve files that are actually in the samples directory listing.
  const file = requested ? samples.find((s) => s.file === requested)?.file : samples[0]?.file;
  if (!file) {
    return Response.json({ error: requested ? `Unknown sample "${requested}"` : "No samples yet" }, { status: 404 });
  }
  return Response.json(await loadSample(file));
}
