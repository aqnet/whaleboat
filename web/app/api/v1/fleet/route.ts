import { fleetResponse } from "@/lib/fleetApi";

// GET /api/v1/fleet -> the public whale-watch boat list (lib/fleetApi.ts).
// Generated once at build time: the list only changes with a deploy.
export const dynamic = "force-static";

export function GET() {
  return Response.json(fleetResponse(new Date().toISOString()), {
    headers: {
      // Any site may read it.
      "Access-Control-Allow-Origin": "*",
      // Browsers for an hour, shared caches for a day.
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
