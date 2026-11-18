import { describe, expect, it } from "vitest";
import type { Card, Deck, LibraryCard } from "./types.ts";
import { parseYdk, toYdk } from "./ydk.ts";
import {
  addTag, applyFilters, buildLibrary, computeTags, computeTiers, csvField, groupCards, importTagsCsv,
  isHandtrap, padDate, parseMultiSort, pyRound, removeTag, sortCards, toCsv, toLflist, unknownCard,
} from "./library.ts";

const card = (id: number, name: string, extra: Partial<Card> = {}): Card => ({
  ...unknownCard(id), name, type: "Effect Monster", kind: "Effect", category: "Monster", desc: "", ...extra,
});
const deck = (name: string, main: number[], extra: number[] = [], side: number[] = [], file_modified: string | null = null): Deck => ({
  id: name, name, main, extra, side, file_modified, file_created: null, created_at: "", updated_at: "",
});
const lib = (cards: Card[], decks: Deck[], custom = {}) =>
  buildLibrary(decks, new Map(cards.map((c) => [c.id, c])), {}, custom);

describe("ydk parsing", () => {
  it("parses sections, comments, BOM and junk like parse_ydk", () => {
    const p = parseYdk("﻿#created by test\r\n#main\r\n123\r\n123\r\n\r\n#extra\n456\n!side\n789\nhello\n#side\n42\n");
    expect(p.main).toEqual([123, 123]);
    expect(p.extra).toEqual([456]);
    expect(p.side).toEqual([789, 42]);
    expect(p.ignored).toEqual(["hello"]);
  });
  it("defaults to main before any marker and round-trips", () => {
    const p = parseYdk("1\n2\n#extra\n3");
    expect(p.main).toEqual([1, 2]);
    expect(parseYdk(toYdk(p))).toMatchObject({ main: [1, 2], extra: [3], side: [] });
  });
});

describe("buildLibrary", () => {
  const a = card(1, "Alpha", { archetype: "Greek" });
  const b = card(2, "Beta", { archetype: "Greek" });
  const decks = [deck("D1", [1, 1, 2], [], [1], "2024-01-05"), deck("D2", [1, 999], [], [], "2023-06-01")];
  it("counts copies (sum / max), decks, sections and keeps unknown ids", () => {
    const cards = lib([a, b], decks);
    const alpha = cards.find((c) => c.id === 1)!;
    expect(alpha.copies).toBe(4);
    expect(alpha.decks).toEqual(["D1", "D2"]);
    expect(alpha.deck_counts).toEqual({ D1: 3, D2: 1 });
    expect(alpha.sections).toEqual(["main", "side"]);
    expect(alpha.archetype_count).toBe(2);
    const unk = cards.find((c) => c.id === 999)!;
    expect(unk.name).toBe("(Unknown card 999)");
    expect(unk.category).toBe("Unknown");
    expect(unk.rel_status).toBe("unknown");
    expect(unk.tier).toBeNull();
    const max = buildLibrary(decks, new Map([[1, a], [2, b]]), {}, {}, { countMode: "max" });
    expect(max.find((c) => c.id === 1)!.copies).toBe(3);
  });
  it("resolves alias ids and honours deck / section filters", () => {
    const cards = buildLibrary([deck("X", [77])], new Map([[1, a]]), { 77: 1 });
    expect(cards.map((c) => c.id)).toEqual([1]);
    const side = buildLibrary(decks, new Map([[1, a], [2, b]]), {}, {}, { section: "side" });
    expect(side.map((c) => [c.id, c.copies])).toEqual([[1, 1]]);
    const d2 = buildLibrary(decks, new Map([[1, a], [2, b]]), {}, {}, { deckFilter: "d2" });
    expect(d2.map((c) => c.id).sort()).toEqual([1, 999]);
  });
});

describe("relations", () => {
  it("links named cards, archetypes and name fragments", () => {
    const cards = lib(
      [
        card(1, "Blue-Eyes White Dragon", { archetype: "Blue-Eyes" }),
        card(2, "Blue-Eyes Alternative White Dragon", { archetype: "Blue-Eyes" }),
        card(3, "The Melody of Awakening Dragon", { desc: 'Add 2 "Blue-Eyes" monsters from your Deck to your hand.' }),
        card(4, "Lonely Card", { desc: 'If you control "Nothing That Exists", draw 1 card.' }),
        card(5, "Pot of Nothing"),
        card(6, "Fan", { archetype: "Fans", desc: 'Banish "Blue-Eyes White Dragon".' }),
      ],
      [deck("D", [1, 2, 3, 4, 5, 6])],
    );
    const by = (id: number) => cards.find((c) => c.id === id)!;
    expect(by(3).rel_links).toEqual({ 1: 2, 2: 2 });
    expect(by(3).rel_status).toBe("thin");
    expect(by(1).rel_links).toEqual({ 3: 4, 6: 4 });
    expect(by(1).related).toBe(3); // mate 2 + named by 3 and 6
    expect(by(1).rel_arch).toBe(1);
    expect(by(4).rel_status).toBe("none");
    expect(by(4).tags).toContain("no-companions");
    expect(by(5).rel_status).toBe("generic");
    expect(by(5).tags).toContain("generic");
    expect(by(6).rel_links).toEqual({ 1: 2 });
  });
  it("needs REL_GOOD (4) related cards for 'good'", () => {
    const cs = [1, 2, 3, 4, 5].map((i) => card(i, `Arch ${i}`, { archetype: "Arch" }));
    const cards = lib(cs, [deck("D", [1, 2, 3, 4, 5])]);
    expect(cards.every((c) => c.rel_status === "good" && c.related === 4)).toBe(true);
  });
});

describe("tags", () => {
  it("detects hand traps by seed list and by text", () => {
    expect(isHandtrap({ name: "Ash Blossom & Joyous Spring", type: "Tuner Effect Monster", desc: "" })).toBe(true);
    expect(isHandtrap({ name: "X", type: "Effect Monster", desc: "During your opponent's turn (Quick Effect): You can discard this card; negate it." })).toBe(true);
    expect(isHandtrap({ name: "X", type: "Effect Monster", desc: "You can discard this card; draw 1 card.\nYour opponent takes no damage." })).toBe(false);
    expect(isHandtrap({ name: "X", type: "Normal Spell", desc: "discard this card; opponent" })).toBe(false);
  });
  it("applies text heuristics, banlist, extra-deck, tuner, floodgate and custom tags", () => {
    const cards = lib(
      [
        card(1, "Negator", { type: "Synchro Tuner Monster", desc: "Negate the activation. Destroy all monsters your opponent controls.", ban_tcg: "Banned", ban_ocg: "Semi-Limited" }),
        card(2, "Lock", { type: "Continuous Trap", category: "Trap", race: "Continuous", desc: "Monsters cannot be Special Summoned." }),
        card(3, "Pot of Greed", { type: "Normal Spell", category: "Spell", race: "Normal", desc: "Draw 2 cards." }),
      ],
      [deck("D", [1, 2, 3])],
      { lock: ["my-tag"] },
    );
    const by = (id: number) => cards.find((c) => c.id === id)!;
    expect(by(1).tags).toEqual(["board-wipe", "extra-deck", "generic", "negate", "ocg-semi-limited", "removal", "tcg-forbidden", "tier:C", "tuner"]);
    expect(by(2).tags).toEqual(["floodgate", "generic", "my-tag", "tier:D"]);
    expect(by(3).tags).toEqual(["draw", "generic", "staple", "tier:C"]);
  });
  it("gives popular / very-popular / trending by library percentiles (needs 20+ cards)", () => {
    const cs = Array.from({ length: 20 }, (_, i) => card(i + 1, `C${i + 1}`, { views: (i + 1) * 100, viewsweek: i + 1 }));
    const cards = lib(cs, [deck("D", cs.map((c) => c.id))]);
    const by = (id: number) => cards.find((c) => c.id === id)!;
    expect(by(20).tags).toEqual(expect.arrayContaining(["very-popular", "trending"]));
    expect(by(19).tags).toEqual(expect.arrayContaining(["popular", "trending"]));
    expect(by(16).tags).toContain("popular");
    expect(by(15).tags).not.toContain("popular");
    expect(by(18).tags).not.toContain("trending");
  });
});

describe("tiers", () => {
  it("scores like compute_tiers (points, banlist bonus, cut-offs, why)", () => {
    const c = { ...card(1, "X"), copies: 1, decks: [], deck_counts: {}, deck_dates: {}, sections: [], archetype_count: 1, related: 0, rel_arch: 0, rel_links: {}, rel_status: "generic", tags: [], tier: null, tier_score: null, tier_src: null, tier_why: [], tier_conf: null } as LibraryCard;
    c.tags = ["staple", "handtrap", "negate", "generic", "tcg-limited"];
    computeTiers([c]);
    // 20 + 12 + 6 + 6 + 10 = 54 -> B
    expect(c.tier).toBe("B");
    expect(c.tier_score).toBe(54);
    expect(c.tier_src).toBe("estimated");
    expect(c.tier_conf).toBe("low");
    expect(c.tier_why).toEqual(["staple (+20)", "hand trap (+12)", "limited on a banlist (powerful) (+10)", "negates (+6)", "generic: fits any deck (+6)"]);
    expect(c.tags).toContain("tier:B");
  });
  it("uses popularity percentiles and the user's own tier wins", () => {
    const cs = Array.from({ length: 21 }, (_, i) => card(i + 1, `C${i + 1}`, { views: (i + 1) * 10, archetype: "A" }));
    const cards = lib(cs, [deck("D", cs.map((c) => c.id))], { c1: ["tier:s", "tier:B"] });
    const top = cards.find((c) => c.id === 21)!;
    // pct = 20/20 = 1 -> 45, very-popular tag has no points; no other signals -> C (45 >= 42 is B)
    expect(top.tier_score).toBe(45);
    expect(top.tier).toBe("B");
    expect(top.tier_why).toEqual(["popularity: top 1% by views (+45)"]);
    expect(top.tier_conf).toBe("high");
    const mine = cards.find((c) => c.id === 1)!;
    expect(mine.tier).toBe("S");
    expect(mine.tier_score).toBe(90);
    expect(mine.tier_src).toBe("yours");
    expect(mine.tier_why).toEqual(["set by you"]);
    expect(mine.tags.filter((t) => t.startsWith("tier:"))).toEqual(["tier:S"]);
  });
  it("no-companions costs 10 and clamps at 0", () => {
    const cards = lib([card(1, "Lonely", { desc: 'Needs "Ghost".' })], [deck("D", [1])]);
    expect(cards[0].tier).toBe("D");
    expect(cards[0].tier_score).toBe(0);
    expect(cards[0].tier_why).toEqual(["none of its companions in your library (-10)"]);
  });
  it("rounds half to even like Python", () => {
    expect([0.5, 1.5, 2.5, -2.5, 2.6, 44.5].map(pyRound)).toEqual([0, 2, 2, -2, 3, 44]);
  });
});

describe("filters, sort and groups", () => {
  const cards = lib(
    [
      card(1, "Bravo", { atk: 1000, release_date: "2010-05-01", archetype: "HERO" }),
      card(2, "alpha", { atk: 2500, release_date: "2002-03-08", archetype: "Elemental HERO" }),
      card(3, "Charlie", { atk: null, release_date: null, type: "Normal Spell", category: "Spell", kind: "Normal" }),
      card(4, "Delta", { atk: 2500, release_date: "2015-01-01" }),
    ],
    [deck("Old", [1, 2, 2], [], [], "2019-02-03"), deck("New", [3, 4, 4, 4], [], [], "2024-11-30")],
  );
  it("sorts stably with nulls last for each key, including desc", () => {
    expect(sortCards(cards, [{ key: "date" }]).map((c) => c.id)).toEqual([2, 1, 4, 3]);
    expect(sortCards(cards, [{ key: "atk", desc: true }, { key: "name" }]).map((c) => c.id)).toEqual([2, 4, 1, 3]);
    expect(sortCards(cards, parseMultiSort("copies:desc,name:asc")).map((c) => c.id)).toEqual([4, 2, 1, 3]);
    expect(sortCards(cards, [{ key: "name" }]).map((c) => c.name)).toEqual(["alpha", "Bravo", "Charlie", "Delta"]);
    expect(() => parseMultiSort("nope")).toThrow();
  });
  it("sorts Genesys points numerically, keeps unknowns last, and supports tie breakers", () => {
    const cards = lib([
      card(1, "Ash Blossom & Joyous Spring"),
      card(2, "Blue-Eyes White Dragon"),
      card(3, "Baronne de Fleur"),
      card(4, "Another zero-point card"),
    ], [deck("Points", [1, 2, 3, 4, 999])]);
    expect(sortCards(cards, parseMultiSort("genesys-points:asc,name:asc")).map((c) => c.id)).toEqual([4, 2, 1, 3, 999]);
    expect(sortCards(cards, parseMultiSort("genesys-points:desc,name:asc")).map((c) => c.id)).toEqual([3, 1, 4, 2, 999]);
  });
  it("filters like apply_filters", () => {
    const ids = (f: Parameters<typeof applyFilters>[1]) => applyFilters(cards, f).map((c) => c.id).sort();
    expect(ids({ query: "HERO", text: true })).toEqual([1, 2]);
    expect(ids({ query: "HERO" })).toEqual([]);
    expect(ids({ archetype: "hero" })).toEqual([1, 2]);
    expect(ids({ archetype: "hero", archetypeExact: true })).toEqual([1]);
    expect(ids({ atkMin: 2000 })).toEqual([2, 4]);
    expect(ids({ after: "2005", before: "2012" })).toEqual([1]);
    expect(ids({ deckAfter: "2024" })).toEqual([3, 4]);
    expect(ids({ deckBefore: "2019-02" })).toEqual([1, 2]);
    expect(ids({ category: "spell" })).toEqual([3]);
    expect(ids({ tag: ["generic"] })).toEqual([3, 4]);
    expect(ids({ tag: ["!generic|nothing"] })).toEqual([1, 2]);
    expect(padDate("2020-02", true)).toBe("2020-02-31");
  });
  it("groups by deck with per-deck copies and puts (none) last", () => {
    const g = groupCards(cards, "deck");
    expect(g.map((x) => [x.key, x.cards.length, x.copies])).toEqual([["New", 2, 4], ["Old", 2, 3]]);
    const arch = groupCards(cards, "archetype");
    expect(arch[arch.length - 1].key).toBe("(none)");
  });
});

describe("exports and custom tags", () => {
  it("writes lflist.conf like cmd_lflist", () => {
    const cards = lib([card(1, "Zed"), card(2, "Ann")], [deck("D", [1, 1, 1, 1, 2])]);
    expect(toLflist(cards, { name: "2026.11 My Collection" })).toBe("#[2026.11 My Collection]\n!2026.11 My Collection\n$whitelist\n2 1 --Ann\n1 3 --Zed\n");
    expect(toLflist(cards, { name: "X", whitelist: false })).not.toContain("$whitelist");
  });
  it("writes CSV with Python csv quoting", () => {
    expect(csvField('a "b", c')).toBe('"a ""b"", c"');
    expect(csvField(null)).toBe("");
    const csv = toCsv(lib([card(1, "Zed", { desc: "line1\nline2" })], [deck("D", [1], [], [], "2020-01-01")]));
    const [head, row] = csv.split("\r\n");
    expect(head.startsWith("id,name,category,kind,type")).toBe(true);
    expect(row).toContain(",D,2020-01-01,D=2020-01-01,");
  });
  it("imports a tags CSV with or without header, and add/remove", () => {
    const r = importTagsCsv('name,tier,tags\n"Ash Blossom & Joyous Spring",S,handtrap;meta\nDark Hole,,staple|classic\n,,x\n');
    expect(r.added).toBe(5);
    expect(r.tags).toEqual({ "ash blossom & joyous spring": ["handtrap", "meta", "tier:S"], "dark hole": ["staple", "classic"] });
    const r2 = importTagsCsv("Raigeki,A,\n", r.tags);
    expect(r2.tags.raigeki).toEqual(["tier:A"]);
    const t = addTag({}, "Raigeki", "Boom");
    addTag(t, "RAIGEKI", "Boom");
    expect(t).toEqual({ raigeki: ["Boom"] });
    removeTag(t, "raigeki", "boom");
    expect(t).toEqual({});
  });
  it("computeTags keeps custom tags on unknown cards", () => {
    const u = { ...unknownCard(5), copies: 1, decks: [], deck_counts: {}, deck_dates: {}, sections: [], archetype_count: 1, related: 0, rel_arch: 0, rel_links: {}, rel_status: "unknown", tags: [], tier: null, tier_score: null, tier_src: null, tier_why: [], tier_conf: null } as LibraryCard;
    computeTags([u], { "(unknown card 5)": ["b", "a"] });
    expect(u.tags).toEqual(["a", "b"]);
  });
});
