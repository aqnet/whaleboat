import { describe, expect, it } from "vitest";
import { classifyBout, parseBouts, parseFeeds } from "./orcasound";

// Shaped like https://live.orcasound.net/api/json/feeds and /bouts.
const feed = (id: string, slug: string, over: Record<string, unknown> = {}) => ({
  id,
  type: "feed",
  attributes: { name: slug, slug, node_name: `rpi_${slug}`, lat_lng: { lat: 48.546653, lng: -123.166408 }, visible: true, ...over },
});

const bout = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: "bout",
  attributes: {
    category: "biophony",
    name: "J pod SB (Andrews Bay)",
    start_time: "2026-09-22T04:51:37.973000Z",
    end_time: "2026-09-22T05:16:19.237000Z",
    feed_id: "feed_ab",
    ...over,
  },
});

describe("classifyBout", () => {
  it("reads the orca ecotype from the reviewer's name", () => {
    expect(classifyBout("J pod SB (Andrews Bay)")).toEqual({ species: "Orca", ecotype: "Southern Resident" });
    expect(classifyBout("SRKW calls")).toEqual({ species: "Orca", ecotype: "Southern Resident" });
    expect(classifyBout("Bigg's calls faint & brief (OSL)")).toEqual({ species: "Orca", ecotype: "Bigg's" });
    expect(classifyBout("Calls, maybe T60D & T60E (AB)")).toEqual({ species: "Orca", ecotype: "Bigg's" });
    expect(classifyBout("KWcalls?@Orcasound Lab")).toEqual({ species: "Orca", ecotype: null });
  });

  it("recognizes other whales and leaves the rest as Other", () => {
    expect(classifyBout("Humpback song")).toEqual({ species: "Humpback", ecotype: null });
    expect(classifyBout("Sea lion barks")).toEqual({ species: "Other", ecotype: null });
  });
});

describe("parseFeeds", () => {
  it("keeps visible hydrophones with a position and links their live stream", () => {
    const hs = parseFeeds({
      data: [
        feed("feed_ab", "andrews-bay", { name: "Andrews Bay" }),
        feed("feed_no", "lehmkuhl", { visible: false }),
        feed("feed_nopos", "nowhere", { lat_lng: null }),
      ],
    });
    expect(hs).toEqual([{ id: "feed_ab", name: "Andrews Bay", lat: 48.546653, lon: -123.166408, url: "https://live.orcasound.net/listen/andrews-bay" }]);
  });
});

describe("parseBouts", () => {
  const ids = new Set(["feed_ab"]);

  it("reads a bout with its times, species and page", () => {
    expect(parseBouts([bout("bout_1")], ids)).toEqual([
      {
        id: "bout_1",
        hydrophoneId: "feed_ab",
        start: Date.parse("2026-09-22T04:51:37.973Z") / 1000,
        end: Date.parse("2026-09-22T05:16:19.237Z") / 1000,
        name: "J pod SB (Andrews Bay)",
        species: "Orca",
        ecotype: "Southern Resident",
        url: "https://live.orcasound.net/bouts/bout_1",
      },
    ]);
  });

  it("drops boat noise, unknown hydrophones and bad times; newest first", () => {
    const out = parseBouts(
      [
        bout("old", { start_time: "2026-09-01T00:00:00Z" }),
        bout("boat", { category: "anthrophony" }),
        bout("elsewhere", { feed_id: "feed_hidden" }),
        bout("notime", { start_time: null }),
        bout("new", { start_time: "2026-09-30T14:03:05Z", end_time: null, name: "  " }),
      ],
      ids,
    );
    expect(out.map((b) => b.id)).toEqual(["new", "old"]);
    expect(out[0]).toMatchObject({ name: "Whale calls", species: "Other", end: out[0].start });
  });
});
