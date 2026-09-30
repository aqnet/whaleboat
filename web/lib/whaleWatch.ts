// Whale-watch registry (spec §4.3): operators and their boats.
//
// Sources: the operators' own fleet pages (checked 2026-09-29) and a one-time
// pull of https://whales.lovejoydiver.net/api/fleet on 2026-09-30, which
// supplied most MMSIs and the operators from Victoria/Vancouver onward.
// Research vessels in that list (NOAA, UW) were left out. 13 of its MMSIs had
// been heard by the recorder by then, and all agreed on name and type.
//
// Matching: an MMSI match always wins and is confirmed. Boats without a known
// MMSI fall back to their broadcast name, flagged `confirmed: false` when the
// name is `generic` (shared with private boats) and AIS doesn't report a
// passenger type (60–69). A registry boat that has MMSIs never matches by
// name: the same name on another MMSI is a different boat.
//
// Keep the MMSIs in step with the whale_watch_vessels table
// (db/migrations/*_whale_watch_vessels.sql), which gives these boats 30-day
// retention and exempts them from the vessel-type filter.

export type WhaleWatchVessel = {
  name: string;
  aliases?: string[];
  mmsis?: number[];
  generic?: boolean;
  homePort?: string;
  note?: string;
};

export type WhaleWatchOperator = { id: string; name: string; url?: string; vessels: WhaleWatchVessel[] };

export const OPERATORS: WhaleWatchOperator[] = [
  {
    id: "pse",
    name: "Puget Sound Express",
    url: "https://www.pugetsoundexpress.com/our-vessels/",
    vessels: [
      { name: "Swiftsure", mmsis: [338519000], homePort: "Edmonds", note: "catamaran, 149 pax", generic: true },
      { name: "Saratoga", mmsis: [368023510], homePort: "Port Townsend", note: "catamaran, 120 pax", generic: true },
      { name: "Glacier Spirit", mmsis: [367121000], homePort: "Port Angeles", note: "60 pax" },
      { name: "Red Head", mmsis: [366889850], homePort: "Port Townsend", note: "56 ft, 40 pax", generic: true },
      { name: "Chilkat Express", mmsis: [367156000], homePort: "Edmonds", note: "jet catamaran" },
    ],
  },
  {
    id: "oix",
    name: "Outer Island Expeditions",
    url: "https://www.outerislandx.com/ourfleet",
    vessels: [
      { name: "Blackfish VI", mmsis: [368616000], homePort: "Anacortes", note: "60 ft catamaran, 80 pax" },
      { name: "Blackfish IV", mmsis: [367784930], homePort: "Anacortes", note: "49 ft catamaran, 49 pax" },
      { name: "Blackfish III", homePort: "Anacortes", note: "38 ft catamaran" },
      { name: "Blackfish II", mmsis: [367524220], homePort: "Anacortes", note: "38 ft catamaran" },
      { name: "Blackfish Express", homePort: "Anacortes", note: "38 ft catamaran" },
      { name: "Triton", mmsis: [367679690], homePort: "Anacortes", note: "32 ft, 12 pax", generic: true },
      { name: "Galiano", homePort: "Anacortes", note: "26 ft, 6 pax", generic: true },
      { name: "Blackfish", mmsis: [367679710], homePort: "Anacortes" },
    ],
  },
  {
    id: "western-prince",
    name: "Western Prince",
    url: "https://orcawhalewatch.com/our-tours/",
    vessels: [
      { name: "Western Explorer II", mmsis: [368026630], homePort: "Friday Harbor", note: "40 ft jet boat, 24 pax" },
      { name: "Western Prince", homePort: "Friday Harbor" },
      { name: "Western Prince II", mmsis: [338562000], homePort: "Friday Harbor" },
    ],
  },
  {
    id: "island-adventures",
    name: "Island Adventures",
    url: "https://island-adventures.com/our-vessels",
    vessels: [
      { name: "Island Explorer 5", mmsis: [369264000], homePort: "Anacortes", note: "98 ft 3-deck catamaran" },
      { name: "Island Explorer 4", homePort: "La Conner" },
      { name: "Island Explorer 3", mmsis: [367161570], homePort: "Port Angeles" },
      { name: "Halcyon", mmsis: [368177750], homePort: "Anacortes" },
    ],
  },
  {
    id: "blue-kingdom",
    name: "Blue Kingdom",
    url: "https://www.bluekingdomtours.com/our-boat/",
    vessels: [
      { name: "Sounder", mmsis: [368295070], homePort: "Anacortes", note: "37 ft RHIB, 17 pax", generic: true },
      { name: "Wake", mmsis: [368400660], homePort: "Anacortes", note: "32 ft aluminum, 6 pax", generic: true },
    ],
  },
  {
    id: "spirit-of-orca",
    name: "Spirit of Orca",
    url: "https://spiritoforca.com/",
    vessels: [
      { name: "Spirit of Orca II", mmsis: [338542989], homePort: "Anacortes", note: "catamaran, 6 pax" },
      { name: "Spirit Of Orca", homePort: "Anacortes" },
    ],
  },
  {
    id: "all-aboard-sailing",
    name: "All Aboard Sailing",
    vessels: [
      { name: "Peniel", mmsis: [368111540], homePort: "Friday Harbor" },
    ],
  },
  {
    id: "bc-whale-tours",
    name: "BC Whale Tours",
    vessels: [
      { name: "BC Tika", mmsis: [316023189], homePort: "Victoria, BC" },
    ],
  },
  {
    id: "deception-pass-tours",
    name: "Deception Pass Tours",
    vessels: [
      { name: "Island Whaler", mmsis: [366801000], homePort: "Anacortes" },
    ],
  },
  {
    id: "deer-harbor-charters",
    name: "Deer Harbor Charters",
    vessels: [
      { name: "Pelagic II", mmsis: [368355000], homePort: "Orcas Island" },
      { name: "Squito", mmsis: [367631000], homePort: "Orcas Island" },
    ],
  },
  {
    id: "eagle-wing-tours",
    name: "Eagle Wing Tours",
    vessels: [
      { name: "4 Ever Wild", mmsis: [316028179], homePort: "Victoria, BC" },
      { name: "Goldwing", mmsis: [316007107], homePort: "Victoria, BC" },
      { name: "Serengeti", mmsis: [316008468], homePort: "Victoria, BC" },
      { name: "Wild 4 Whales", mmsis: [316034816], homePort: "Victoria, BC" },
      { name: "Wildcat 4", mmsis: [316051368], homePort: "Victoria, BC" },
    ],
  },
  {
    id: "five-star-whale-watching",
    name: "Five Star Whale Watching",
    vessels: [
      { name: "Kuluta", mmsis: [316008708], homePort: "Victoria, BC" },
      { name: "Salish Shadow", mmsis: [316037728], homePort: "Victoria, BC" },
      { name: "Supercat", mmsis: [316003705], homePort: "Victoria, BC" },
    ],
  },
  {
    id: "frs-clipper",
    name: "FRS Clipper",
    vessels: [
      { name: "Emerald Clipper", mmsis: [368457860], homePort: "Seattle (Pier 69)" },
      { name: "San Juan Clipper", mmsis: [366902890], homePort: "Seattle" },
    ],
  },
  {
    id: "maya-s-legacy",
    name: "Maya's Legacy",
    vessels: [
      { name: "J1", mmsis: [367742760], homePort: "Friday Harbor" },
      { name: "J2", mmsis: [368032220], homePort: "Friday Harbor" },
    ],
  },
  {
    id: "mystic-sea-charters",
    name: "Mystic Sea Charters",
    vessels: [
      { name: "Mystic Sea", mmsis: [338393768], homePort: "Anacortes" },
    ],
  },
  {
    id: "ocean-ecoventures",
    name: "Ocean EcoVentures",
    vessels: [
      { name: "Onyx", mmsis: [316041457], homePort: "Cowichan Bay, BC" },
      { name: "Prowler", mmsis: [316049389], homePort: "Cowichan Bay, BC" },
      { name: "Sonic", mmsis: [316009175], homePort: "Cowichan Bay, BC" },
    ],
  },
  {
    id: "orca-spirit-adventures",
    name: "Orca Spirit Adventures",
    vessels: [
      { name: "Catalina Adventure", mmsis: [316028008], homePort: "Victoria, BC" },
      { name: "Haisla Explorer", mmsis: [316006859], homePort: "Victoria, BC" },
      { name: "Orca Mist", mmsis: [316029172], homePort: "Victoria, BC" },
      { name: "Orca Spirit", mmsis: [316005064], homePort: "Victoria, BC" },
      { name: "Orca Spirit II", mmsis: [316018618], homePort: "Victoria, BC" },
      { name: "Pacific Explorer I", mmsis: [316010956], homePort: "Victoria, BC" },
    ],
  },
  {
    id: "prince-of-whales",
    name: "Prince of Whales",
    vessels: [
      { name: "Ocean Magic", mmsis: [316006789], homePort: "Victoria, BC" },
      { name: "Ocean Magic II", mmsis: [316008331], homePort: "Telegraph Cove, BC" },
      { name: "Salish Sea Dream", mmsis: [316032858], homePort: "Vancouver, BC" },
      { name: "Salish Sea Eclipse", mmsis: [316039686], homePort: "Victoria, BC" },
      { name: "Salish Sea Freedom", mmsis: [316042213], homePort: "Victoria, BC" },
      { name: "Salish Sea Glory", mmsis: [316059231], homePort: "Victoria, BC" },
    ],
  },
  {
    id: "san-juan-cruises",
    name: "San Juan Cruises",
    vessels: [
      { name: "Rosario", mmsis: [368643000], homePort: "Bellingham" },
      { name: "Salish Express", mmsis: [369329000], homePort: "Bellingham" },
      { name: "Salish Sea", mmsis: [367395870], homePort: "Bellingham" },
      { name: "Victoria Star 2", mmsis: [367091440], homePort: "Bellingham" },
    ],
  },
  {
    id: "san-juan-excursions",
    name: "San Juan Excursions",
    vessels: [
      { name: "Odyssey", mmsis: [367351090], homePort: "Friday Harbor" },
    ],
  },
  {
    id: "san-juan-safaris",
    name: "San Juan Safaris",
    vessels: [
      { name: "Kestrel", mmsis: [367014000], homePort: "Friday Harbor" },
      { name: "Osprey", mmsis: [338576000], homePort: "Friday Harbor" },
      { name: "Sea Lion", mmsis: [338191000], homePort: "Friday Harbor" },
    ],
  },
  {
    id: "seaking-adventures",
    name: "SeaKing Adventures",
    vessels: [
      { name: "Sea King", mmsis: [316009443], homePort: "Victoria, BC" },
    ],
  },
  {
    id: "springtide",
    name: "SpringTide",
    vessels: [
      { name: "Marauder IV", mmsis: [316004946], homePort: "Victoria, BC" },
      { name: "Springtide I", mmsis: [316006213], homePort: "Victoria, BC" },
    ],
  },
  {
    id: "steveston-seabreeze-adventures",
    name: "Steveston Seabreeze Adventures",
    vessels: [
      { name: "Seabreeze I", mmsis: [316034303], homePort: "Steveston, BC" },
      { name: "Triple 8", mmsis: [316007866], homePort: "Steveston, BC" },
    ],
  },
  {
    id: "vancouver-island-whale-watch",
    name: "Vancouver Island Whale Watch",
    vessels: [
      { name: "Cascadia", mmsis: [316036809], homePort: "Nanaimo, BC" },
      { name: "Keta", mmsis: [316036225], homePort: "Nanaimo, BC" },
      { name: "Kula", mmsis: [316042661], homePort: "Nanaimo, BC" },
    ],
  },
  {
    id: "vancouver-whale-watch",
    name: "Vancouver Whale Watch",
    vessels: [
      { name: "Explorathor Express", mmsis: [316008045], homePort: "Steveston, BC" },
      { name: "Explorathor II", mmsis: [316008046], homePort: "Steveston, BC" },
      { name: "Lightship 1", mmsis: [316014609], homePort: "Steveston, BC" },
      { name: "Strider I", mmsis: [316035167], homePort: "Steveston, BC" },
    ],
  },
  {
    id: "white-rock-sea-tours",
    name: "White Rock Sea Tours",
    vessels: [
      { name: "Spartan 01", mmsis: [316041693], homePort: "White Rock, BC" },
      { name: "Spartan 2", mmsis: [316050913], homePort: "White Rock, BC" },
    ],
  },
  {
    id: "wild-whales-vancouver",
    name: "Wild Whales Vancouver",
    vessels: [
      { name: "Aurora I", mmsis: [316040487], homePort: "Vancouver, BC" },
      { name: "Aurora II", mmsis: [316040366], homePort: "Vancouver, BC" },
      { name: "Eagle Eyes", mmsis: [316034894], homePort: "Vancouver, BC" },
      { name: "Jing Yu", mmsis: [316032442], homePort: "Vancouver, BC" },
    ],
  },
  {
    id: "unknown",
    name: "Operator unknown",
    vessels: [
      { name: "Peregrine", mmsis: [368406750], homePort: "Friday Harbor" },
    ],
  },
];

export type WhaleWatchMatch = { operatorId: string; operator: string; vessel: string; by: "mmsi" | "name"; confirmed: boolean };

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
  const hit = (e: Entry, by: WhaleWatchMatch["by"], confirmed: boolean): WhaleWatchMatch => ({
    operatorId: e.operator.id,
    operator: e.operator.name,
    vessel: e.vessel.name,
    by,
    confirmed,
  });
  const m = byMmsi.get(mmsi);
  if (m) return hit(m, "mmsi", true);
  const e = name ? byName.get(normalizeName(name)) : undefined;
  // A registry boat with known MMSIs showing up under another MMSI is a
  // different boat with the same name (several OSPREYs, ODYSSEYs, CASCADIAs).
  if (!e || e.vessel.mmsis?.length) return null;
  return hit(e, "name", !e.vessel.generic || isPassenger(shipType));
}
