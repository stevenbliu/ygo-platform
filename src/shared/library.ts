/**
 * Library derivation: a faithful TypeScript port of `ygo_library_enhanced.py`
 * (load_library, compute_relations, is_handtrap, compute_tags, compute_tiers, apply_filters,
 * SORT_KEYS / sort_cards, GROUP_KEYS, cmd_lflist, export_rows, cmd_tags import/add/remove).
 *
 * Constants, regexes, thresholds and scoring are copied 1:1 from the Python. Where Python
 * semantics differ from JavaScript (round-half-even, codepoint string order, stable reverse
 * sorts) the port reproduces the Python behaviour.
 *
 * Pure functions only (no DOM, no fetch) so it runs in the browser, the Worker and vitest.
 */
import type { Card, CustomTags, Deck, LibraryCard, RelStatus, Section, Tier } from "./types.ts";
import { genesysPoints } from "./formats.ts";

// --------------------------------------------------------------------------- //
// Constants (same values as the Python)
// --------------------------------------------------------------------------- //
export const QUOTE_RE = /"([^"]{2,60})"/g;
export const REL_GOOD = 4; // >= this many related library cards = "well supported"
export const REL_LABELS: Record<RelStatus, string> = {
  generic: "generic",
  none: "no companions",
  thin: "few companions",
  good: "well supported",
  unknown: "",
};

export const HANDTRAP_SEEDS = new Set(
  [
    "Ash Blossom & Joyous Spring", 'Maxx "C"', "Effect Veiler", "Ghost Ogre & Snow Rabbit",
    "Ghost Belle & Haunted Mansion", "Ghost Mourner & Moonlit Chill", "Ghost Sister & Spooky Dogwood",
    "Droll & Lock Bird", "Nibiru, the Primal Being", "D.D. Crow", "PSY-Framegear Gamma",
    'Retaliating "C"', "Mulcharmy Fuwalos", "Mulcharmy Purulia",
  ].map((n) => n.toLowerCase()),
);
export const STAPLE_SEEDS = new Set(
  [
    "Dark Hole", "Raigeki", "Mirror Force", "Monster Reborn", "Mystical Space Typhoon", "Heavy Storm",
    "Pot of Greed", "Called by the Grave", "Foolish Burial", "Solemn Judgment", "Torrential Tribute",
    "Harpie's Feather Duster", "Pot of Prosperity", "Book of Moon", "Polymerization",
  ].map((n) => n.toLowerCase()),
);

/** tag -> regex on the card text (heuristics, not official categories). */
export const TAG_PATTERNS: [string, RegExp][] = [
  ["negate", /\bnegate\b/i],
  ["board-wipe", /\b(destroy|banish|send|return|shuffle) all\b/i],
  ["searcher", /\badd\b[^.;]{0,100}\bfrom your Deck to your hand/i],
  ["draw", /\bdraw (\d+|1) cards?\b/i],
  ["revive", /Special Summon[^.;]{0,100}from (your|the) (GY|Graveyard)|from your (GY|Graveyard)[^.;]{0,60}Special Summon/i],
  ["burn", /\binflict[^.;]{0,40}\bdamage/i],
  ["protection", /cannot be (destroyed|targeted|banished)|unaffected by/i],
];
const HAND_COST = /discard this card|(send|banish) this card from your hand/i;
const REMOVAL_VERB = /\b(destroy|banish)\b|\bsend\b[^.;]{0,60}to the (GY|Graveyard)|return[^.;]{0,60}to the (hand|Deck)|shuffle[^.;]{0,60}into the Deck|take control/i;

export const TAG_HELP: Record<string, string> = {
  handtrap: "monster you can use from your hand on your opponent's turn (discard/send itself as a cost; known list + text match)",
  staple: "goes into almost any deck (YGOPRODeck staple flag + a short known list)",
  generic: "no archetype and no named cards in its text: playable in any deck",
  "no-companions": "depends on other cards but you have none of them",
  removal: "text-match: destroys / banishes / sends / returns an opponent's card (rough)",
  negate: "text contains 'negate'",
  "board-wipe": "destroys/banishes/sends/returns ALL cards of a kind",
  searcher: "adds a card from your Deck to your hand",
  draw: "draws cards",
  revive: "Special Summons from the GY",
  burn: "inflicts effect damage",
  protection: "cannot be destroyed/targeted/banished, or unaffected by effects",
  floodgate: "Continuous/Field card that stops things ('cannot')",
  tuner: "Tuner monster",
  "extra-deck": "Fusion / Synchro / Xyz / Link monster",
  popular: "top 25% by YGOPRODeck page views within your library",
  "very-popular": "top 5% by page views within your library",
  trending: "top 10% by views this week",
  "tcg-forbidden": "Forbidden in the TCG",
  "tcg-limited": "Limited in the TCG",
  "tcg-semi-limited": "Semi-Limited in the TCG",
  "ocg-forbidden": "Forbidden in the OCG",
  "ocg-limited": "Limited in the OCG",
  "ocg-semi-limited": "Semi-Limited in the OCG",
};
const BAN: Record<string, string> = { banned: "forbidden", forbidden: "forbidden", limited: "limited", "semi-limited": "semi-limited" };

export const TIER_CUTS: [Tier, number][] = [["S", 80], ["A", 62], ["B", 42], ["C", 22], ["D", 0]];
export const TIER_RANK: Record<string, number> = { S: 5, A: 4, B: 3, C: 2, D: 1 };
export const TIER_MID: Record<string, number> = { S: 90, A: 70, B: 50, C: 30, D: 10 };
for (const [t, cut] of TIER_CUTS) TAG_HELP[`tier:${t}`] = `tier ${t}: estimated score >= ${cut} (or the tier you set yourself)`;
const TIER_POINTS: [string, number, string][] = [
  ["staple", 20, "staple"], ["handtrap", 12, "hand trap"], ["negate", 6, "negates"],
  ["removal", 4, "removal"], ["board-wipe", 4, "board wipe"], ["searcher", 4, "searcher"],
  ["draw", 3, "draws cards"], ["protection", 2, "protection"], ["revive", 2, "revives"],
  ["floodgate", 2, "floodgate"], ["burn", 1, "burn"], ["generic", 6, "generic: fits any deck"],
  ["no-companions", -10, "none of its companions in your library"],
];

export const UNKNOWN_DESC = "This ID was not found in the YGOPRODeck API (custom, Rush, pre-release or alternate ID).";

// --------------------------------------------------------------------------- //
// Python-compatible helpers
// --------------------------------------------------------------------------- //
/** Python's round(): round half to even. */
export function pyRound(x: number): number {
  if (Math.abs(x % 1) === 0.5) return 2 * Math.round(x / 2);
  return Math.round(x);
}
/** Python's default string ordering (code points; equal to UTF-16 order for the BMP). */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function bisectLeft(arr: number[], v: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
const sortedStrs = (xs: Iterable<string>) => [...xs].sort(cmpStr);

// --------------------------------------------------------------------------- //
// load_library
// --------------------------------------------------------------------------- //
export type CountMode = "sum" | "max";
export interface BuildOptions {
  countMode?: CountMode;
  /** Only decks whose name contains this (case-insensitive), like `--deck`. */
  deckFilter?: string | null;
  /** Only this section, like `--section`. */
  section?: Section | null;
  /** Keep ids the catalogue doesn't know as "(Unknown card N)" placeholders (default true). */
  includeUnresolved?: boolean;
}

export type CardLookup = ReadonlyMap<number, Card> | Record<number, Card>;
const getCard = (m: CardLookup, id: number): Card | undefined =>
  m instanceof Map ? (m as ReadonlyMap<number, Card>).get(id) : (m as Record<number, Card>)[id];

/** Placeholder for an id the catalogue doesn't know (same fields as the Python placeholder row). */
export function unknownCard(id: number): Card {
  return {
    id, name: `(Unknown card ${id})`, type: "Unknown", kind: "Unknown", category: "Unknown",
    race: null, attribute: null, level: null, atk: null, defense: null, linkval: null, linkmarkers: null,
    scale: null, archetype: null, desc: UNKNOWN_DESC, tcg_date: null, ocg_date: null, release_date: null,
    konami_id: null, staple: null, views: null, viewsweek: null, upvotes: null, downvotes: null,
    ban_tcg: null, ban_ocg: null, ban_goat: null,
  };
}

const SECTIONS: Section[] = ["main", "extra", "side"];

/**
 * Port of load_library: every card in the given decks, with copies (sum or max), decks,
 * deck_counts, deck_dates, sections, archetype_count, relations, tags and tiers.
 * Deck card ids may be raw .ydk ids; they are resolved through `alias` (raw -> canonical).
 */
export function buildLibrary(
  decks: Deck[],
  cardsById: CardLookup,
  alias: Record<number, number> | ReadonlyMap<number, number> = {},
  customTags: CustomTags = {},
  opts: BuildOptions = {},
): LibraryCard[] {
  const countMode = opts.countMode ?? "sum";
  const includeUnresolved = opts.includeUnresolved ?? true;
  const deckFilter = opts.deckFilter ? opts.deckFilter.toLowerCase() : null;
  const resolve = (id: number) => (alias instanceof Map ? (alias as ReadonlyMap<number, number>).get(id) : (alias as Record<number, number>)[id]) ?? id;

  interface Acc { card: Card; sections: Set<Section>; totals: Map<string, number>; dates: Record<string, { modified: string | null; created: string | null }>; }
  const perCard = new Map<number, Acc>();
  const add = (card: Card, deck: Deck, section: Section, n: number) => {
    let acc = perCard.get(card.id);
    if (!acc) perCard.set(card.id, (acc = { card, sections: new Set(), totals: new Map(), dates: {} }));
    acc.sections.add(section);
    acc.totals.set(deck.name, (acc.totals.get(deck.name) ?? 0) + n);
    acc.dates[deck.name] = { modified: deck.file_modified ?? null, created: deck.file_created ?? null };
  };

  const unresolved: [Deck, Section, number, number][] = [];
  for (const deck of decks) {
    if (deckFilter && !deck.name.toLowerCase().includes(deckFilter)) continue;
    for (const section of SECTIONS) {
      if (opts.section && section !== opts.section) continue;
      const counts = new Map<number, number>();
      for (const raw of deck[section] || []) counts.set(raw, (counts.get(raw) ?? 0) + 1);
      for (const [raw, n] of counts) {
        const card = getCard(cardsById, resolve(raw));
        if (card) add(card, deck, section, n);
        else unresolved.push([deck, section, raw, n]);
      }
    }
  }
  // IDs the catalogue doesn't know are still cards you have: keep them as placeholders.
  if (includeUnresolved) for (const [deck, section, raw, n] of unresolved) add(perCard.get(raw)?.card ?? unknownCard(raw), deck, section, n);

  const cards: LibraryCard[] = [];
  for (const acc of perCard.values()) {
    const totals = [...acc.totals.values()];
    cards.push({
      ...acc.card,
      copies: countMode === "max" ? Math.max(...totals) : totals.reduce((s, x) => s + x, 0),
      decks: sortedStrs(acc.totals.keys()),
      deck_counts: Object.fromEntries(acc.totals),
      deck_dates: acc.dates,
      sections: sortedStrs(acc.sections) as Section[],
      archetype_count: 0,
      related: 0, rel_arch: 0, rel_links: {}, rel_status: "unknown",
      tags: [], tier: null, tier_score: null, tier_src: null, tier_why: [], tier_conf: null,
    });
  }
  const archSizes = new Map<string, number>();
  for (const c of cards) archSizes.set(c.archetype || "(none)", (archSizes.get(c.archetype || "(none)") ?? 0) + 1);
  for (const c of cards) c.archetype_count = archSizes.get(c.archetype || "(none)")!;
  computeRelations(cards);
  computeTags(cards, customTags);
  computeTiers(cards);
  return cards;
}

// --------------------------------------------------------------------------- //
// compute_relations
// --------------------------------------------------------------------------- //
/** Lower-cased quoted names in a card's text (`"Blue-Eyes White Dragon"`). */
export function quotedNames(desc: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of (desc || "").matchAll(QUOTE_RE)) out.add(m[1].trim().toLowerCase());
  return out;
}

/**
 * Which library cards are related to each other, from card data only. Two cards are related
 * when they share an archetype, or one card's text names the other, or names an archetype /
 * name fragment the other belongs to. Sets related, rel_arch, rel_links (2 = names it,
 * 4 = named by it, 6 = both) and rel_status (generic / none / thin / good / unknown).
 */
export function computeRelations(cards: LibraryCard[]): void {
  const real = cards.filter((c) => c.category !== "Unknown");
  const byName = new Map<string, LibraryCard>();
  for (const c of real) byName.set(c.name.toLowerCase(), c);
  const byArch = new Map<string, LibraryCard[]>();
  for (const c of real) {
    if (c.archetype) {
      const k = c.archetype.toLowerCase();
      if (!byArch.has(k)) byArch.set(k, []);
      byArch.get(k)!.push(c);
    }
  }
  // Python scans every name for `sq in name` (`[c for lc, c in lows if sq in lc]`). Same
  // result here, but candidates come from a trigram index so we only test names that can match.
  const lows = real.map((c) => c.name.toLowerCase());
  const gram = (s: string, j: number) => (s.charCodeAt(j) * 65536 + s.charCodeAt(j + 1)) * 65536 + s.charCodeAt(j + 2);
  const grams = new Map<number, number[]>();
  for (let i = 0; i < lows.length; i++) {
    const lc = lows[i];
    for (let j = 0; j + 3 <= lc.length; j++) {
      const g = gram(lc, j);
      const list = grams.get(g);
      if (!list) grams.set(g, [i]);
      else if (list[list.length - 1] !== i) list.push(i);
    }
  }
  const substringHits = (sq: string): number[] => {
    let best: number[] | undefined;
    for (let j = 0; j + 3 <= sq.length; j++) {
      const list = grams.get(gram(sq, j));
      if (!list) return [];
      if (!best || list.length < best.length) best = list;
    }
    return (best ?? []).filter((i) => lows[i].includes(sq));
  };
  const cache = new Map<string, LibraryCard[]>();
  const targets = (sq: string): LibraryCard[] => {
    let hit = cache.get(sq);
    if (hit) return hit;
    const out = new Map<number, LibraryCard>();
    const named = byName.get(sq);
    if (named) out.set(named.id, named);
    for (const m of byArch.get(sq) ?? []) out.set(m.id, m);
    if (sq.length >= 4) { // "Blue-Eyes" also matches names containing it
      const hits = substringHits(sq);
      if (hits.length <= 200) for (const i of hits) out.set(real[i].id, real[i]); // ignore over-generic fragments
    }
    hit = [...out.values()];
    cache.set(sq, hit);
    return hit;
  };

  const links = new Map<number, Map<number, number>>();
  for (const c of real) links.set(c.id, new Map());
  const quoted = new Map<number, boolean>();
  for (const c of real) {
    const qs = quotedNames(c.desc);
    quoted.set(c.id, qs.size > 0);
    const mine = links.get(c.id)!;
    for (const sq of qs) {
      for (const t of targets(sq)) {
        if (t.id !== c.id) {
          mine.set(t.id, (mine.get(t.id) ?? 0) | 2);
          const theirs = links.get(t.id)!;
          theirs.set(c.id, (theirs.get(c.id) ?? 0) | 4);
        }
      }
    }
  }
  for (const c of cards) {
    if (c.category === "Unknown") {
      c.related = 0; c.rel_arch = 0; c.rel_links = {}; c.rel_status = "unknown";
      continue;
    }
    const l = links.get(c.id)!;
    const arch = c.archetype ? byArch.get(c.archetype.toLowerCase())! : [];
    let mates = 0, n = l.size;
    for (const m of arch) {
      if (m.id === c.id) continue;
      mates++;
      if (!l.has(m.id)) n++;
    }
    const generic = !c.archetype && !quoted.get(c.id);
    c.related = n;
    c.rel_arch = mates;
    c.rel_links = Object.fromEntries(l);
    c.rel_status = generic ? "generic" : n === 0 ? "none" : n < REL_GOOD ? "thin" : "good";
  }
}

// --------------------------------------------------------------------------- //
// compute_tags
// --------------------------------------------------------------------------- //
export function isHandtrap(c: Pick<Card, "name" | "type" | "desc">): boolean {
  if (HANDTRAP_SEEDS.has(c.name.toLowerCase())) return true;
  if (!(c.type || "").includes("Monster")) return false;
  for (const line of (c.desc || "").split(/\n|●/)) { // one effect per line
    if (HAND_COST.test(line) && /Quick Effect|opponent/i.test(line)) return true;
  }
  return false;
}

/** Attach c.tags (sorted) to every card. `custom` = {lower name: [tags]}. */
export function computeTags(cards: LibraryCard[], custom: CustomTags = {}): void {
  const views = cards.map((c) => c.views).filter((v): v is number => !!v).sort((a, b) => a - b);
  const weeks = cards.map((c) => c.viewsweek).filter((v): v is number => !!v).sort((a, b) => a - b);
  const pick = (arr: number[], q: number) => (arr.length >= 20 ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null);
  const p75 = pick(views, 0.75), p95 = pick(views, 0.95), w90 = pick(weeks, 0.9);
  for (const c of cards) {
    const own = custom[c.name.toLowerCase()] ?? [];
    if (c.category === "Unknown") {
      c.tags = sortedStrs(own);
      continue;
    }
    const tags = new Set<string>();
    const text = c.desc || "", ctype = c.type || "";
    if (isHandtrap(c)) tags.add("handtrap");
    if (c.staple || STAPLE_SEEDS.has(c.name.toLowerCase())) tags.add("staple");
    if (c.rel_status === "generic") tags.add("generic");
    else if (c.rel_status === "none") tags.add("no-companions");
    for (const [tag, rx] of TAG_PATTERNS) if (rx.test(text)) tags.add(tag);
    if (/opponent|that (monster|card)|target/i.test(text) && REMOVAL_VERB.test(text)) tags.add("removal");
    if ((c.category === "Spell" || c.category === "Trap") && /Continuous|Field/.test(ctype + " " + (c.race || "")) && /cannot/i.test(text)) tags.add("floodgate");
    if (ctype.includes("Tuner")) tags.add("tuner");
    if (/Fusion|Synchro|XYZ|Link/.test(ctype)) tags.add("extra-deck");
    const v = c.views, w = c.viewsweek;
    if (v && p95 && v >= p95) tags.add("very-popular");
    else if (v && p75 && v >= p75) tags.add("popular");
    if (w && w90 && w >= w90) tags.add("trending");
    for (const [key, prefix] of [["ban_tcg", "tcg-"], ["ban_ocg", "ocg-"]] as const) {
      const b = c[key];
      if (b && BAN[b.toLowerCase()]) tags.add(prefix + BAN[b.toLowerCase()]);
    }
    for (const t of own) tags.add(t);
    c.tags = sortedStrs(tags);
  }
}

// --------------------------------------------------------------------------- //
// compute_tiers
// --------------------------------------------------------------------------- //
/**
 * Estimated tier S/A/B/C/D per card (NOT an official tier list). Score 0-100 from popularity
 * (views relative to the library, up to 45), trending (8), staple (20), hand trap (12), useful
 * effects, banlist status, generic (+6) and no companions (-10). A tier set by the user wins.
 */
export function computeTiers(cards: LibraryCard[]): void {
  const views = cards.map((c) => c.views).filter((v): v is number => !!v).sort((a, b) => a - b);
  const weeks = cards.map((c) => c.viewsweek).filter((v): v is number => !!v).sort((a, b) => a - b);
  const pct = (arr: number[], v: number) => Math.min(1, bisectLeft(arr, v) / Math.max(1, arr.length - 1));
  for (const c of cards) {
    if (c.category === "Unknown") {
      Object.assign(c, { tier: null, tier_score: null, tier_src: null, tier_why: [], tier_conf: null });
      continue;
    }
    const tags = new Set(c.tags);
    const parts: [number, string][] = [];
    if (views.length >= 20 && c.views) {
      const p = pct(views, c.views);
      parts.push([45 * p, `popularity: top ${Math.max(1, pyRound((1 - p) * 100))}% by views`]);
    }
    if (weeks.length >= 20 && c.viewsweek) parts.push([8 * pct(weeks, c.viewsweek), "trending this week"]);
    for (const [tag, pts, label] of TIER_POINTS) if (tags.has(tag)) parts.push([pts, label]);
    const has = (...ts: string[]) => ts.some((t) => tags.has(t));
    const ban = has("tcg-forbidden", "ocg-forbidden") ? "forbidden"
      : has("tcg-limited", "ocg-limited") ? "limited"
      : has("tcg-semi-limited", "ocg-semi-limited") ? "semi-limited" : null;
    if (ban) parts.push([{ forbidden: 15, limited: 10, "semi-limited": 5 }[ban], `${ban} on a banlist (powerful)`]);
    let score = Math.max(0, Math.min(100, parts.reduce((s, [p]) => s + p, 0)));
    let letter: string = TIER_CUTS.find(([, cut]) => score >= cut)![0];
    let why = [...parts]
      .sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]))
      .filter(([p]) => pyRound(p) !== 0)
      .map(([p, t]) => `${t} (${pyRound(p) > 0 ? "+" : ""}${pyRound(p)})`);
    const mine = [...new Set(c.tags.filter((t) => t.toLowerCase().startsWith("tier:")).map((t) => t.split(":").slice(1).join(":").trim().toUpperCase()))]
      .sort((a, b) => (TIER_RANK[b] ?? 0) - (TIER_RANK[a] ?? 0) || cmpStr(a, b));
    let src: "estimated" | "yours" = "estimated";
    if (mine.length) {
      letter = mine[0];
      score = TIER_MID[mine[0]] ?? score;
      src = "yours";
      why = ["set by you"];
    }
    Object.assign(c, {
      tier: letter as Tier, tier_score: pyRound(score), tier_src: src, tier_why: why,
      tier_conf: views.length >= 20 && c.views ? "high" : "low",
    });
    c.tags = sortedStrs([...c.tags.filter((t) => !t.toLowerCase().startsWith("tier:")), `tier:${letter}`]);
  }
}

// --------------------------------------------------------------------------- //
// Dates
// --------------------------------------------------------------------------- //
export type DateSource = "first" | "tcg" | "ocg";
export type DeckDateSource = "modified" | "created";

export interface DateContext {
  dateSource?: DateSource;           // --date-source (default first = earliest of TCG/OCG)
  deckDateSource?: DeckDateSource;   // --deck-date-source (default modified)
  deckDatePick?: "earliest" | "latest";
  deckAfter?: string | null;         // YYYY, YYYY-MM or YYYY-MM-DD
  deckBefore?: string | null;
}

export function cardDate(c: Card, source: DateSource = "first"): string | null {
  return source === "tcg" ? c.tcg_date : source === "ocg" ? c.ocg_date : c.release_date;
}

export function padDate(value: string, end = false): string {
  const v = value.trim();
  if (v.length === 4) return v + (end ? "-12-31" : "-01-01");
  if (v.length === 7) return v + (end ? "-31" : "-01");
  return v;
}

/** [(deck name, 'YYYY-MM-DD')] for the .ydk files that contain this card. */
export function deckDateList(c: LibraryCard, source: DeckDateSource = "modified"): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, d] of Object.entries(c.deck_dates || {})) {
    const v = d[source] || d.modified;
    if (v) out.push([name, v]);
  }
  return out;
}

function decksInRange(c: LibraryCard, a: DateContext): string[] {
  const lo = a.deckAfter ? padDate(a.deckAfter) : null;
  const hi = a.deckBefore ? padDate(a.deckBefore, true) : null;
  return deckDateList(c, a.deckDateSource || "modified").map(([, d]) => d).filter((d) => (lo === null || d >= lo) && (hi === null || d <= hi));
}

/** Earliest (default) or latest deck-file date of a card, within the deck date range if set. */
export function deckDate(c: LibraryCard, a: DateContext = {}): string | null {
  const dates = decksInRange(c, a);
  if (!dates.length) return null;
  return (a.deckDatePick || "earliest") === "latest" ? dates.reduce((x, y) => (y > x ? y : x)) : dates.reduce((x, y) => (y < x ? y : x));
}

// --------------------------------------------------------------------------- //
// apply_filters
// --------------------------------------------------------------------------- //
export type Support = "generic" | "none" | "thin" | "good";
export interface FilterOptions extends DateContext {
  query?: string;
  /** also match card text and archetype (the `search` command / the HTML report). */
  text?: boolean;
  category?: string; kind?: string; attribute?: string; race?: string;
  type?: string;        // substring
  archetype?: string;   // substring (CLI) — or exact when archetypeExact
  archetypeExact?: boolean;
  deck?: string;        // substring of a deck name (CLI) — or exact when deckExact
  deckExact?: boolean;
  section?: Section;
  level?: number | null;
  atkMin?: number | null; atkMax?: number | null; defMin?: number | null; defMax?: number | null;
  after?: string | null; before?: string | null;  // release date (YYYY / YYYY-MM / YYYY-MM-DD)
  minCopies?: number | null;
  /** CLI --tag specs: "a" (must have), "a|b" (either), "!a|b" (none of). All specs must hold. */
  tag?: string[];
  minTier?: Tier | null;
  /** exact tiers (the report's "S or A" options). */
  tiers?: Tier[] | null;
  minViews?: number | null;
  minRelated?: number | null; maxRelated?: number | null;
  support?: Support | null;
}

const isSet = (v: unknown) => v !== undefined && v !== null && v !== "";

export function applyFilters(cards: LibraryCard[], a: FilterOptions): LibraryCard[] {
  const preds: ((c: LibraryCard) => boolean)[] = [];
  if (a.query) {
    const words = a.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) preds.push((c) => {
      let hay = c.name.toLowerCase();
      if (a.text) hay += " " + (c.desc || "").toLowerCase() + " " + (c.archetype || "").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  for (const f of ["category", "kind", "attribute", "race"] as const) {
    const v = a[f];
    if (v) preds.push((c) => (c[f] || "").toLowerCase() === v.toLowerCase());
  }
  if (a.type) { const v = a.type.toLowerCase(); preds.push((c) => (c.type || "").toLowerCase().includes(v)); }
  if (a.archetype) {
    const v = a.archetype.toLowerCase();
    preds.push(a.archetypeExact ? (c) => (c.archetype || "").toLowerCase() === v : (c) => (c.archetype || "").toLowerCase().includes(v));
  }
  if (a.deck) {
    const v = a.deck.toLowerCase();
    preds.push(a.deckExact ? (c) => c.decks.some((d) => d.toLowerCase() === v) : (c) => c.decks.some((d) => d.toLowerCase().includes(v)));
  }
  if (a.section) preds.push((c) => c.sections.includes(a.section!));
  if (isSet(a.level)) preds.push((c) => (c.level !== null ? c.level : c.linkval) === a.level);
  if (isSet(a.atkMin)) preds.push((c) => c.atk !== null && c.atk >= a.atkMin!);
  if (isSet(a.atkMax)) preds.push((c) => c.atk !== null && c.atk <= a.atkMax!);
  if (isSet(a.defMin)) preds.push((c) => c.defense !== null && c.defense >= a.defMin!);
  if (isSet(a.defMax)) preds.push((c) => c.defense !== null && c.defense <= a.defMax!);
  if (a.after) { const lo = padDate(a.after); preds.push((c) => { const d = cardDate(c, a.dateSource); return d !== null && d >= lo; }); }
  if (a.before) { const hi = padDate(a.before, true); preds.push((c) => { const d = cardDate(c, a.dateSource); return d !== null && d <= hi; }); }
  if (a.minCopies) preds.push((c) => c.copies >= a.minCopies!);
  for (const spec of a.tag ?? []) {
    const neg = spec.startsWith("!");
    const want = new Set(spec.replace(/^!+/, "").split("|").map((t) => t.trim().toLowerCase()).filter(Boolean));
    preds.push((c) => {
      const hit = c.tags.some((t) => want.has(t.toLowerCase()));
      return neg ? !hit : hit;
    });
  }
  if (a.minTier) preds.push((c) => (TIER_RANK[c.tier ?? ""] ?? 0) >= TIER_RANK[a.minTier!]);
  if (a.tiers && a.tiers.length) { const ts = new Set<string>(a.tiers); preds.push((c) => !!c.tier && ts.has(c.tier)); }
  if (isSet(a.minViews)) preds.push((c) => (c.views || 0) >= a.minViews!);
  if (isSet(a.minRelated)) preds.push((c) => (c.related ?? 0) >= a.minRelated!);
  if (isSet(a.maxRelated)) preds.push((c) => (c.related ?? 0) <= a.maxRelated!);
  if (a.support) preds.push((c) => c.rel_status === a.support);
  // one deck must satisfy the whole range (not "one deck after, another deck before")
  if (a.deckAfter || a.deckBefore) preds.push((c) => decksInRange(c, a).length > 0);
  return cards.filter((c) => preds.every((p) => p(c)));
}

// --------------------------------------------------------------------------- //
// SORT_KEYS / sort_cards
// --------------------------------------------------------------------------- //
const lower = (v: string | null | undefined) => (typeof v === "string" && v ? v.toLowerCase() : null);
type KeyFn = (c: LibraryCard, a: DateContext) => string | number | null;

export const SORT_KEYS = {
  date: (c, a) => cardDate(c, a.dateSource),
  name: (c) => lower(c.name),
  id: (c) => c.id,
  category: (c) => lower(c.category),
  kind: (c) => lower(c.kind),
  type: (c) => lower(c.type),
  attribute: (c) => lower(c.attribute),
  race: (c) => lower(c.race),
  archetype: (c) => lower(c.archetype),
  level: (c) => (c.level !== null ? c.level : c.linkval),
  atk: (c) => c.atk,
  def: (c) => c.defense,
  copies: (c) => c.copies,
  deck: (c) => (c.decks.length ? lower(c.decks[0]) : null),
  "deck-count": (c) => c.decks.length,
  "archetype-count": (c) => c.archetype_count ?? 0,
  /** Not in the Python: like archetype-count but cards without an archetype sort last (the HTML report's "Archetype size"). */
  "archetype-size": (c) => (c.archetype ? c.archetype_count : null),
  year: (c, a) => (cardDate(c, a.dateSource) || "9999").slice(0, 4),
  related: (c) => c.related ?? null,
  tier: (c) => c.tier_score ?? null,
  views: (c) => c.views ?? null,
  viewsweek: (c) => c.viewsweek ?? null,
  "genesys-points": (c) => genesysPoints(c),
  "deck-date": (c, a) => deckDate(c, a),
  "deck-year": (c, a) => (deckDate(c, a) || "").slice(0, 4) || null,
} satisfies Record<string, KeyFn>;
export type SortKey = keyof typeof SORT_KEYS;
export const SORT_KEY_NAMES = Object.keys(SORT_KEYS) as SortKey[];

export interface SortSpec { key: SortKey; desc?: boolean }

/** Parse comma-separated keys, e.g. "date:asc,archetype-count:desc,copies:desc". */
export function parseMultiSort(spec: string | null | undefined): SortSpec[] {
  const out: SortSpec[] = [];
  for (const raw of (spec || "").split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const i = item.indexOf(":");
    const field = i === -1 ? item : item.slice(0, i);
    const dir = i === -1 ? "asc" : item.slice(i + 1).toLowerCase();
    if (!(field in SORT_KEYS)) throw new Error(`Unknown sort field '${field}'. Choices: ${[...SORT_KEY_NAMES].sort().join(", ")}`);
    if (dir !== "asc" && dir !== "desc") throw new Error(`Sort direction must be asc or desc: '${item}'`);
    out.push({ key: field as SortKey, desc: dir === "desc" });
  }
  return out;
}

const cmpVal = (x: string | number, y: string | number) =>
  typeof x === "number" && typeof y === "number" ? x - y : cmpStr(String(x), String(y));

/** Stable multi-sort; missing values stay last for each key (first spec = primary key). */
export function sortCards<T extends LibraryCard>(cards: readonly T[], specs: SortSpec[], ctx: DateContext = {}): T[] {
  let out = [...cards];
  for (const { key, desc } of [...specs].reverse()) {
    const fn = SORT_KEYS[key] as KeyFn;
    const keyed = out.map((c) => [fn(c, ctx), c] as const);
    const have = keyed.filter(([k]) => k !== null && k !== undefined);
    const lack = keyed.filter(([k]) => k === null || k === undefined);
    have.sort((p, q) => (desc ? -1 : 1) * cmpVal(p[0]!, q[0]!));
    out = [...have, ...lack].map(([, c]) => c);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// GROUP_KEYS
// --------------------------------------------------------------------------- //
export const GROUP_KEYS = {
  category: (c) => [c.category ?? "(none)"],
  kind: (c) => [c.kind ?? "(none)"],
  type: (c) => [c.type ?? "(none)"],
  attribute: (c) => [c.attribute || "(none)"],
  race: (c) => [c.race || "(none)"],
  archetype: (c) => [c.archetype || "(none)"],
  deck: (c) => c.decks,
  section: (c) => c.sections,
  year: (c, a) => [(cardDate(c, a.dateSource) || "unknown").slice(0, 4)],
  tier: (c) => [c.tier ? `Tier ${c.tier}` : "unrated"],
  tag: (c) => (c.tags.length ? c.tags : ["untagged"]),
  support: (c) => [REL_LABELS[c.rel_status] || "unknown"],
  // one group per .ydk file date (a card in several decks appears under each date)
  "deck-date": (c, a) => { const s = sortedStrs(new Set(deckDateList(c, a.deckDateSource).map(([, d]) => d))); return s.length ? s : ["unknown"]; },
  "deck-month": (c, a) => { const s = sortedStrs(new Set(deckDateList(c, a.deckDateSource).map(([, d]) => d.slice(0, 7)))); return s.length ? s : ["unknown"]; },
  "deck-year": (c, a) => { const s = sortedStrs(new Set(deckDateList(c, a.deckDateSource).map(([, d]) => d.slice(0, 4)))); return s.length ? s : ["unknown"]; },
} satisfies Record<string, (c: LibraryCard, a: DateContext) => string[]>;
export type GroupKey = keyof typeof GROUP_KEYS;

export interface CardGroup<T> { key: string; cards: T[]; copies: number }
const NONE_KEYS = new Set(["(none)", "unknown", "unrated", "untagged"]);
const TIER_GROUP_ORDER: Record<string, number> = { "Tier S": 0, "Tier A": 1, "Tier B": 2, "Tier C": 3, "Tier D": 4 };
const numericCollator = new Intl.Collator(undefined, { numeric: true });

/**
 * Group cards (a card can sit in several groups, e.g. by deck or tag). Order like the HTML
 * report: tiers S..D first, "(none)"-style groups last, then biggest group first or by name.
 * For the `deck` grouping, `copies` per group uses each deck's own copy count (like `list`).
 */
export function groupCards<T extends LibraryCard>(cards: readonly T[], key: GroupKey, order: "count" | "name" = "count", ctx: DateContext = {}): CardGroup<T>[] {
  const fn = GROUP_KEYS[key] as (c: LibraryCard, a: DateContext) => string[];
  const m = new Map<string, CardGroup<T>>();
  for (const c of cards) {
    for (const g of fn(c, ctx)) {
      let grp = m.get(g);
      if (!grp) m.set(g, (grp = { key: g, cards: [], copies: 0 }));
      grp.cards.push(c);
      grp.copies += key === "deck" ? c.deck_counts[g] ?? 0 : c.copies;
    }
  }
  const nn = (g: CardGroup<T>) => (NONE_KEYS.has(g.key) ? 1 : 0);
  return [...m.values()].sort((p, q) => {
    if (nn(p) !== nn(q)) return nn(p) - nn(q);
    if (key === "tier") return (TIER_GROUP_ORDER[p.key] ?? 9) - (TIER_GROUP_ORDER[q.key] ?? 9);
    if (order === "count" && q.cards.length !== p.cards.length) return q.cards.length - p.cards.length;
    return numericCollator.compare(p.key, q.key);
  });
}

// --------------------------------------------------------------------------- //
// Exports: CSV / JSON (export_rows) and lflist.conf (cmd_lflist)
// --------------------------------------------------------------------------- //
export const EXPORT_FIELDS = [
  "id", "name", "category", "kind", "type", "attribute", "race", "level",
  "linkval", "scale", "atk", "defense", "archetype", "tcg_date", "ocg_date",
  "release_date", "copies", "sections", "decks", "deck_date", "deck_dates", "related", "rel_status",
  "tags", "tier", "tier_score", "tier_src", "views", "viewsweek", "ban_tcg", "ban_ocg",
  "konami_id", "desc",
] as const;
export type ExportRow = Record<(typeof EXPORT_FIELDS)[number], string | number | null>;

export function exportRows(cards: readonly LibraryCard[]): ExportRow[] {
  return cards.map((c) => {
    const row = {} as ExportRow;
    for (const f of EXPORT_FIELDS) row[f] = ((c as unknown as Record<string, unknown>)[f] ?? null) as string | number | null;
    row.sections = c.sections.join("|");
    row.decks = c.decks.join("|");
    row.tags = (c.tags || []).join("|");
    row.deck_date = deckDate(c); // earliest .ydk file date
    row.deck_dates = deckDateList(c).map(([n, d]) => `${n}=${d}`).join("|");
    return row;
  });
}

/** One CSV field, quoted like Python's csv module (QUOTE_MINIMAL). */
export function csvField(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Same output as `list --format csv` (header + rows, \r\n line endings, no trailing newline). */
export function toCsv(cards: readonly LibraryCard[]): string {
  const lines = [EXPORT_FIELDS.join(",")];
  for (const row of exportRows(cards)) lines.push(EXPORT_FIELDS.map((f) => csvField(row[f])).join(","));
  return lines.join("\r\n");
}

/** Same output as `list --format json`. */
export function toJson(cards: readonly LibraryCard[]): string {
  return JSON.stringify(exportRows(cards), null, 2);
}

export function defaultLflistName(now = new Date()): string {
  return `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")} My Collection`;
}

/**
 * YGOPro/EDOPro lflist.conf: one line per card -> '<id> <copies 1-3> --<name>'.
 * Unknown ids are already in the library as "(Unknown card N)" placeholders, so (unlike the
 * Python, which listed them a second time as "(unrecognised ID)") each id appears once.
 */
export function toLflist(cards: readonly LibraryCard[], opts: { name?: string; whitelist?: boolean } = {}): string {
  const name = opts.name || defaultLflistName();
  const lines = [`#[${name}]`, `!${name}`];
  if (opts.whitelist !== false) lines.push("$whitelist");
  const sorted = [...cards].sort((x, y) => cmpStr(x.name.toLowerCase(), y.name.toLowerCase()));
  for (const c of sorted) lines.push(`${c.id} ${Math.min(Math.max(c.copies, 1), 3)} --${c.name.replace(/\n/g, " ")}`);
  return lines.join("\n") + "\n";
}

// --------------------------------------------------------------------------- //
// Custom tags (cmd_tags import / add / remove)
// --------------------------------------------------------------------------- //
/** Minimal RFC 4180 CSV reader (quotes, doubled quotes, CR/LF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * `tags import FILE.csv`: columns name, tier, tags (tags separated by ; or |). A header row is
 * optional (detected by a "name" column). Returns the merged tags and how many were added.
 */
export function importTagsCsv(text: string, existing: CustomTags = {}): { tags: CustomTags; added: number } {
  const rows = parseCsv(text).filter((r) => r.length && !(r.length === 1 && r[0] === ""));
  let head = ["name", "tier", "tags"];
  if (rows.length && rows[0].map((x) => x.trim().toLowerCase()).includes("name")) head = rows.shift()!.map((x) => x.trim().toLowerCase());
  const tags = cloneTags(existing);
  let added = 0;
  for (const r of rows) {
    const d: Record<string, string> = {};
    head.forEach((h, i) => { if (i < r.length) d[h] = r[i].trim(); });
    const name = d.name || "";
    if (!name) continue;
    const list = (d.tags || "").split(/[;|]/).map((t) => t.trim()).filter(Boolean);
    if (d.tier) list.push(`tier:${d.tier}`);
    for (const t of list) {
      added++;
      addTag(tags, name, t);
    }
  }
  return { tags, added };
}

function cloneTags(t: CustomTags): CustomTags {
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, [...v]]));
}

/** INSERT OR IGNORE (card_name, tag). Mutates and returns `tags`. */
export function addTag(tags: CustomTags, cardName: string, tag: string): CustomTags {
  const k = cardName.toLowerCase();
  const t = tag.trim();
  if (!t) return tags;
  const list = (tags[k] ??= []);
  if (!list.includes(t)) list.push(t);
  return tags;
}

/** DELETE WHERE card_name = ? AND lower(tag) = ?. Mutates and returns `tags`. */
export function removeTag(tags: CustomTags, cardName: string, tag: string): CustomTags {
  const k = cardName.toLowerCase();
  if (!tags[k]) return tags;
  tags[k] = tags[k].filter((t) => t.toLowerCase() !== tag.trim().toLowerCase());
  if (!tags[k].length) delete tags[k];
  return tags;
}

/** Tags -> CSV in the import format (name,tier,tags). */
export function exportTagsCsv(tags: CustomTags, displayName: (lower: string) => string = (x) => x): string {
  const lines = ["name,tier,tags"];
  for (const [k, list] of Object.entries(tags).sort(([a], [b]) => cmpStr(a, b))) {
    const tier = list.find((t) => t.toLowerCase().startsWith("tier:"));
    const rest = list.filter((t) => t !== tier);
    lines.push([displayName(k), tier ? tier.split(":").slice(1).join(":") : "", rest.join(";")].map(csvField).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// --------------------------------------------------------------------------- //
// Deck helpers shared by the deck pages
// --------------------------------------------------------------------------- //
/** Extra Deck monster (goes to the Extra Deck automatically). */
export const isExtraDeckType = (type: string | null | undefined) => /Fusion|Synchro|XYZ|Link/.test(type || "");

/** Format a File.lastModified timestamp as local YYYY-MM-DD (like Python's datetime.fromtimestamp). */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
