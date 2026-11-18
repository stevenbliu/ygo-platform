// PHASE 1 owns this page (port of the Python library: search/filters/tags/tiers/relations, .ydk folder import).
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CustomTags, Deck, LibraryCard, Tier } from "../../shared/types.ts";
import {
  addTag, applyFilters, buildLibrary, computeTags, computeTiers, defaultLflistName, groupCards, importTagsCsv,
  exportTagsCsv, removeTag, sortCards, toCsv, toJson, toLflist, TAG_HELP,
  type CountMode, type FilterOptions, type GroupKey, type SortKey, type SortSpec,
} from "../../shared/library.ts";
import { useDeckStore } from "../store/deckStore.ts";
import { catalog, ensureCards } from "../components/cards/catalog.ts";
import { CardImage } from "../components/cards/CardImage.tsx";
import { CardPreviewLayer, previewHandlers } from "../components/cards/CardPreview.tsx";
import { downloadText, levelLabel } from "../components/cards/cardInfo.ts";
import { ImportDecks } from "../components/library/ImportDecks.tsx";
import { summaryText } from "../components/library/importYdk.ts";
import { CardDialog } from "../components/library/CardDialog.tsx";
import { VirtualRows } from "../components/library/VirtualRows.tsx";
import "./LibraryPage.css";
import { FormatSelector, useDeckFormat } from "../components/library/FormatSelector.tsx";
import { genesysPoints } from "../../shared/formats.ts";

// ----------------------------------------------------------------------------- options
const SORT_OPTIONS: [SortKey, string][] = [
  ["genesys-points", "Genesys points"], ["tier", "Tier (score)"], ["views", "Popularity (views)"], ["viewsweek", "Trending (views this week)"],
  ["related", "Related cards (count)"], ["date", "Release date"], ["deck-date", "Deck file date"], ["name", "Name"],
  ["archetype", "Archetype"], ["archetype-size", "Archetype size (cards)"], ["copies", "Copies"], ["atk", "ATK"],
  ["def", "DEF"], ["level", "Level"], ["deck-count", "Number of decks"], ["kind", "Kind"], ["year", "Release year"], ["id", "ID"],
];
const GROUP_OPTIONS: [GroupKey | "", string][] = [
  ["", "No grouping"], ["archetype", "Archetype"], ["deck", "Deck"], ["deck-month", "Deck file month"], ["year", "Release year"],
  ["category", "Category"], ["kind", "Kind"], ["attribute", "Attribute"], ["race", "Monster type"], ["support", "Support level"],
  ["tier", "Tier"], ["tag", "Tag"], ["section", "Deck section"],
];
const DISPLAY = [
  ["img", "Card image", true], ["kind", "Kind / attribute / level", true], ["stat", "ATK / DEF", false],
  ["date", "Release date", true], ["qty", "Copies (×n)", true], ["tier", "Tier badge", true],
  ["rel", "Related-cards badge", true], ["tags", "Tags", true], ["pop", "Popularity (views)", false],
  ["ar", "Archetype", false], ["dd", "Deck file date", false],
] as const;
type DisplayKey = (typeof DISPLAY)[number][0];
type Display = Record<DisplayKey, boolean>;
const SUPPORT_LABEL: Record<string, string> = { generic: "Generic", none: "No companions", thin: "Few companions", good: "Well supported", unknown: "" };

interface Filters {
  q: string; category: string; kind: string; attribute: string; archetype: string; deck: string;
  support: string; tier: string; tagMatch: "all" | "any"; tagState: Record<string, 1 | 2>;
  y1: string; y2: string; d1: string; d2: string;
}
const EMPTY_FILTERS: Filters = {
  q: "", category: "", kind: "", attribute: "", archetype: "", deck: "", support: "", tier: "",
  tagMatch: "all", tagState: {}, y1: "", y2: "", d1: "", d2: "",
};
interface UiPrefs {
  sort: { key: SortKey | ""; desc: boolean }[];
  group: GroupKey | ""; groupOrder: "count" | "name"; view: "grid" | "list";
  display: Display; countMode: CountMode;
}
const DEFAULT_PREFS: UiPrefs = {
  sort: [{ key: "date", desc: false }, { key: "", desc: false }, { key: "", desc: false }],
  group: "", groupOrder: "count", view: "grid",
  display: Object.fromEntries(DISPLAY.map(([k, , on]) => [k, on])) as Display, countMode: "sum",
};
const PREFS_KEY = "ygo.library.ui.v1";
function loadPrefs(): UiPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return { ...DEFAULT_PREFS, ...raw, display: { ...DEFAULT_PREFS.display, ...(raw.display || {}) } };
  } catch {
    return DEFAULT_PREFS;
  }
}

// ----------------------------------------------------------------------------- derivation cache
// buildLibrary (relations over ~9k cards) is the expensive step; keep the last result for the
// session so coming back to the page is instant. Custom tags are applied on top (cheap).
let baseCache: { sig: string; cards: LibraryCard[] } | null = null;
function deriveBase(decks: Deck[], countMode: CountMode, includeUnresolved: boolean): LibraryCard[] {
  const sig = `${includeUnresolved}|${countMode}|${catalog.version}|${decks.map((d) => `${d.id}@${d.updated_at}`).join(",")}`;
  if (baseCache?.sig === sig) return baseCache.cards;
  const cards = buildLibrary(decks, catalog.cards, catalog.alias, {}, { countMode, includeUnresolved });
  baseCache = { sig, cards };
  return cards;
}

// ----------------------------------------------------------------------------- tiles
interface TileProps { card: LibraryCard; copies: number; display: Display; onOpen: (c: LibraryCard) => void; genesys?: boolean }
const Tile = memo(function Tile({ card: c, copies, display: d, onOpen, genesys }: TileProps) {
  const lv = levelLabel(c);
  const points = genesysPoints(c);
  const dd = Object.values(c.deck_dates).map((x) => x.modified).filter(Boolean).sort()[0];
  return (
    <button type="button" className="lib-tile" onClick={() => onOpen(c)} {...previewHandlers(c)}>
      {d.img && <CardImage card={c} />}
      <span className="lib-card-heading">
        <b className="t-name">{c.name}</b>
        {genesys && points !== null && points > 0 && <span className="lib-point-badge" title="Genesys points per copy">{points === 1 ? "1pt" : `${points} pts`}</span>}
      </span>
      {d.tier && <small className={`tier-badge tier-${c.tier}`}>{c.tier ? `Tier ${c.tier}${c.tier_src === "yours" ? "" : " (est.)"}` : " "}</small>}
      {d.kind && <small>{[c.kind, c.attribute, lv].filter(Boolean).join(" · ") || " "}</small>}
      {d.stat && <small>{c.atk !== null ? `ATK ${c.atk}` : ""}{c.defense !== null ? ` / DEF ${c.defense}` : ""}{c.atk === null && c.defense === null ? " " : ""}</small>}
      {d.ar && <small>{c.archetype || " "}</small>}
      {(d.date || d.qty) && <small>{d.date && (c.release_date || "no date")}{d.date && d.qty && " · "}{d.qty && `×${copies}`}</small>}
      {d.rel && <small className={`support support-${c.rel_status}`}>{relLabel(c) || " "}</small>}
      {d.tags && <small className="t-tags">{c.tags.join(" · ") || " "}</small>}
      {d.pop && <small>{c.views !== null ? `views ${c.views.toLocaleString()}` : " "}</small>}
      {d.dd && <small>{dd ? `deck file ${dd}` : " "}</small>}
    </button>
  );
});
const relLabel = (c: LibraryCard) =>
  c.rel_status === "generic" ? "Generic · playable anywhere" : c.rel_status === "unknown" ? "" : `${c.related} related · ${SUPPORT_LABEL[c.rel_status]}`;

const LIST_COLS: { key: string; label: string; show?: DisplayKey; w: number; get: (c: LibraryCard, copies: number) => string | number }[] = [
  { key: "name", label: "Name", w: 240, get: (c) => c.name },
  { key: "kind", label: "Kind", show: "kind", w: 90, get: (c) => c.kind || "" },
  { key: "attr", label: "Attr", show: "kind", w: 64, get: (c) => c.attribute || "" },
  { key: "lv", label: "Lv", show: "kind", w: 44, get: (c) => c.level ?? c.linkval ?? "" },
  { key: "atk", label: "ATK", show: "stat", w: 56, get: (c) => c.atk ?? "" },
  { key: "def", label: "DEF", show: "stat", w: 56, get: (c) => c.defense ?? "" },
  { key: "ar", label: "Archetype", show: "ar", w: 150, get: (c) => c.archetype || "" },
  { key: "tier", label: "Tier", show: "tier", w: 44, get: (c) => c.tier || "" },
  { key: "rel", label: "Related", show: "rel", w: 70, get: (c) => (c.rel_status === "generic" ? "generic" : c.rel_status === "unknown" ? "" : c.related) },
  { key: "tags", label: "Tags", show: "tags", w: 240, get: (c) => c.tags.join(", ") },
  { key: "pop", label: "Views", show: "pop", w: 80, get: (c) => c.views ?? "" },
  { key: "date", label: "Release", show: "date", w: 96, get: (c) => c.release_date || "" },
  { key: "dd", label: "Deck file", show: "dd", w: 96, get: (c) => Object.values(c.deck_dates).map((x) => x.modified).filter(Boolean).sort()[0] || "" },
  { key: "qty", label: "Qty", show: "qty", w: 44, get: (_c, n) => n },
  { key: "decks", label: "Decks", w: 360, get: (c) => c.decks.join(", ") },
];

// ----------------------------------------------------------------------------- page
type Row =
  | { type: "head"; key: string; count: number; copies: number; collapsed: boolean }
  | { type: "cards"; cards: LibraryCard[]; group: string | null };

export function LibraryPage() {
  const store = useDeckStore();
  const [decks, setDecks] = useState<Deck[] | null>(null);
  const [tags, setTagsState] = useState<CustomTags>({});
  const [catVersion, setCatVersion] = useState(-1);
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [prefs, setPrefs] = useState<UiPrefs>(loadPrefs);
  const [open, setOpen] = useState<LibraryCard | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lfName, setLfName] = useState(defaultLflistName);
  const [lfWhitelist, setLfWhitelist] = useState(true);
  const tagsFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage blocked */ }
  }, [prefs]);

  const loadController = useRef<AbortController | null>(null);
  const [format, setFormat] = useDeckFormat();
  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setError(null);
    try {
      const [ds, ts] = await Promise.all([store.list(), store.getTags()]);
      if (controller.signal.aborted) return;
      setTagsState(ts);
      setDecks(ds);
      const ids = ds.flatMap((d) => [...d.main, ...d.extra, ...d.side]);
      await ensureCards(ids, (done, total) => {
        if (controller.signal.aborted) return;
        setLoading(done < total ? { done, total } : null);
        setCatVersion(catalog.version);
      }, { signal: controller.signal, batchSize: 500 });
      if (controller.signal.aborted) return;
      setCatVersion(catalog.version);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) setLoading(null);
    }
  }, [store]);
  useEffect(() => { void load(); return () => loadController.current?.abort(); }, [load]);
  useEffect(() => {
    const on = () => void load();
    window.addEventListener("ygo:decks-changed", on);
    return () => window.removeEventListener("ygo:decks-changed", on);
  }, [load]);

  // ---- derivation (memoised: decks/catalogue -> base; + custom tags -> library)
  const base = useMemo(() => (decks && catVersion >= 0 ? deriveBase(decks, prefs.countMode, !loading) : []), [decks, catVersion, prefs.countMode, !!loading]);
  const library = useMemo(() => {
    const copy = base.map((c) => ({ ...c }));
    computeTags(copy, tags);
    computeTiers(copy);
    return copy;
  }, [base, tags]);
  const byId = useMemo(() => new Map(library.map((c) => [c.id, c])), [library]);
  const deckIds = useMemo(() => new Map((decks || []).map((d) => [d.name, d.id])), [decks]);

  // keep the open dialog in sync after tag edits
  useEffect(() => {
    setOpen((o) => (o ? byId.get(o.id) ?? null : o));
  }, [byId]);

  const options = useMemo(() => {
    const vals = (f: (c: LibraryCard) => (string | null)[]) => {
      const s = new Set<string>();
      for (const c of library) for (const v of f(c)) if (v) s.add(v);
      return [...s].sort((a, b) => a.localeCompare(b));
    };
    const tagCount = new Map<string, number>();
    for (const c of library) for (const t of c.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    return {
      category: vals((c) => [c.category]), kind: vals((c) => [c.kind]), attribute: vals((c) => [c.attribute]),
      archetype: vals((c) => [c.archetype]), deck: vals((c) => c.decks),
      tags: [...tagCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    };
  }, [library]);

  // ---- filter / sort / group
  const q = useDeferredValue(filters.q);
  const f = useDeferredValue(filters);
  const filtered = useMemo(() => {
    const inc = Object.keys(f.tagState).filter((t) => f.tagState[t] === 1);
    const exc = Object.keys(f.tagState).filter((t) => f.tagState[t] === 2);
    const tagSpecs = [
      ...(inc.length ? (f.tagMatch === "any" ? [inc.join("|")] : inc) : []),
      ...(exc.length ? ["!" + exc.join("|")] : []),
    ];
    const year = (v: string) => (/^\d{4}$/.test(v.trim()) ? v.trim() : null);
    const opts: FilterOptions = {
      query: q, text: true,
      category: f.category, kind: f.kind, attribute: f.attribute,
      archetype: f.archetype, archetypeExact: true, deck: f.deck, deckExact: true,
      support: (f.support || null) as FilterOptions["support"],
      tiers: f.tier ? (f.tier.split("") as Tier[]) : null,
      tag: tagSpecs,
      after: year(f.y1), before: year(f.y2),
      deckAfter: f.d1 || null, deckBefore: f.d2 || null,
    };
    return applyFilters(library, opts);
  }, [library, f, q]);

  const sortSpecs = useMemo<SortSpec[]>(() => {
    const out: SortSpec[] = [];
    for (const s of prefs.sort) {
      if (!s.key) continue;
      out.push({ key: s.key, desc: s.desc });
      if (s.key === "archetype-size") out.push({ key: "archetype" });
    }
    out.push({ key: "name" });
    return out;
  }, [prefs.sort]);
  const ctx = useMemo(() => ({ deckAfter: f.d1 || null, deckBefore: f.d2 || null }), [f.d1, f.d2]);
  const sorted = useMemo(() => sortCards(filtered, sortSpecs, ctx), [filtered, sortSpecs, ctx]);
  const groups = useMemo(() => (prefs.group ? groupCards(sorted, prefs.group, prefs.groupOrder, ctx) : null), [sorted, prefs.group, prefs.groupOrder, ctx]);
  const totalCopies = useMemo(() => sorted.reduce((s, c) => s + c.copies, 0), [sorted]);

  // ---- layout measurement (grid columns + row heights)
  const wrapRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [tileH, setTileH] = useState(0);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [decks]);
  const GAP = 10;
  const minTile = width < 500 ? 140 : 160;
  const cols = Math.max(2, Math.floor((width + GAP) / (minTile + GAP)));
  const tileW = width ? (width - GAP * (cols - 1)) / cols : minTile;
  useLayoutEffect(() => {
    const el = probeRef.current;
    if (!el) return;
    setTileH(el.offsetHeight);
    const ro = new ResizeObserver(() => setTileH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [tileW, prefs.display, prefs.view, library.length, format]);

  const isGrid = prefs.view === "grid";
  const rowH = isGrid ? (tileH || 300) + GAP : 34;
  const HEAD_H = 44;

  const rows = useMemo<Row[]>(() => {
    const perRow = isGrid ? cols : 1;
    const chunk = (cards: LibraryCard[], group: string | null, out: Row[]) => {
      for (let i = 0; i < cards.length; i += perRow) out.push({ type: "cards", cards: cards.slice(i, i + perRow), group });
    };
    const out: Row[] = [];
    if (!groups) chunk(sorted, null, out);
    else for (const g of groups) {
      const isCollapsed = collapsed.has(g.key);
      out.push({ type: "head", key: g.key, count: g.cards.length, copies: g.copies, collapsed: isCollapsed });
      if (!isCollapsed) chunk(g.cards, prefs.group === "deck" ? g.key : null, out);
    }
    return out;
  }, [groups, sorted, cols, isGrid, collapsed, prefs.group]);
  const heightOf = useCallback((i: number) => (rows[i].type === "head" ? HEAD_H : rowH), [rows, rowH]);

  const openCard = useCallback((c: LibraryCard) => setOpen(c), []);
  const pointColumn: (typeof LIST_COLS)[number] = { key: "points", label: "Points", w: 80, get: (c: LibraryCard) => { const points = genesysPoints(c); return points !== null && points > 0 ? points : ""; } };
  const listCols = [...(format === "genesys" ? [pointColumn] : []), ...LIST_COLS].filter((c) => !c.show || prefs.display[c.show]);
  const listTemplate = listCols.map((c) => `${c.w}px`).join(" ");
  const listWidth = listCols.reduce((s, c) => s + c.w, 0);

  const renderRow = useCallback((i: number) => {
    const r = rows[i];
    if (r.type === "head") {
      return (
        <button type="button" className="lib-group-head" aria-expanded={!r.collapsed}
          onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })}>
          <span className="chev">{r.collapsed ? "▸" : "▾"}</span> {r.key}{" "}
          <span className="muted">({r.count} card{r.count === 1 ? "" : "s"} · {r.copies} copies)</span>
        </button>
      );
    }
    const copies = (c: LibraryCard) => (r.group ? c.deck_counts[r.group] ?? c.copies : c.copies);
    if (isGrid) {
      return (
        <div className="lib-grid-row" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: GAP }}>
          {r.cards.map((c) => <Tile genesys={format === "genesys"} key={c.id} card={c} copies={copies(c)} display={prefs.display} onOpen={openCard} />)}
        </div>
      );
    }
    const c = r.cards[0];
    const points = genesysPoints(c);
    return (
      <div className="lib-list-row" role="row" tabIndex={0} style={{ gridTemplateColumns: listTemplate, width: listWidth }}
        onClick={() => openCard(c)} onKeyDown={(e) => { if (e.key === "Enter") openCard(c); }} {...previewHandlers(c)}>
        {listCols.map((col) => (
          <span key={col.key} role="cell" className={col.key === "tier" ? `tier-badge tier-${c.tier}` : col.key === "rel" ? `support support-${c.rel_status}` : undefined}>
            {col.key === "points" && points !== null && points > 0 ? <span className="lib-point-badge" title="Genesys points per copy">{points === 1 ? "1pt" : `${points} pts`}</span> : String(col.get(c, copies(c)))}
          </span>
        ))}
      </div>
    );
  }, [rows, isGrid, cols, prefs.display, openCard, listCols, listTemplate, listWidth, format]);

  // ---- tag editing
  const saveTags = async (next: CustomTags, msg?: string) => {
    setTagsState(next);
    try {
      await store.setTags(next);
      if (msg) setNotice(msg);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };
  const clone = (t: CustomTags) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, [...v]]));
  const onAddTag = (c: LibraryCard, t: string) => saveTags(addTag(clone(tags), c.name, t));
  const onRemoveTag = (c: LibraryCard, t: string) => saveTags(removeTag(clone(tags), c.name, t));
  const onSetTier = (c: LibraryCard, tier: string | null) => {
    const next = clone(tags);
    for (const t of next[c.name.toLowerCase()] ?? []) if (t.toLowerCase().startsWith("tier:")) removeTag(next, c.name, t);
    if (tier) addTag(next, c.name, `tier:${tier}`);
    void saveTags(next);
  };
  const onImportTags = async (file: File | undefined) => {
    if (!file) return;
    const { tags: next, added } = importTagsCsv(await file.text(), tags);
    await saveTags(next, `Imported ${added} tag(s) from ${file.name}.`);
    if (tagsFileRef.current) tagsFileRef.current.value = "";
  };

  const setF = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((x) => ({ ...x, [k]: v }));
  const setSort = (i: number, patch: Partial<UiPrefs["sort"][number]>) =>
    setPrefs((p) => ({ ...p, sort: p.sort.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const cycleTag = (t: string) =>
    setFilters((x) => {
      const st = { ...x.tagState };
      const n = ((st[t] ?? 0) + 1) % 3;
      if (n) st[t] = n as 1 | 2;
      else delete st[t];
      return { ...x, tagState: st };
    });
  const activeFilterCount = ["category", "kind", "attribute", "archetype", "deck", "support", "tier", "y1", "y2", "d1", "d2"]
    .filter((k) => filters[k as keyof Filters]).length + Object.keys(filters.tagState).length;
  const stamp = () => new Date().toISOString().slice(0, 10);

  // ---- render
  if (error) {
    return (
      <section className="library">
        <h1>Library</h1>
        <p className="lib-error" role="alert">Could not load the library: {error}</p>
        <button type="button" onClick={() => void load()}>Retry</button>
      </section>
    );
  }
  if (!decks) {
    return (
      <section className="library">
        <h1>Library</h1>
        <p className="muted" role="status">
          {loading ? `Loading card data… ${loading.done.toLocaleString()} / ${loading.total.toLocaleString()} ids` : "Loading…"}
        </p>
        {loading && <progress max={loading.total} value={loading.done} />}
      </section>
    );
  }
  if (decks.length === 0) {
    return (
      <section className="library">
        <h1>Library</h1>
        <div className="lib-empty">
          <p>Your library is built from your decks. Import your <code>.ydk</code> files (EDOPro, YGOPro, YGOPRODeck…) or a whole folder of them to get started.</p>
          <ImportDecks onImported={(_d, s) => { setNotice(summaryText(s)); void load(); }} />
        </div>
      </section>
    );
  }

  const sample = library[0];
  return (
    <section className="library">
      {loading && <div role="status">Loading card data… {loading.done.toLocaleString()} / {loading.total.toLocaleString()} ids <progress max={loading.total} value={loading.done} /></div>}
      <div className="lib-head">
        <h1>Library <span className="muted lib-sub">· {library.length.toLocaleString()} cards from {decks.length} deck{decks.length === 1 ? "" : "s"}</span></h1>
        <details className="lib-menu">
          <summary>Import / export</summary>
          <div className="lib-menu-body">
            <ImportDecks compact onImported={(_d, s) => { setNotice(summaryText(s)); void load(); }} />
            <div className="lib-menu-group">
              <b>Export {sorted.length.toLocaleString()} shown cards</b>
              <div className="row">
                <button type="button" onClick={() => downloadText(`ygo_library_${stamp()}.csv`, toCsv(sorted), "text/csv;charset=utf-8")}>CSV</button>
                <button type="button" onClick={() => downloadText(`ygo_library_${stamp()}.json`, toJson(sorted), "application/json")}>JSON</button>
              </div>
              <div className="row">
                <input value={lfName} onChange={(e) => setLfName(e.target.value)} aria-label="lflist name" className="grow" />
                <label className="check"><input type="checkbox" checked={lfWhitelist} onChange={(e) => setLfWhitelist(e.target.checked)} /> whitelist</label>
                <button type="button" onClick={() => downloadText("lflist.conf", toLflist(sorted, { name: lfName, whitelist: lfWhitelist }))}>lflist.conf</button>
              </div>
            </div>
            <div className="lib-menu-group">
              <b>Custom tags</b> <span className="muted">CSV columns: name, tier, tags (separated by ; or |)</span>
              <div className="row">
                <button type="button" onClick={() => tagsFileRef.current?.click()}>Import tags CSV</button>
                <button type="button" disabled={!Object.keys(tags).length}
                  onClick={() => downloadText("ygo_tags.csv", exportTagsCsv(tags, (k) => library.find((c) => c.name.toLowerCase() === k)?.name ?? k), "text/csv;charset=utf-8")}>
                  Export tags CSV
                </button>
                <input ref={tagsFileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => void onImportTags(e.target.files?.[0])} />
              </div>
            </div>
          </div>
        </details>
      </div>
      {notice && <p className="lib-notice" role="status">{notice} <button type="button" className="linklike" onClick={() => setNotice(null)}>dismiss</button></p>}

      <div className="lib-toolbar">
        <div className="row">
          <input type="search" className="lib-q" placeholder="Search name, archetype or card text…" value={filters.q}
            onChange={(e) => setF("q", e.target.value)} aria-label="Search" />
          <button type="button" className="lib-filters-toggle" aria-expanded={showFilters} onClick={() => setShowFilters((s) => !s)}>
            Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
          </button>
        </div>
        <div className={`lib-filters${showFilters ? " open" : ""}`}>
          <div className="row">
            <Select label="Category" value={filters.category} onChange={(v) => setF("category", v)} options={options.category} />
            <Select label="Kind" value={filters.kind} onChange={(v) => setF("kind", v)} options={options.kind} />
            <Select label="Attribute" value={filters.attribute} onChange={(v) => setF("attribute", v)} options={options.attribute} />
            <Select label="Archetype" value={filters.archetype} onChange={(v) => setF("archetype", v)} options={options.archetype} />
            <Select label="Deck" value={filters.deck} onChange={(v) => setF("deck", v)} options={options.deck} />
            <select value={filters.support} onChange={(e) => setF("support", e.target.value)} aria-label="Support level">
              <option value="">Any support</option>
              <option value="generic">Generic (playable anywhere)</option>
              <option value="good">Well supported (4+)</option>
              <option value="thin">Few companions (1-3)</option>
              <option value="none">No companions</option>
            </select>
            <select value={filters.tier} onChange={(e) => setF("tier", e.target.value)} aria-label="Tier">
              <option value="">Any tier</option>
              {["S", "A", "B", "C", "D"].map((t) => <option key={t} value={t}>Tier {t}</option>)}
              <option value="SA">S or A</option>
              <option value="SAB">S, A or B</option>
            </select>
          </div>
          <div className="row lib-chips-row">
            <div className="lib-tag-controls">
              <FormatSelector format={format} onChange={setFormat} />
              <select value={filters.tagMatch} onChange={(e) => setF("tagMatch", e.target.value as "all" | "any")} aria-label="Tag match mode">
                <option value="all">tags: match all</option>
                <option value="any">tags: match any</option>
              </select>
            </div>
            <div className="lib-chips">
              {options.tags.map(([t, n]) => {
                const st = filters.tagState[t];
                return (
                  <button key={t} type="button" className={`chip${st === 1 ? " inc" : st === 2 ? " exc" : ""}`} aria-pressed={!!st}
                    title={`${TAG_HELP[t] ? TAG_HELP[t] + " — " : ""}click: include, again: exclude, again: off`} onClick={() => cycleTag(t)}>
                    {st === 2 ? "not " : ""}{t} <span className="chip-n">{n}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="row">
            <label className="lbl">Release year</label>
            <input className="num" type="number" inputMode="numeric" placeholder="from" value={filters.y1} onChange={(e) => setF("y1", e.target.value)} aria-label="Release year from" />
            <input className="num" type="number" inputMode="numeric" placeholder="to" value={filters.y2} onChange={(e) => setF("y2", e.target.value)} aria-label="Release year to" />
            <label className="lbl">Deck file date</label>
            <input type="date" value={filters.d1} onChange={(e) => setF("d1", e.target.value)} aria-label="Deck file date from" />
            <input type="date" value={filters.d2} onChange={(e) => setF("d2", e.target.value)} aria-label="Deck file date to" />
            <button type="button" onClick={() => { setFilters(EMPTY_FILTERS); setPrefs((p) => ({ ...p, sort: DEFAULT_PREFS.sort, groupOrder: "count" })); }}>Reset</button>
          </div>
          <div className="row">
            <label className="lbl">Sort</label>
            {prefs.sort.map((s, i) => (
              <span key={i} className="sort-pair">
                <select value={s.key} onChange={(e) => setSort(i, { key: e.target.value as SortKey | "" })} aria-label={`Sort level ${i + 1}`}>
                  <option value="">{i === 0 ? "sort by…" : "then by…"}</option>
                  {SORT_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <select value={s.desc ? "d" : "a"} onChange={(e) => setSort(i, { desc: e.target.value === "d" })} aria-label={`Sort level ${i + 1} direction`}>
                  <option value="a">asc</option>
                  <option value="d">desc</option>
                </select>
              </span>
            ))}
          </div>
          <div className="row">
            <label className="lbl">Group</label>
            <select value={prefs.group} onChange={(e) => { setCollapsed(new Set()); setPrefs((p) => ({ ...p, group: e.target.value as GroupKey | "" })); }} aria-label="Group by">
              {GROUP_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <select value={prefs.groupOrder} onChange={(e) => setPrefs((p) => ({ ...p, groupOrder: e.target.value as "count" | "name" }))} aria-label="Group order" disabled={!prefs.group}>
              <option value="count">biggest group first</option>
              <option value="name">by name</option>
            </select>
            <select value={prefs.countMode} onChange={(e) => setPrefs((p) => ({ ...p, countMode: e.target.value as CountMode }))} aria-label="Copy counting">
              <option value="sum">copies: total across decks</option>
              <option value="max">copies: most in one deck</option>
            </select>
            <details className="lib-display">
              <summary>Display options</summary>
              <div className="lib-display-body">
                {DISPLAY.map(([k, label]) => (
                  <label key={k} className="check">
                    <input type="checkbox" checked={prefs.display[k]} onChange={(e) => setPrefs((p) => ({ ...p, display: { ...p.display, [k]: e.target.checked } }))} /> {label}
                  </label>
                ))}
              </div>
            </details>
          </div>
        </div>
        <div className="row lib-status">
          <div className="seg" role="group" aria-label="View">
            <button type="button" className={isGrid ? "on" : ""} aria-pressed={isGrid} onClick={() => setPrefs((p) => ({ ...p, view: "grid" }))}>Grid</button>
            <button type="button" className={!isGrid ? "on" : ""} aria-pressed={!isGrid} onClick={() => setPrefs((p) => ({ ...p, view: "list" }))}>List</button>
          </div>
          <span className="muted lib-count" aria-live="polite">
            {sorted.length.toLocaleString()} of {library.length.toLocaleString()} cards · {totalCopies.toLocaleString()} copies
            {groups ? ` · ${groups.length} groups` : ""}
          </span>
        </div>
      </div>

      <div ref={wrapRef} className={`lib-results${isGrid ? "" : " list"}`}>
        {sample && isGrid && (
          <div className="lib-probe" aria-hidden="true" style={{ width: tileW }} ref={probeRef}>
            <Tile genesys={format === "genesys"} card={sample} copies={1} display={prefs.display} onOpen={() => {}} />
          </div>
        )}
        {sorted.length === 0 ? (
          <p className="muted">No cards match.</p>
        ) : isGrid ? (
          <VirtualRows count={rows.length} heightOf={heightOf} render={renderRow} />
        ) : (
          <div className="lib-list-scroll">
            <div className="lib-list-head" style={{ gridTemplateColumns: listTemplate, width: listWidth }} role="row">
              {listCols.map((c) => <span key={c.key} role="columnheader">{c.label}</span>)}
            </div>
            <VirtualRows count={rows.length} heightOf={heightOf} render={renderRow} className="lib-list-body" />
          </div>
        )}
      </div>

      <CardPreviewLayer />
      <CardDialog
        card={open} byId={byId} library={library} deckIds={deckIds} customTags={tags}
        allTags={options.tags.map(([t]) => t)}
        onOpen={setOpen} onClose={() => setOpen(null)}
        onAddTag={onAddTag} onRemoveTag={onRemoveTag} onSetTier={onSetTier}
      />
    </section>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={value ? "set" : ""}>
      <option value="">{label}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
