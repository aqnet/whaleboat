// Bootstrap whale-watch registry (spec §4.3): operators and the boats they
// list on their own sites, checked 2026-09-29. No MMSIs yet, so vessels are
// matched on their broadcast AIS name. Add an MMSI to `mmsis` once a boat is
// confirmed in a sample; an MMSI match beats any name match.
//
// Names like SARATOGA or WAKE are shared with private boats, so `generic`
// vessels only match when AIS also reports a passenger ship type (60–69).

export type WhaleWatchVessel = {
  name: string;
  aliases?: string[];
  mmsis?: number[];
  generic?: boolean;
  homePort?: string;
  note?: string;
};

export type WhaleWatchOperator = { id: string; name: string; url: string; vessels: WhaleWatchVessel[] };

export const OPERATORS: WhaleWatchOperator[] = [
  {
    id: "pse",
    name: "Puget Sound Express",
    url: "https://www.pugetsoundexpress.com/our-vessels/",
    vessels: [
      { name: "Swiftsure", homePort: "Edmonds", note: "catamaran, 149 pax", generic: true },
      { name: "Saratoga", homePort: "Port Townsend", note: "catamaran, 120 pax", generic: true },
      { name: "Glacier Spirit", homePort: "Port Angeles", note: "60 pax" },
      { name: "Red Head", homePort: "Port Townsend", note: "56 ft, 40 pax", generic: true },
      { name: "Chilkat Express", note: "jet catamaran" },
    ],
  },
  {
    id: "oix",
    name: "Outer Island Expeditions",
    url: "https://www.outerislandx.com/ourfleet",
    vessels: [
      { name: "Blackfish VI", homePort: "Anacortes", note: "60 ft catamaran, 80 pax" },
      { name: "Blackfish IV", homePort: "Anacortes", note: "49 ft catamaran, 49 pax" },
      { name: "Blackfish III", homePort: "Anacortes", note: "38 ft catamaran" },
      { name: "Blackfish II", homePort: "Anacortes", note: "38 ft catamaran" },
      { name: "Blackfish Express", homePort: "Anacortes", note: "38 ft catamaran" },
      { name: "Triton", homePort: "Anacortes", note: "32 ft, 12 pax", generic: true },
      { name: "Galiano", homePort: "Anacortes", note: "26 ft, 6 pax", generic: true },
    ],
  },
  {
    id: "western-prince",
    name: "Western Prince",
    url: "https://orcawhalewatch.com/our-tours/",
    vessels: [{ name: "Western Explorer II", homePort: "Friday Harbor", note: "40 ft jet boat, 24 pax" }],
  },
  {
    id: "island-adventures",
    name: "Island Adventures",
    url: "https://island-adventures.com/our-vessels",
    vessels: [
      { name: "Island Explorer 5", homePort: "Anacortes", note: "98 ft 3-deck catamaran" },
      { name: "Island Explorer 4", homePort: "La Conner" },
      { name: "Island Explorer 3", homePort: "Port Angeles" },
    ],
  },
  {
    id: "blue-kingdom",
    name: "Blue Kingdom",
    url: "https://www.bluekingdomtours.com/our-boat/",
    vessels: [
      { name: "Sounder", note: "37 ft RHIB, 17 pax", generic: true },
      { name: "Wake", note: "32 ft aluminum, 6 pax", generic: true },
    ],
  },
  {
    id: "spirit-of-orca",
    name: "Spirit of Orca",
    url: "https://spiritoforca.com/",
    vessels: [{ name: "Spirit of Orca II", note: "catamaran, 6 pax" }],
  },
];

export type WhaleWatchMatch = { operatorId: string; operator: string; vessel: string; by: "mmsi" | "name" };

const ROMAN: Record<string, string> = { I: "1", II: "2", III: "3", IV: "4", V: "5", VI: "6", VII: "7", VIII: "8", IX: "9", X: "10" };

// "M/V Blackfish VI " and "BLACKFISH 6" -> "BLACKFISH 6". Only a trailing
// numeral is converted, so "V" in the middle of a name is left alone.
export function normalizeName(s: string): string {
  const words = s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/^(M ?V|F ?V) /, "")
    .split(" ")
    .filter(Boolean);
  const last = words.at(-1);
  if (words.length > 1 && last && ROMAN[last]) words[words.length - 1] = ROMAN[last];
  return words.join(" ");
}

type Entry = { operator: WhaleWatchOperator; vessel: WhaleWatchVessel };
const byName = new Map<string, Entry>();
const byMmsi = new Map<number, Entry>();
for (const operator of OPERATORS) {
  for (const vessel of operator.vessels) {
    for (const n of [vessel.name, ...(vessel.aliases ?? [])]) byName.set(normalizeName(n), { operator, vessel });
    for (const m of vessel.mmsis ?? []) byMmsi.set(m, { operator, vessel });
  }
}

const isPassenger = (t: number | null) => t != null && t >= 60 && t <= 69;

export function matchWhaleWatch(mmsi: number, name: string, shipType: number | null): WhaleWatchMatch | null {
  const hit = (e: Entry, by: WhaleWatchMatch["by"]): WhaleWatchMatch => ({
    operatorId: e.operator.id,
    operator: e.operator.name,
    vessel: e.vessel.name,
    by,
  });
  const m = byMmsi.get(mmsi);
  if (m) return hit(m, "mmsi");
  const e = name ? byName.get(normalizeName(name)) : undefined;
  if (!e || (e.vessel.generic && !isPassenger(shipType))) return null;
  return hit(e, "name");
}
