import { listSamples } from "@/lib/ais";

export async function GET() {
  return Response.json(await listSamples());
}
