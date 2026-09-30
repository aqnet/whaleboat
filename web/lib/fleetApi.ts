// Public, read-only list of whale-watch boats: GET /api/v1/fleet
// (app/api/v1/fleet/route.ts). Built from the registry in whaleWatch.ts.
//
// This is a public contract: other sites may depend on it. Add fields
// freely; renaming or removing one needs /api/v2. The vessel fields match
// whales.lovejoydiver.net/api/fleet (name, mmsi as a string, operator,
// homePort) so clients of that list can switch easily.
//
// Only the list is published, never positions: live whale-watch positions
// amount to a map of where the whales are (spec §10).

import { OPERATORS } from "./whaleWatch";

export type FleetVessel = {
  name: string;
  mmsi: string | null;
  operator: string;
  operatorId: string;
  operatorUrl: string | null;
  homePort: string | null;
};

export type FleetResponse = {
  version: 1;
  generatedAt: string;
  count: number;
  sources: { name: string; url?: string }[];
  notice: string;
  vessels: FleetVessel[];
};

// Boats whose operator isn't known may be private; they stay off the public list.
const UNPUBLISHED_OPERATORS = new Set(["unknown"]);

export function fleetResponse(generatedAt: string): FleetResponse {
  const vessels: FleetVessel[] = [];
  for (const op of OPERATORS) {
    if (UNPUBLISHED_OPERATORS.has(op.id)) continue;
    for (const v of op.vessels) {
      // One entry per MMSI; boats without a known MMSI are listed once, with null.
      const mmsis = v.mmsis?.length ? v.mmsis.map(String) : [null];
      for (const mmsi of mmsis) {
        vessels.push({
          name: v.name,
          mmsi,
          operator: op.name,
          operatorId: op.id,
          operatorUrl: op.url ?? null,
          homePort: v.homePort ?? null,
        });
      }
    }
  }
  vessels.sort((a, b) => a.operator.localeCompare(b.operator) || a.name.localeCompare(b.name));
  return {
    version: 1,
    generatedAt,
    count: vessels.length,
    sources: [
      { name: "Operators' own fleet pages" },
      { name: "whales.lovejoydiver.net", url: "https://whales.lovejoydiver.net/api/fleet" },
    ],
    notice: "Commercial whale-watching vessels in the Salish Sea. Provided as is; not for navigation.",
    vessels,
  };
}
