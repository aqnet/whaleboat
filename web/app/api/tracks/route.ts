import type { NextRequest } from "next/server";
import { listSamples, loadSample, loadWindow } from "@/lib/ais";

// GET /api/tracks                      -> every sample in the last 48 h, merged (spec §8.5 default)
// GET /api/tracks?file=<sample.jsonl>  -> one sample on its own
export async function GET(request: NextRequest) {
  const requested = request.nextUrl.searchParams.get("file");
  if (!requested) return Response.json(await loadWindow());
  // Only serve files that are actually in the samples directory listing.
  const file = (await listSamples()).find((s) => s.file === requested)?.file;
  if (!file) return Response.json({ error: `Unknown sample "${requested}"` }, { status: 404 });
  return Response.json(await loadSample(file));
}
